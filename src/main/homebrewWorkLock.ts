// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

type InventoryTask<Inventory> = {
  updateMetadata: boolean;
  task: Promise<Inventory>;
};

export type HomebrewWorkLockCallbacks = {
  // UI operation flags are kept by the caller; reservations live here.
  hasOtherMutation(): boolean;
  onLockStateChange(): void;
  onCommandReleased(): void;
};

export type HomebrewInventoryRead<Inventory> = {
  updateMetadata: boolean;
  allowDuringMutation: boolean;
  blocked(): Inventory;
  start(updateMetadata: boolean): Promise<Inventory>;
  reconcileBeforeRelease(result: Inventory): void;
  invalidateBeforeRelease(): void;
};

// Owns the Homebrew command, inventory, and refresh-generation reservations.
// Callers retain refresh orchestration and inventory reconciliation policy.
export class HomebrewWorkLock<Inventory> {
  private commandCount = 0;
  private inventoryCount = 0;
  private refreshSequence?: number;
  private activeInventoryTask?: InventoryTask<Inventory>;

  constructor(private readonly callbacks: HomebrewWorkLockCallbacks) {}

  get activeCommandCount(): number {
    return this.commandCount;
  }

  get isMutationActive(): boolean {
    return this.commandCount > 0 || this.callbacks.hasOtherMutation();
  }

  get isCommandActive(): boolean {
    return this.isMutationActive || this.inventoryCount > 0 || this.refreshSequence !== undefined;
  }

  get isCommandLocked(): boolean {
    return this.commandCount > 0 || this.inventoryCount > 0 || this.refreshSequence !== undefined;
  }

  get isCleanupLocked(): boolean {
    return this.isMutationActive || this.inventoryCount > 0;
  }

  reserveCommand(options: { allowRefreshSupersession?: boolean } = {}): (() => void) | undefined {
    // Cleanup may supersede a refresh's provider work, but never a mutation or
    // an active inventory read.
    const busy = options.allowRefreshSupersession
      ? this.isMutationActive || this.inventoryCount > 0
      : this.isCommandActive;
    if (busy) return undefined;

    let released = false;
    this.commandCount += 1;
    this.callbacks.onLockStateChange();
    return () => {
      if (released) return;
      released = true;
      this.commandCount = Math.max(0, this.commandCount - 1);
      this.callbacks.onLockStateChange();
      this.callbacks.onCommandReleased();
    };
  }

  beginRefresh(sequence: number): void {
    this.refreshSequence = sequence;
    this.callbacks.onLockStateChange();
  }

  endRefresh(sequence: number): boolean {
    if (this.refreshSequence !== sequence) return false;
    this.refreshSequence = undefined;
    this.callbacks.onLockStateChange();
    return true;
  }

  async readInventory(read: HomebrewInventoryRead<Inventory>): Promise<Inventory> {
    for (;;) {
      const active = this.activeInventoryTask;
      if (!active) break;
      const result = await active.task;
      if (!read.updateMetadata || active.updateMetadata) return result;
      // Another waiter may already have started the stronger read. Recheck its
      // task after the weaker read finishes instead of starting in parallel.
    }
    if (this.isMutationActive && !read.allowDuringMutation) return read.blocked();

    let resolveTask!: (result: Inventory) => void;
    let rejectTask!: (error: unknown) => void;
    const task = new Promise<Inventory>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    // The initiating caller may be the only waiter when a read fails.
    void task.catch(() => undefined);
    this.activeInventoryTask = { updateMetadata: read.updateMetadata, task };
    this.inventoryCount += 1;
    try {
      this.callbacks.onLockStateChange();
    } catch (error) {
      this.activeInventoryTask = undefined;
      this.inventoryCount -= 1;
      rejectTask(error);
      throw error;
    }

    const run = async () => {
      try {
        const result = await read.start(read.updateMetadata);
        read.reconcileBeforeRelease(result);
        return result;
      } catch (error) {
        read.invalidateBeforeRelease();
        throw error;
      } finally {
        if (this.activeInventoryTask?.task === task) this.activeInventoryTask = undefined;
        this.inventoryCount = Math.max(0, this.inventoryCount - 1);
        this.callbacks.onLockStateChange();
      }
    };
    void run().then(resolveTask, rejectTask);
    return task;
  }
}
