// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

/** Owns refresh generations, cleanup replay and the lightweight refresh timer. */
export class RefreshLifecycle<Options> {
  private refreshTask?: Promise<void>;
  private cleanupRefreshTask?: Promise<void>;
  private cleanupRefreshRequested = false;
  private sequence = 0;
  private controller?: AbortController;
  private autoRefreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly compute: (
      lightweight: boolean,
      sequence: number,
      options: Options,
      signal: AbortSignal
    ) => Promise<void>,
    private readonly autoRefresh: () => void
  ) {}

  isCurrent(sequence: number): boolean {
    return sequence === this.sequence;
  }

  get isRefreshActive(): boolean {
    return Boolean(this.refreshTask);
  }

  get wasRefreshRequestedDuringCleanup(): boolean {
    return this.cleanupRefreshRequested;
  }

  async refresh(lightweight: boolean, options: Options): Promise<void> {
    if (this.cleanupRefreshTask) {
      this.cleanupRefreshRequested = true;
      await this.cleanupRefreshTask;
      if (lightweight) return;
      // A mutation after cleanup's scan began still needs its own full scan.
      return this.refresh(false, options);
    }
    if (this.refreshTask && lightweight) {
      return this.waitForRefreshCompletion(this.refreshTask);
    }
    const { sequence, controller } = this.nextGeneration();
    const task = this.compute(lightweight, sequence, options, controller.signal).finally(() => {
      if (this.refreshTask === task) {
        this.refreshTask = undefined;
        this.controller = undefined;
      }
    });
    this.refreshTask = task;
    return this.waitForRefreshCompletion(task);
  }

  beginCleanup(): { refreshWasActive: boolean; finish: () => void } {
    const refreshWasActive = Boolean(this.refreshTask);
    this.cleanupRefreshRequested = false;
    let finish!: () => void;
    this.cleanupRefreshTask = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      refreshWasActive,
      finish: () => {
        this.cleanupRefreshTask = undefined;
        finish();
      }
    };
  }

  async runCleanupGeneration<T>(
    compute: (sequence: number, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    // Cleanup owns a generation so obsolete provider lookups cannot replace its inventory commit.
    const { sequence, controller } = this.nextGeneration();
    try {
      return await compute(sequence, controller.signal);
    } finally {
      if (this.controller === controller) {
        this.refreshTask = undefined;
        this.controller = undefined;
      }
    }
  }

  restartAutoRefreshLoop(enabled: boolean, intervalMinutes: number): void {
    if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
    if (!enabled) return;
    this.autoRefreshTimer = setInterval(this.autoRefresh, intervalMinutes * 60 * 1000);
  }

  stop(): void {
    if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
    ++this.sequence;
    this.controller?.abort();
  }

  private nextGeneration(): { sequence: number; controller: AbortController } {
    const sequence = ++this.sequence;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    return { sequence, controller };
  }

  private async waitForRefreshCompletion(task: Promise<void>): Promise<void> {
    // Superseded callers observe the winning scan's commit, not just their aborted generation.
    for (;;) {
      try {
        await task;
      } catch (error) {
        if (!this.refreshTask || this.refreshTask === task) throw error;
      }
      if (this.cleanupRefreshTask) await this.cleanupRefreshTask;
      const next = this.refreshTask;
      if (!next || next === task) return;
      task = next;
    }
  }
}
