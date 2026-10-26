// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

/** Independent of app scanning and the user's app auto-refresh preference. */
export class SelfUpdateScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private lastAttempt = -Infinity;
  private disposed = false;
  constructor(
    private readonly check: () => Promise<unknown>,
    private readonly now = () => performance.now()
  ) {}
  start(): void {
    if (this.timer || this.disposed) return;
    this.request(true);
    this.timer = setInterval(() => this.request(true), 60 * 60 * 1000);
    this.timer.unref();
  }
  request(force = false): void {
    if (this.disposed || (!force && this.now() - this.lastAttempt < 5 * 60 * 1000)) return;
    this.lastAttempt = this.now();
    void this.check().catch(() => undefined);
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
  }
}
