// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { runBrewCommand, runMasCommand, type CommandResult } from "./commandRunner";
import type { HomebrewConfigurationReason } from "../shared/domain";

export type ToolStatusPatch = {
  isChecking?: boolean;
  isHomebrewInstalled?: boolean;
  homebrewConfigurationBlocked?: boolean;
  homebrewConfigurationReason?: HomebrewConfigurationReason;
  isMasInstalled?: boolean;
};

export class ToolStatusService {
  private task?: Promise<void>;

  constructor(
    private readonly options: {
      patch: (patch: ToolStatusPatch) => void;
      reserveHomebrewCommandLock: () => (() => void) | undefined;
      runBrewCommand: typeof runBrewCommand;
      runMasCommand: typeof runMasCommand;
      markHomebrewAvailabilityChecked: () => void;
    }
  ) {}

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
    const mas = Promise.resolve().then(() => this.options.runMasCommand(["version"]));
    // Release Homebrew as soon as its own probe settles, even if mas is still pending.
    let releaseFailure: { reason: unknown } | undefined;
    const brew: Promise<CommandResult | undefined> = release
      ? Promise.resolve()
          .then(() => this.options.runBrewCommand(["--version"]))
          .then((result) => {
            // Publish while this probe still owns the Homebrew reservation.
            // Waiting for mas could overwrite a newer inventory recovery.
            this.options.markHomebrewAvailabilityChecked();
            const homebrewConfigurationBlocked = result.failure?.kind === "configuration-blocked";
            this.options.patch({
              homebrewConfigurationBlocked,
              homebrewConfigurationReason: homebrewConfigurationBlocked
                ? result.failure?.configurationReason
                : undefined,
              isHomebrewInstalled: homebrewConfigurationBlocked || result.success
            });
            return result;
          })
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
      if (masResult.status === "fulfilled") {
        status.isMasInstalled = masResult.value.success;
      }
      if (releaseFailure) throw releaseFailure.reason;
      if (brewResult.status === "rejected") throw brewResult.reason;
      if (masResult.status === "rejected") throw masResult.reason;
    } finally {
      this.options.patch({ ...status, isChecking: false });
    }
  }
}
