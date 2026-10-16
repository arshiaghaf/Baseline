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
    const active = this.activeInventoryTask;
    if (active) {
      const result = await active.task;
      if (!read.updateMetadata || active.updateMetadata) return result;
    }
    if (this.isMutationActive && !read.allowDuringMutation) return read.blocked();

    this.inventoryCount += 1;
    this.callbacks.onLockStateChange();
    let task: Promise<Inventory> | undefined;
    try {
      task = read.start(read.updateMetadata);
      this.activeInventoryTask = { updateMetadata: read.updateMetadata, task };
      const result = await task;
      read.reconcileBeforeRelease(result);
      return result;
    } catch (error) {
      read.invalidateBeforeRelease();
      throw error;
    } finally {
      if (task && this.activeInventoryTask?.task === task) this.activeInventoryTask = undefined;
      this.inventoryCount = Math.max(0, this.inventoryCount - 1);
      this.callbacks.onLockStateChange();
    }
  }
}
