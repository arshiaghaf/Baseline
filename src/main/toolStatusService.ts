// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { runBrewCommand, runMasCommand, type CommandResult } from "./commandRunner";

export type ToolStatusPatch = {
  isChecking?: boolean;
  isHomebrewInstalled?: boolean;
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
    this.task = task;
    const release = this.options.reserveHomebrewCommandLock();
    try {
      this.options.patch({ isChecking: true });
    } catch (error) {
      release?.();
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
    const brew: Promise<CommandResult | undefined> = release
      ? Promise.resolve()
          .then(() => this.options.runBrewCommand(["--version"]))
          .finally(release)
      : Promise.resolve(undefined);
    const [brewResult, masResult] = await Promise.allSettled([brew, mas]);
    const status: ToolStatusPatch = {};
    try {
      if (brewResult.status === "fulfilled" && brewResult.value) {
        this.options.markHomebrewAvailabilityChecked();
        status.isHomebrewInstalled = brewResult.value.success;
      }
      if (masResult.status === "fulfilled") {
        status.isMasInstalled = masResult.value.success;
      }
      if (brewResult.status === "rejected") throw brewResult.reason;
      if (masResult.status === "rejected") throw masResult.reason;
    } finally {
      this.options.patch({ ...status, isChecking: false });
    }
  }
}
