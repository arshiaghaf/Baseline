// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { SnapshotProgress, SnapshotProgressEvent } from "../shared/domain";

export class ProgressPublisher {
  private pending?: { revision: number; patch: Partial<SnapshotProgress> };
  private timer?: NodeJS.Timeout;
  private lastRevision = 0;

  constructor(private readonly emit: (event: SnapshotProgressEvent) => void) {}

  publish(patch: Partial<SnapshotProgress>, revision: number, terminal: boolean): void {
    this.pending = { revision, patch: { ...this.pending?.patch, ...patch } };
    if (terminal) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 100);
      this.timer.unref?.();
    }
  }

  // A full snapshot already carries the latest progress, so queued deltas
  // must not arrive afterwards and overwrite its terminal state.
  reset(revision: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.lastRevision = revision;
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending) return;
    const { revision, patch } = this.pending;
    this.pending = undefined;
    this.emit({ fromRevision: this.lastRevision, revision, patch: structuredClone(patch) });
    this.lastRevision = revision;
  }
}
