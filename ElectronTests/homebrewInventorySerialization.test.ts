// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import type { HomebrewInventoryResult } from "../src/main/homebrewInventoryClient";
import { HomebrewWorkLock, type HomebrewInventoryRead } from "../src/main/homebrewWorkLock";
import { SnapshotPersistence } from "../src/main/persistence";
import { UpdateStore } from "../src/main/updateStore";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex
} from "../src/shared/domain";

const inventory: HomebrewInventoryResult = {
  items: [],
  inventoryReadSucceededByKind: { formula: true, cask: true },
  outdatedDetectionSucceeded: true,
  outdatedDetectionSucceededByKind: { formula: true, cask: true }
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function storeWithInventory(fetchInventory: () => Promise<HomebrewInventoryResult>): UpdateStore {
  return new UpdateStore({
    persistence: { save: async () => undefined } as unknown as SnapshotPersistence,
    persisted: { ...defaultPersistedSnapshot(), autoRefreshEnabled: false },
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    runBrewCommand: async () => ({ success: true, status: 0, output: "" }),
    runMasCommand: async () => ({ success: true, status: 0, output: "" }),
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    },
    clients: {
      scanner: { scanApplications: async () => [] },
      appStore: { lookupOutcome: async () => ({ type: "completed" }) },
      sparkle: { lookupOutcome: async () => ({ type: "completed" }) },
      homebrew: {
        fetchIndex: async () => emptyHomebrewCaskIndex,
        lookupUpdate: () => undefined,
        searchCasks: () => []
      },
      homebrewFormula: {
        fetchIndex: async () => emptyHomebrewFormulaIndex,
        searchFormulae: () => []
      },
      homebrewInventory: { fetchInventory }
    }
  });
}

