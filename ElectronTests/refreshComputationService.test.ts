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
    apps: [],
    ignoredIDs: [],
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
  const scanner = {
    scanApplications: vi.fn<
      import("../src/main/bundleScanner").BundleScannerClient["scanApplications"]
    >(() => scan)
  };
  const service = new RefreshComputationService(
    {
      scanner,
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
    scanner,
    events,
    patches,
    ports,
    state,
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
  it("retains unavailable-root apps without fresh checks or update actions, removes confirmed absent apps, and recovers on retry", async () => {
    const app = (root: string, name: string): AppRecord => ({
      id: `${root}/${name}.app`,
      bundlePath: `${root}/${name}.app`,
      displayName: name,
      localVersion: version("1"),
      sourceHint: "sparkle",
      sparkleFeedURL: "https://example.com/feed"
    });
    const retained = app("/offline", "Retained");
    const removed = app("/readable", "Removed");
    const prefixSibling = app("/offline-other", "Sibling");
    const fresh = app("/readable", "Fresh");
    const removedUnderHealthyChild = app("/offline/Child", "Removed child");
    const { service, scanner, state } = setup(Promise.resolve([fresh]), completeInventory);
    state.apps = [retained, removed, prefixSibling, removedUnderHealthyChild];
    state.updates = [
      {
        id: retained.id,
        appID: retained.id,
        source: "sparkle",
        supportLevel: "limited",
        localVersion: version("1"),
        remoteVersion: version("2"),
        checkedAt: "2026-01-01T00:00:00Z"
      }
    ];
    state.appProviderChecks = {
      [retained.id]: {
        fingerprint: "previous",
        storefront: "us",
        status: "checked",
        source: "sparkle",
        checkedAt: "2026-01-01T00:00:00Z"
      }
    };
    state.appUpdateComparisonBaseline = state.updates.map(({ appID, source, localVersion }) => ({
      appID,
      source,
      localVersion
    }));
    const previousCheck = state.appProviderChecks[retained.id];
    scanner.scanApplications.mockImplementationOnce(async (_roots, options) => {
      options?.onRootRead?.({ directory: "/offline", complete: false });
      options?.onRootRead?.({ directory: "/readable", complete: true });
      options?.onRootRead?.({ directory: "/offline/Child", complete: true });
      return [fresh];
    });
    await service.compute(false, 1, {}, new AbortController().signal);
    expect(state.apps.map((item) => item.id)).toEqual([fresh.id, retained.id]);
    expect(state.updates).toEqual([]);
    expect(state.appUpdateComparisonBaseline?.map((item) => item.appID)).toEqual([retained.id]);
    expect(state.appProviderChecks[retained.id]).toEqual({ ...previousCheck, status: "failed" });
    expect((state as RefreshReadState & RefreshPatch).lastRefreshNoticeMessage).toContain(
      "could not be fully read"
    );
    const replacement: AppRecord = {
      ...retained,
      displayName: "Replacement",
      bundleIdentifier: "com.example.replacement",
      providerFingerprint: "new-installation",
      sourceHint: "unknown",
      sparkleFeedURL: undefined
    };
    scanner.scanApplications.mockImplementationOnce(async (_roots, options) => {
      options?.onRootRead?.({ directory: "/offline", complete: true });
      return [fresh, replacement];
    });
    await service.compute(false, 2, {}, new AbortController().signal);
    expect(state.apps).toContainEqual(replacement);
    expect(state.updates).toEqual([]);
    expect(state.appProviderChecks[retained.id]).toMatchObject({
      status: "unresolved",
      fingerprint: "new-installation"
    });
    expect(state.appProviderChecks[retained.id]?.source).toBeUndefined();
    scanner.scanApplications.mockImplementationOnce(async (_roots, options) => {
      options?.onRootRead?.({ directory: "/offline", complete: true });
      return [fresh];
    });
    await service.compute(false, 3, {}, new AbortController().signal);
    expect(state.apps).toEqual([fresh]);
    expect(state.updates).toEqual([]);
    expect(state.appProviderChecks[retained.id]).toBeUndefined();
    expect((state as RefreshReadState & RefreshPatch).lastRefreshNoticeMessage).toBeUndefined();
  });

  it("keeps freshly checked cask routes successful when only formula outdated detection fails", async () => {
    const app: AppRecord = {
      id: "/Applications/Example.app",
      bundlePath: "/Applications/Example.app",
      displayName: "Example",
      localVersion: version("1"),
      sourceHint: "unknown"
    };
    const cask: HomebrewManagedItem = {
      id: "cask:example",
      token: "example",
      fullToken: "example",
      tap: "homebrew/cask",
      name: "Example",
      kind: "cask",
      appID: app.id,
      installedVersion: version("1"),
      isOutdated: false
    };
    const { service, state } = setup(Promise.resolve([app]), {
      ...completeInventory,
      items: [cask],
      outdatedDetectionSucceeded: false,
      outdatedDetectionSucceededByKind: { formula: false, cask: true }
    });
    await service.compute(false, 1, {}, new AbortController().signal);
    expect(state.appProviderChecks?.[app.id]).toMatchObject({
      status: "checked",
      source: "homebrew"
    });
    expect(state.appProviderChecks?.[app.id]?.checkedAt).toBeDefined();
  });

  it("keeps refresh active through persistence and releases its lock only after the final write settles", async () => {
    const drain = deferred<void>();
    const { service, ports, state, patches, events } = setup(
      Promise.resolve([]),
      completeInventory
    );
    ports.persist = async () => {
      events.push("persist");
      await drain.promise;
    };
    const task = service.compute(false, 1, {}, new AbortController().signal);
    try {
      await vi.waitFor(() => expect(events).toContain("persist"));
      expect((state as unknown as { isRefreshing: boolean }).isRefreshing).toBe(true);
      expect(events).not.toContain("end");
      expect(patches.some((patch) => patch.isRefreshing === false)).toBe(false);
      drain.resolve();
      await task;
      expect(patches.at(-1)).toEqual({ isRefreshing: false });
      expect(events.indexOf("persist")).toBeLessThan(events.indexOf("end"));
    } finally {
      drain.resolve();
      await Promise.allSettled([task]);
    }
  });

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
        "patch",
        "end",
        "queue"
      ]);
    } finally {
      scan.resolve([]);
      await Promise.allSettled([task]);
    }
  });
});
