// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import type { AppRecord, HomebrewManagedItem } from "../src/shared/domain";
import { emptyHomebrewCaskIndex, emptyHomebrewFormulaIndex } from "../src/shared/domain";
import { version } from "../src/shared/version";
import type { HomebrewInventoryResult } from "../src/main/homebrewInventoryClient";
import {
  RefreshComputationService,
  type RefreshPatch,
  type RefreshPorts,
  type RefreshReadState
} from "../src/main/refreshComputationService";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(scan: Promise<AppRecord[]>, inventory: HomebrewInventoryResult) {
  const events: string[] = [];
  const patches: RefreshPatch[] = [];
  const state: RefreshReadState = {
    homebrewItems: [],
    updates: [],
    recentlyUpdated: [],
    homebrewRecentlyUpdated: [],
    homebrewUpdatedPendingRefreshItemIDs: [],
    homebrewDiscoverInstallingItemIDs: [],
    homebrewDiscoverInstalledPendingRefreshItemIDs: [],
    homebrewDiscoverProgressByItemID: {},
    searchText: ""
  };
  let current = true;
  let cleanupRequired = false;
  const ports: RefreshPorts = {
    readState: () => state,
    patch: (patch) => {
      patches.push(patch);
      events.push(
        patch.isRefreshing === true ? "start" : patch.refreshErrorMessage ? "error" : "patch"
      );
      Object.assign(state, patch);
    },
    persist: async () => {
      events.push("persist");
    },
    scanDirectories: () => ["/Applications"],
    fetchHomebrewInventory: async () => inventory,
    lookupSelfUpdate: async () => undefined,
    isCurrent: () => current,
    isSelfApp: () => false,
    beginRefresh: () => {
      events.push("begin");
    },
    endRefresh: () => {
      events.push("end");
      return true;
    },
    isHomebrewMutationActive: () => false,
    isCleanupInventoryRequired: () => cleanupRequired,
    setCleanupInventoryRequired: (required) => {
      cleanupRequired = required;
    },
    invalidateHomebrewUpdateTargets: () => {
      events.push("invalidate");
    },
    processHomebrewUpdateQueue: () => {
      events.push("queue");
    }
  };
  const service = new RefreshComputationService(
    {
      scanner: { scanApplications: vi.fn(() => scan) },
      appStore: { lookupOutcome: vi.fn().mockResolvedValue({ type: "completed" }) },
      sparkle: { lookupOutcome: vi.fn().mockResolvedValue({ type: "completed" }) },
      homebrew: {
        fetchIndex: vi.fn().mockResolvedValue(emptyHomebrewCaskIndex),
        lookupUpdate: vi.fn().mockReturnValue(undefined),
        searchCasks: vi.fn().mockReturnValue([])
      },
      homebrewFormula: {
        fetchIndex: vi.fn().mockResolvedValue(emptyHomebrewFormulaIndex),
        searchFormulae: vi.fn().mockReturnValue([])
      }
    },
    ports
  );
  return {
    service,
    events,
    patches,
    supersede: () => {
      current = false;
    },
    requireCleanupInventory: () => {
      cleanupRequired = true;
    }
  };
}

const completeInventory: HomebrewInventoryResult = {
  items: [],
  outdatedDetectionSucceeded: true,
  outdatedDetectionSucceededByKind: { formula: true, cask: true },
  inventoryReadSucceededByKind: { formula: true, cask: true }
};

describe("RefreshComputationService", () => {
  it("begins lock and refresh state synchronously, then skips a superseded provider result", async () => {
    const scan = deferred<AppRecord[]>();
    const { service, events, patches, supersede } = setup(scan.promise, completeInventory);
    const task = service.compute(false, 1, {}, new AbortController().signal);
    try {
      expect(events.slice(0, 2)).toEqual(["begin", "start"]);
      supersede();
      scan.resolve([]);
      await task;
      expect(patches).toHaveLength(1);
      expect(events).toEqual(["begin", "start", "end", "queue"]);
    } finally {
      scan.resolve([]);
      await Promise.allSettled([task]);
    }
  });

  it("commits recovered inventory before invalidation, persistence and lock release on provider failure", async () => {
    const scan = deferred<AppRecord[]>();
    const item: HomebrewManagedItem = {
      id: "cask:example",
      token: "example",
      name: "Example",
      kind: "cask",
      installedVersion: version("1.0"),
      isOutdated: false
    };
    const { service, events, patches, requireCleanupInventory } = setup(scan.promise, {
      ...completeInventory,
      items: [item],
      warning: "Inventory was refreshed."
    });
    requireCleanupInventory();
    const task = service.compute(false, 1, {}, new AbortController().signal);
    try {
      scan.reject(new Error("Scanner failed"));
      await task;
      expect(patches[1]).toMatchObject({
        isRefreshing: false,
        refreshErrorMessage: "Scanner failed",
        lastRefreshNoticeMessage: "Inventory was refreshed.",
        homebrewItems: [{ id: item.id }]
      });
      expect(events).toEqual([
        "begin",
        "start",
        "error",
        "invalidate",
        "persist",
        "queue",
        "end",
        "queue"
      ]);
    } finally {
      scan.resolve([]);
      await Promise.allSettled([task]);
    }
  });
});