describe("Homebrew inventory serialization", () => {
  it("rolls back a command reservation when lock publication throws", () => {
    const published: boolean[] = [];
    let throwOnce = true;
    const drain = vi.fn();
    const lock = new HomebrewWorkLock<string>({
      hasOtherMutation: () => false,
      onLockStateChange: () => {
        published.push(lock.isCommandLocked);
        if (throwOnce) {
          throwOnce = false;
          throw new Error("lock publication failed");
        }
      },
      onCommandReleased: drain
    });

    expect(() => lock.reserveCommand()).toThrow("lock publication failed");
    expect(lock.activeCommandCount).toBe(0);
    expect(lock.isCommandLocked).toBe(false);
    expect(lock.isCleanupLocked).toBe(false);
    expect(published).toEqual([true, false]);
    expect(drain).not.toHaveBeenCalled();

    const release = lock.reserveCommand();
    expect(release).toBeDefined();
    release?.();
    expect(lock.isCommandLocked).toBe(false);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("drains queued work and makes release idempotent when unlock publication throws", () => {
    let throwOnUnlock = true;
    const drain = vi.fn(() => {
      throw new Error("queue drain failed");
    });
    const lock = new HomebrewWorkLock<string>({
      hasOtherMutation: () => false,
      onLockStateChange: () => {
        if (!lock.isCommandLocked && throwOnUnlock) {
          throwOnUnlock = false;
          throw new Error("unlock publication failed");
        }
      },
      onCommandReleased: drain
    });
    const release = lock.reserveCommand();
    expect(release).toBeDefined();

    expect(() => release?.()).toThrow("unlock publication failed");
    expect(lock.activeCommandCount).toBe(0);
    expect(lock.isCommandLocked).toBe(false);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(() => release?.()).not.toThrow();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("shares one metadata read between full refreshes waiting behind a lightweight read", async () => {
    const lightweight = deferred<HomebrewInventoryResult>();
    const metadata = deferred<HomebrewInventoryResult>();
    let active = 0;
    let peak = 0;
    let calls = 0;
    const store = storeWithInventory(async () => {
      const call = ++calls;
      peak = Math.max(peak, ++active);
      try {
        return await (call === 1 ? lightweight.promise : metadata.promise);
      } finally {
        active -= 1;
      }
    });
    const tasks = [store.refresh(true), store.refresh(false), store.refresh(false)];
    try {
      expect(calls).toBe(1);
      lightweight.resolve(inventory);
      await vi.waitFor(() => expect(calls).toBe(2));
      expect(peak).toBe(1);
      metadata.resolve(inventory);
      await Promise.all(tasks);
      expect(calls).toBe(2);
      expect(peak).toBe(1);
    } finally {
      lightweight.resolve(inventory);
      metadata.resolve(inventory);
      await Promise.allSettled(tasks);
      await store.prepareToQuit();
    }
  });

  it("registers the shared read before synchronous lock-state listeners can request inventory", async () => {
    const gate = deferred<string>();
    let nested: Promise<string> | undefined;
    let starts = 0;
    const read: HomebrewInventoryRead<string> = {
      updateMetadata: false,
      allowDuringMutation: false,
      blocked: () => "blocked",
      start: () => {
        starts += 1;
        return gate.promise;
      },
      reconcileBeforeRelease: () => undefined,
      invalidateBeforeRelease: () => undefined
    };
    const lock = new HomebrewWorkLock<string>({
      hasOtherMutation: () => false,
      onLockStateChange: () => {
        if (!nested && lock.isCleanupLocked) nested = lock.readInventory(read);
      },
      onCommandReleased: () => undefined
    });
    const first = lock.readInventory(read);
    try {
      expect(starts).toBe(1);
      expect(nested).toBeDefined();
      gate.resolve("fresh");
      expect(await first).toBe("fresh");
      expect(await nested).toBe("fresh");
      expect(starts).toBe(1);
      expect(lock.isCleanupLocked).toBe(false);
    } finally {
      gate.resolve("fresh");
      await Promise.allSettled([first, ...(nested ? [nested] : [])]);
    }
  });

  it("invalidates and republishes an unlocked state when the first lock notification throws", async () => {
    const published: boolean[] = [];
    let shouldThrow = true;
    let lockedDuringInvalidation = false;
    const start = vi.fn(async () => "fresh");
    const lock = new HomebrewWorkLock<string>({
      hasOtherMutation: () => false,
      onLockStateChange: () => {
        published.push(lock.isCleanupLocked);
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("snapshot listener failed");
        }
      },
      onCommandReleased: () => undefined
    });
    const read: HomebrewInventoryRead<string> = {
      updateMetadata: false,
      allowDuringMutation: false,
      blocked: () => "blocked",
      start,
      reconcileBeforeRelease: () => undefined,
      invalidateBeforeRelease: () => {
        lockedDuringInvalidation = lock.isCleanupLocked;
      }
    };

    await expect(lock.readInventory(read)).rejects.toThrow("snapshot listener failed");
    expect(start).not.toHaveBeenCalled();
    expect(lockedDuringInvalidation).toBe(true);
    expect(published).toEqual([true, false]);
    expect(lock.isCleanupLocked).toBe(false);

    expect(await lock.readInventory(read)).toBe("fresh");
    expect(start).toHaveBeenCalledTimes(1);
    expect(lock.isCleanupLocked).toBe(false);
  });

  it("releases a failed shared read before a later inventory or command starts", async () => {
    const gate = deferred<string>();
    let lockedDuringInvalidation = false;
    const lock = new HomebrewWorkLock<string>({
      hasOtherMutation: () => false,
      onLockStateChange: () => undefined,
      onCommandReleased: () => undefined
    });
    const first = lock.readInventory({
      updateMetadata: false,
      allowDuringMutation: false,
      blocked: () => "blocked",
      start: () => gate.promise,
      reconcileBeforeRelease: () => undefined,
      invalidateBeforeRelease: () => {
        lockedDuringInvalidation = lock.isCleanupLocked;
      }
    });
    try {
      gate.reject(new Error("inventory unavailable"));
      await expect(first).rejects.toThrow("inventory unavailable");
      expect(lockedDuringInvalidation).toBe(true);
      expect(lock.isCleanupLocked).toBe(false);
      const second = await lock.readInventory({
        updateMetadata: false,
        allowDuringMutation: false,
        blocked: () => "blocked",
        start: async () => "recovered",
        reconcileBeforeRelease: () => undefined,
        invalidateBeforeRelease: () => undefined
      });
      expect(second).toBe("recovered");
      const release = lock.reserveCommand();
      expect(release).toBeDefined();
      release?.();
    } finally {
      gate.reject(new Error("inventory unavailable"));
      await Promise.allSettled([first]);
    }
  });
});
