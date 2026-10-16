// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import type { CommandFailure, CommandResult } from "./commandRunner";

export class PreflightInterrupted extends Error {
  constructor(readonly failure: CommandFailure) {
    super(failure.message);
  }

  result(): CommandResult {
    return {
      success: false,
      cancelled: this.failure.kind === "cancelled",
      status: null,
      output: "",
      stdout: "",
      stderr: "",
      failure: this.failure
    };
  }
}

/** One existing command budget, including resolution/configuration/setup.
 * Kernel filesystem work cannot always be interrupted; its eventual result is
 * consumed and never resumes the command. Resource-producing stages must also
 * supply an eventual disposer. No timeout is introduced when timeoutMs is zero. */
export class CommandPreflight {
  private readonly stop = new AbortController();
  private readonly deadline?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private interruption?: PreflightInterrupted;
  private readonly onAbort = () => this.interrupt("cancelled");

  constructor(
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)
      throw new RangeError("Invalid command deadline.");
    if (timeoutMs) {
      this.deadline = performance.now() + timeoutMs;
      this.timer = setTimeout(() => this.interrupt("timeout"), timeoutMs);
    }
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  private interrupt(kind: "cancelled" | "timeout"): void {
    if (this.interruption) return;
    this.interruption = new PreflightInterrupted({
      kind,
      message:
        kind === "cancelled"
          ? "Command cancelled before launch."
          : `Command exceeded its ${this.timeoutMs} ms deadline.`
    });
    this.stop.abort();
  }

  get cancellationSignal(): AbortSignal {
    return this.stop.signal;
  }

  remainingMs(): number {
    if (this.deadline !== undefined && performance.now() >= this.deadline)
      this.interrupt("timeout");
    if (this.interruption) throw this.interruption;
    return this.deadline === undefined
      ? 0
      : Math.max(1, Math.ceil(this.deadline - performance.now()));
  }

  async run<T>(
    work: () => Promise<T>,
    late?: { dispose(value: T): Promise<void>; failed(): void }
  ): Promise<T> {
    this.remainingMs();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const aborted = () => {
        if (settled) return;
        settled = true;
        this.stop.signal.removeEventListener("abort", aborted);
        reject(this.interruption);
      };
      this.stop.signal.addEventListener("abort", aborted, { once: true });
      // Invoke only after admission, and consume both late success and rejection.
      void Promise.resolve()
        .then(() => {
          this.remainingMs();
          return work();
        })
        .then(
          (value) => {
            if (!settled) {
              try {
                this.remainingMs();
              } catch {
                aborted();
              }
            }
            this.stop.signal.removeEventListener("abort", aborted);
            if (settled) {
              if (late)
                void Promise.resolve()
                  .then(() => late.dispose(value))
                  .catch(late.failed);
              return;
            }
            settled = true;
            resolve(value);
          },
          (error) => {
            this.stop.signal.removeEventListener("abort", aborted);
            if (!settled) {
              settled = true;
              reject(error);
            }
          }
        );
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.onAbort);
  }
}
