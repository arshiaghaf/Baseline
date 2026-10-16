// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

/** Starts only when cleanup starts, never while a command/password is running.
 * All teardown stages share the existing budget. A timed-out task remains
 * observed; its owner must retain resources until eventual disposal completes. */
export class CommandCleanup {
  private expires?: number;
  constructor(private readonly timeoutMs: number) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
      throw new RangeError("Invalid command cleanup budget.");
  }

  get deadline(): number {
    return (this.expires ??= performance.now() + this.timeoutMs);
  }

  async wait<T>(task: Promise<T>): Promise<T> {
    const remaining = this.deadline - performance.now();
    // Consume eventual rejection even if the shared budget is already exhausted.
    void task.catch(() => undefined);
    if (remaining <= 0) throw new Error("Command cleanup could not be confirmed.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Command cleanup could not be confirmed.")),
            remaining
          );
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
