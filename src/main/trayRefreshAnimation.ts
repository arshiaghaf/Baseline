// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

export const trayRefreshFrameCount = 60;
export const trayRefreshFrameIntervalMs = 1000 / 15;

// Own one timer per visible tray. Snapshot/progress updates must not restart
// the rotation, and disposing a tray must prevent callbacks into its successor.
export class TrayRefreshAnimation {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private reducedMotion = false;
  private startedAt = 0;
  private disposed = false;

  constructor(private readonly render: (frame: number | undefined) => void) {}

  update(refreshing: boolean, reducedMotion: boolean): void {
    if (this.disposed) return;
    const changed = refreshing !== this.refreshing || reducedMotion !== this.reducedMotion;
    this.refreshing = refreshing;
    this.reducedMotion = reducedMotion;
    if (!changed) return;

    this.stopTimer();
    this.render(refreshing ? 0 : undefined);
    if (refreshing && !reducedMotion) {
      this.startedAt = performance.now();
      this.scheduleNextFrame();
    }
  }

  dispose(): void {
    this.stopTimer();
    this.disposed = true;
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleNextFrame(): void {
    if (this.disposed || !this.refreshing || this.reducedMotion) return;
    const elapsed = performance.now() - this.startedAt;
    const nextFrame = Math.floor(elapsed / trayRefreshFrameIntervalMs) + 1;
    this.timer = setTimeout(
      () => {
        if (this.disposed || !this.refreshing || this.reducedMotion) return;
        // Follow monotonic elapsed time, skipping obsolete frames after a busy
        // event loop instead of slowing the rotation or replaying a burst.
        const frame = Math.floor((performance.now() - this.startedAt) / trayRefreshFrameIntervalMs);
        this.render(frame % trayRefreshFrameCount);
        this.scheduleNextFrame();
      },
      Math.max(1, Math.ceil(nextFrame * trayRefreshFrameIntervalMs - elapsed))
    );
    this.timer.unref?.();
  }
}
