// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { runBrewCommand, runMasCommand, type CommandResult } from "./commandRunner";
import type { HomebrewConfigurationReason, RefreshState, ToolStatus } from "../shared/domain";

export type ToolStatusPatch = {
  isChecking?: boolean;
  isHomebrewInstalled?: boolean;
  homebrewCheckStatus?: RefreshState["homebrewCheckStatus"];
  homebrewConfigurationBlocked?: boolean;
  homebrewConfigurationReason?: HomebrewConfigurationReason;
  isMasInstalled?: boolean;
  masAvailability?: ToolStatus["masAvailability"];
};

export class ToolStatusService {
  private task?: Promise<void>;
  private masEvidenceGeneration = 0;

  constructor(
    private readonly options: {
      patch: (patch: ToolStatusPatch) => void;
      reserveHomebrewCommandLock: () => (() => void) | undefined;
      runBrewCommand: typeof runBrewCommand;
      runMasCommand: typeof runMasCommand;
      markHomebrewAvailabilityChecked: () => void;
    }
  ) {}

  beginMasCommand(): void {
    // A probe started before admission must not publish over command evidence.
    this.masEvidenceGeneration++;
  }

  recordMasCommandResult(result: CommandResult): void {
    // Also supersede probes started while this command was running.
    this.masEvidenceGeneration++;
    this.options.patch(masStatus(result));
  }

  check(): Promise<void> {
    if (this.task) return this.task;

    // Register the task before publishing; snapshot listeners may request another check.
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const task = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // A snapshot listener may request a check and discard the returned promise.
    void task.catch(() => undefined);
    this.task = task;
    let release: (() => void) | undefined;
    let checkingPublicationAttempted = false;
    try {
      release = this.options.reserveHomebrewCommandLock();
      checkingPublicationAttempted = true;
      this.options.patch({ isChecking: true });
    } catch (error) {
      // Keep the initiating error while attempting both cleanup callbacks.
      try {
        release?.();
      } catch {
        // The lock owns rollback and idempotent release.
      }
      if (checkingPublicationAttempted) {
        try {
          this.options.patch({ isChecking: false });
        } catch {
          // A second publication failure must not strand the registered task.
        }
      }
      this.task = undefined;
      reject(error);
      return task;
    }

    void this.runProbes(release).then(
      () => {
        this.task = undefined;
        resolve();
      },
      (error: unknown) => {
        this.task = undefined;
        reject(error);
      }
    );
    return task;
  }

  private async runProbes(release: (() => void) | undefined): Promise<void> {
    const masGeneration = this.masEvidenceGeneration;
    const mas = Promise.resolve().then(() => this.options.runMasCommand(["version"]));
    // Release Homebrew as soon as its own probe settles, even if mas is still pending.
    let releaseFailure: { reason: unknown } | undefined;
    const brew: Promise<CommandResult | undefined> = release
      ? Promise.resolve()
          .then(() => this.options.runBrewCommand(["--version"]))
          .then(
            (result) => {
              // Publish while this probe still owns the Homebrew reservation.
              // Waiting for mas could overwrite a newer inventory recovery.
              this.options.markHomebrewAvailabilityChecked();
              const homebrewConfigurationBlocked = result.failure?.kind === "configuration-blocked";
              const missing = result.failure?.kind === "spawn" && result.failure.code === "ENOENT";
              this.options.patch({
                homebrewConfigurationBlocked,
                homebrewConfigurationReason: homebrewConfigurationBlocked
                  ? result.failure?.configurationReason
                  : undefined,
                isHomebrewInstalled: homebrewConfigurationBlocked || result.success,
                ...(!result.success && !missing
                  ? { homebrewCheckStatus: "incomplete" as const }
                  : {})
              });
              return result;
            },
            (error: unknown) => {
              this.options.patch({ homebrewCheckStatus: "incomplete" });
              throw error;
            }
          )
          .finally(() => {
            try {
              release();
            } catch (error) {
              releaseFailure = { reason: error };
            }
          })
      : Promise.resolve(undefined);
    const [brewResult, masResult] = await Promise.allSettled([brew, mas]);
    const status: ToolStatusPatch = {};
    try {
      if (masResult.status === "fulfilled" && masGeneration === this.masEvidenceGeneration) {
        Object.assign(status, masStatus(masResult.value));
      }
      if (releaseFailure) throw releaseFailure.reason;
      if (brewResult.status === "rejected") throw brewResult.reason;
      if (masResult.status === "rejected") throw masResult.reason;
    } finally {
      this.options.patch({ ...status, isChecking: false });
    }
  }
}

function masStatus(result: CommandResult): ToolStatusPatch {
  const missing = result.failure?.kind === "spawn" && result.failure.code === "ENOENT";
  return {
    // An inconclusive failure must not disable controls for a detected helper.
    ...(result.success || missing ? { isMasInstalled: result.success } : {}),
    masAvailability: result.success ? "available" : missing ? "missing" : "unknown"
  };
}
