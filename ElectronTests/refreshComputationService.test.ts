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
  const clients = {
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
  };
  const service = new RefreshComputationService(clients, ports);
  return {
    service,
    clients,
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
  it("does not restore consumed comparisons when persistence fails after final reconciliation", async () => {
    const app: AppRecord = {
      id: "example",
      bundlePath: "/Applications/Example.app",
      bundleIdentifier: "com.example.app",
      displayName: "Example",
      localVersion: version("2"),
      sourceHint: "appStore"
    };
    const { service, ports, state } = setup(Promise.resolve([app]), completeInventory);
    state.updates = [
      {
        id: app.id,
        appID: app.id,
        source: "appStore",
        supportLevel: "supported",
        localVersion: version("1"),
        remoteVersion: app.localVersion,
        checkedAt: "2026-10-01T00:00:00Z"
      }
    ];
    ports.persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("Save failed"))
      .mockResolvedValue(undefined);
    await service.compute(false, 1, {}, new AbortController().signal);
    expect(state.recentlyUpdated).toMatchObject([
      { appID: app.id, fromVersion: version("1"), toVersion: app.localVersion }
    ]);
    expect(state.appUpdateComparisonBaseline).toEqual([]);
    expect((state as RefreshReadState & RefreshPatch).refreshErrorMessage).toBe("Save failed");
  });

  it.each(["formula", "selfUpdate"] as const)(
    "streams app updates before a delayed %s result, but waits to reconcile and persist",
    async (delayed) => {
      const gate = deferred<void>();
      const app: AppRecord = {
        id: "example",
        bundlePath: "/Applications/Example.app",
        bundleIdentifier: "com.example.app",
        displayName: "Example",
        localVersion: version("2"),
        sparkleFeedURL: "https://example.com/feed.xml",
        sourceHint: "unknown"
      };
      const actionable = { ...app, id: "actionable", bundleIdentifier: "com.example.actionable" };
      const { service, clients, ports, state, patches, events } = setup(
        Promise.resolve([app, actionable]),
        completeInventory
      );
      state.updates = [
        {
          id: app.id,
          appID: app.id,
          source: "sparkle",
          supportLevel: "limited",
          localVersion: version("1"),
          remoteVersion: version("2"),
          checkedAt: "2026-10-01T00:00:00Z"
        }
      ];
      const previous = state.updates[0]!;
      clients.appStore.lookupOutcome.mockImplementation(async (bundleID: string) => ({
        type: "completed",
        value:
          bundleID === actionable.bundleIdentifier ? { remoteVersion: version("3") } : undefined
      }));
      clients.sparkle.lookupOutcome.mockResolvedValue({ type: "completed", providerFound: true });
      if (delayed === "formula")
        clients.homebrewFormula.fetchIndex.mockImplementation(async () => {
          await gate.promise;
          return emptyHomebrewFormulaIndex;
        });
      else
        ports.lookupSelfUpdate = async () => {
          await gate.promise;
          return undefined;
        };
      const task = service.compute(false, 1, {}, new AbortController().signal);
      try {
        await vi.waitFor(() => expect(state.appProviderChecks?.[app.id]?.status).toBe("checked"));
        expect(clients.appStore.lookupOutcome).toHaveBeenCalledTimes(2);
        expect(state.updates).toMatchObject([
          { appID: actionable.id, source: "appStore", remoteVersion: version("3") }
        ]);
        expect(state.appUpdateComparisonBaseline).toMatchObject([
          { appID: app.id, localVersion: version("1") },
          { appID: actionable.id, localVersion: actionable.localVersion }
        ]);
        expect(events).not.toContain("persist");
        expect(events).not.toContain("end");
        expect(patches.some((patch) => patch.isRefreshing === false)).toBe(false);
        gate.resolve();
        await task;
        expect(state.recentlyUpdated).toMatchObject([
          {
            appID: app.id,
            fromVersion: previous.localVersion,
            toVersion: app.localVersion
          }
        ]);
        expect(events.indexOf("persist")).toBeLessThan(events.indexOf("end"));
      } finally {
        gate.resolve();
        await Promise.allSettled([task]);
      }
    }
  );

  it("waits for started lookups before surfacing a concurrent metadata failure", async () => {
    const gate = deferred<void>();
    const app: AppRecord = {
      id: "example",
      bundlePath: "/Applications/Example.app",
      bundleIdentifier: "com.example.app",
      displayName: "Example",
      localVersion: version("1"),
      sourceHint: "unknown"
    };
    const { service, clients, patches, events, state } = setup(
      Promise.resolve([app]),
      completeInventory
    );
    const priorComparison = {
      appID: "prior",
      source: "sparkle" as const,
      localVersion: version("1")
    };
    state.appUpdateComparisonBaseline = [priorComparison];
    clients.homebrewFormula.fetchIndex.mockRejectedValue(new Error("Formula metadata failed"));
    clients.appStore.lookupOutcome.mockImplementation(async () => {
      await gate.promise;
      return { type: "completed", value: { remoteVersion: version("2") } };
    });
    const task = service.compute(false, 1, {}, new AbortController().signal);
    try {
      await vi.waitFor(() => expect(clients.appStore.lookupOutcome).toHaveBeenCalledTimes(1));
      expect(state.appProviderChecks?.[app.id]?.status).toBe("pending");
      expect(events).not.toContain("end");
      gate.resolve();
      await task;
      expect(patches.some((patch) => patch.refreshErrorMessage === "Formula metadata failed")).toBe(
        true
      );
      expect(state.appProviderChecks?.[app.id]?.status).toBe("checked");
      expect(state.appUpdateComparisonBaseline).toMatchObject([
        priorComparison,
        { appID: app.id, source: "appStore", localVersion: app.localVersion }
      ]);
      expect(events.indexOf("error")).toBeLessThan(events.indexOf("persist"));
      expect(events.indexOf("persist")).toBeLessThan(events.indexOf("end"));
    } finally {
      gate.resolve();
      await Promise.allSettled([task]);
    }
  });

  it.each(["formula", "selfUpdate"] as const)(
    "drains a delayed %s provider before releasing a failed refresh",
    async (delayed) => {
      const gate = deferred<void>();
      const scan = deferred<AppRecord[]>();
      const { service, clients, ports, state, patches, events } = setup(
        scan.promise,
        completeInventory
      );
      if (delayed === "formula")
        clients.homebrewFormula.fetchIndex.mockImplementation(async () => {
          await gate.promise;
          return emptyHomebrewFormulaIndex;
        });
      else
        ports.lookupSelfUpdate = async () => {
          await gate.promise;
          return undefined;
        };
      const task = service.compute(false, 1, {}, new AbortController().signal);
      try {
        scan.reject(new Error("Scanner failed"));
        await vi.waitFor(() => expect(events).toContain("persist"));
        expect(patches.some((patch) => patch.refreshErrorMessage === "Scanner failed")).toBe(true);
        expect((state as RefreshReadState & RefreshPatch).isRefreshing).toBe(true);
        expect(events).not.toContain("end");
        gate.resolve();
        await task;
        expect(patches.at(-1)).toEqual({ isRefreshing: false });
        expect(events.indexOf("persist")).toBeLessThan(events.indexOf("end"));
      } finally {
        scan.resolve([]);
        gate.resolve();
        await Promise.allSettled([task]);
      }
    }
  );

  it("drains unrelated providers after supersession without late state commits", async () => {
    const gate = deferred<void>();
    const { service, clients, events, patches, supersede } = setup(
      Promise.resolve([]),
      completeInventory
    );
    clients.homebrewFormula.fetchIndex.mockImplementation(async () => {
      await gate.promise;
      return emptyHomebrewFormulaIndex;
    });
    const task = service.compute(false, 1, {}, new AbortController().signal);
    try {
      await vi.waitFor(() => expect(patches.some((patch) => patch.apps)).toBe(true));
      supersede();
      const count = patches.length;
      expect(events).not.toContain("end");
      gate.resolve();
      await task;
      expect(patches).toHaveLength(count);
      expect(events).not.toContain("persist");
      expect(events).toContain("end");
    } finally {
      gate.resolve();
      await Promise.allSettled([task]);
    }
  });

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
