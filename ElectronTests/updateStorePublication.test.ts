// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnapshotPersistence } from "../src/main/persistence";
import { UpdateStore } from "../src/main/updateStore";
import {
  applySnapshotProgress,
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type BaselineSnapshot,
  type HomebrewCaskDiscoveryItem,
  type HomebrewManagedItem,
  type SnapshotProgressEvent
} from "../src/shared/domain";
import { version } from "../src/shared/version";

const fixtures: { store: UpdateStore; directory: string }[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const { store, directory } of fixtures.splice(0)) {
    await store.prepareToQuit();
    await rm(directory, { recursive: true, force: true });
  }
});

async function makeStore(options: Partial<ConstructorParameters<typeof UpdateStore>[0]> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-publication-"));
  const persistence = new SnapshotPersistence(directory);
  const store = new UpdateStore({
    persistence,
    persisted: { ...defaultPersistedSnapshot(), autoRefreshEnabled: false },
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    },
    runBrewCommand: async () => ({ success: true, status: 0, output: "" }),
    runMasCommand: async () => ({ success: true, status: 0, output: "" }),
    successRefreshDelayMS: 0,
    ...options,
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
      homebrewInventory: {
        fetchInventory: async () => ({
          items: [],
          outdatedDetectionSucceeded: true,
          outdatedDetectionSucceededByKind: { formula: true, cask: true }
        })
      },
      selfUpdate: {
        lookup: async (currentVersion, checkedAt) => ({
          available: false,
          currentVersion,
          checkedAt
        })
      },
      ...options.clients
    }
  });
  fixtures.push({ store, directory });
  return { store, persistence };
}

describe("store snapshot publications", () => {
  it("clones and broadcasts only changed state while preserving actionable inventory", async () => {
    const apps = Array.from({ length: 64 }, (_, index) => ({
      id: `/fixture/Utility ${index}.app`,
      bundlePath: `/fixture/Utility ${index}.app`,
      displayName: `Utility ${index}`,
      localVersion: version("1"),
      sourceHint: "unknown" as const
    }));
    const update = {
      id: apps[0]!.id,
      appID: apps[0]!.id,
      source: "sparkle" as const,
      supportLevel: "supported" as const,
      localVersion: version("1"),
      remoteVersion: version("2"),
      checkedAt: "2026-10-18T12:00:00.000Z"
    };
    const { store } = await makeStore({
      persisted: { ...defaultPersistedSnapshot(), apps, updates: [update] }
    });
    const firstWindow = vi.fn();
    const secondWindow = vi.fn();
    store.on("snapshot", firstWindow);
    store.on("snapshot", secondWindow);
    const cloneSnapshot = vi.spyOn(store, "getSnapshot");

    await store.setSearchText("missing");
    await store.setSelectedTab("installed");
    for (let index = 0; index < 10; index++) {
      await store.setSearchText("missing");
      await store.setSelectedTab("installed");
    }

    expect(firstWindow).toHaveBeenCalledTimes(2);
    expect(secondWindow).toHaveBeenCalledTimes(2);
    expect(cloneSnapshot).toHaveBeenCalledTimes(2);
    const snapshot = store.getSnapshot();
    expect(snapshot.snapshotRevision).toBe(2);
    expect(snapshot.apps).toHaveLength(64);
    expect(snapshot.updates).toEqual([update]);
    expect(snapshot.searchText).toBe("missing");
    expect(snapshot.selectedTab).toBe("installed");

    // Reopening/resyncing still reads a complete independent snapshot at the same revision.
    store.off("snapshot", secondWindow);
    snapshot.apps.splice(0);
    snapshot.updates.splice(0);
    const reopened = store.getSnapshot();
    expect(reopened.apps).toHaveLength(64);
    expect(reopened.updates).toEqual([update]);
    expect(reopened.snapshotRevision).toBe(2);
    store.on("snapshot", secondWindow);
    await store.setSelectedTab("apps");
    expect(firstWindow).toHaveBeenCalledTimes(3);
    expect(secondWindow).toHaveBeenCalledTimes(3);
  });

  it("ignores recreated discovery results but publishes nested changes and removals", async () => {
    const item: HomebrewCaskDiscoveryItem = {
      id: "cask:utility",
      kind: "cask",
      token: "utility",
      displayName: "Utility",
      version: version("1")
    };
    const { store } = await makeStore({
      clients: {
        homebrew: {
          fetchIndex: async () => emptyHomebrewCaskIndex,
          lookupUpdate: () => undefined,
          searchCasks: () => [structuredClone(item)]
        }
      }
    });
    await store.setSearchText("utility");
    expect(store.getSnapshot().homebrewDiscoverItems).toEqual([item]);
    const snapshot = vi.fn();
    store.on("snapshot", snapshot);
    const revision = store.getSnapshot().snapshotRevision!;
    await store.setSearchText("utility");
    expect(snapshot).not.toHaveBeenCalled();
    expect(store.getSnapshot().snapshotRevision).toBe(revision);

    item.version = version("2");
    await store.setSearchText("utility");
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().homebrewDiscoverItems[0]!.version).toEqual(version("2"));
    await store.setSearchText("");
    expect(store.getSnapshot().homebrewDiscoverItems).toEqual([]);
    expect(snapshot).toHaveBeenCalledTimes(3);
    await store.setSearchText("");
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it("keeps persistence and later preference transitions when a preference patch is unchanged", async () => {
    const { store, persistence } = await makeStore();
    const snapshot = vi.fn();
    const save = vi.spyOn(persistence, "save");
    store.on("snapshot", snapshot);
    await store.updatePreferences({ autoRefreshEnabled: false, collapsedAppSectionIDs: [] });
    expect(snapshot).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    await store.updatePreferences({ collapsedAppSectionIDs: ["installed"] });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect((await persistence.load()).collapsedAppSectionIDs).toEqual(["installed"]);
  });

  it("preserves pending deltas, terminal ordering, resync and operation phase transitions", async () => {
    const item: HomebrewManagedItem = {
      id: "cask:utility",
      token: "utility",
      fullToken: "utility",
      tap: "homebrew/cask",
      name: "Utility",
      kind: "cask",
      installedVersion: version("1"),
      latestVersion: version("2"),
      isOutdated: true
    };
    let output!: (line: string) => void;
    let waiting!: (promptID: string | undefined) => void;
    let started!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const commandGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store } = await makeStore({
      runBrewCommand: async (command, onLine, options) => {
        if (command[0] === "upgrade") {
          output = onLine!;
          waiting = options!.adminOperation!.onWaitingChanged;
          started();
          await commandGate;
        }
        return { success: true, status: 0, output: "" };
      },
      clients: {
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [item],
            inventoryReadSucceededByKind: { cask: true, formula: true },
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { cask: true, formula: true }
          })
        }
      }
    });
    await store.refresh(false);
    let current = store.getSnapshot();
    const events: SnapshotProgressEvent[] = [];
    const snapshots: BaselineSnapshot[] = [];
    const resyncs: boolean[] = [];
    store.on("snapshot", (snapshot) => {
      current = snapshot;
      snapshots.push(snapshot);
    });
    store.on("progress", (event) => {
      events.push(event);
      const applied = applySnapshotProgress(current, event);
      resyncs.push(applied.needsResync);
      current = applied.snapshot;
    });
    const operation = store.performHomebrewUpdate(item.id);
    try {
      await commandStarted;
      vi.useFakeTimers();
      const base = current.snapshotRevision!;
      const fullCount = snapshots.length;
      output("Downloading utility");
      for (let index = 0; index < 10; index++) output("Downloading utility");
      await store.setSelectedTab(current.selectedTab);
      expect(store.getSnapshot().snapshotRevision).toBe(base + 1);
      expect(snapshots).toHaveLength(fullCount);
      vi.advanceTimersByTime(100);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ fromRevision: base, revision: base + 1 });
      expect(current.homebrewBatchProgressByItemID[item.id]).toBe(0.32);

      output("Installing utility");
      await store.setSelectedTab("installed");
      const full = current;
      expect(full.homebrewBatchProgressByItemID[item.id]).toBe(0.72);
      vi.advanceTimersByTime(100);
      expect(events).toHaveLength(1);
      output("Downloading utility");
      expect(store.getSnapshot().snapshotRevision).toBe(full.snapshotRevision);
      output("utility was successfully installed");
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ fromRevision: full.snapshotRevision });
      expect(current.homebrewBatchProgressByItemID[item.id]).toBe(1);
      output("utility was successfully installed");
      vi.advanceTimersByTime(100);
      expect(events).toHaveLength(2);
      expect(resyncs).toEqual([false, false]);
      expect(applySnapshotProgress(full, events[0]!).snapshot).toBe(full);
      expect(
        applySnapshotProgress({ ...full, snapshotRevision: base }, events[1]!).needsResync
      ).toBe(true);
      expect(store.getSnapshot().homebrewBatchProgressByItemID[item.id]).toBe(1);

      waiting("a".repeat(32));
      expect(current.homebrewOperation?.phase).toBe("waiting");
      const waitingRevision = current.snapshotRevision;
      waiting("a".repeat(32));
      expect(current.snapshotRevision).toBe(waitingRevision);
      waiting(undefined);
      expect(current.homebrewOperation?.phase).toBe("running");
    } finally {
      vi.useRealTimers();
      release();
      await operation;
    }
    expect(snapshots.some((snapshot) => snapshot.homebrewOperation?.phase === "reconciling")).toBe(
      true
    );
    expect(store.getSnapshot().homebrewOperation).toBeUndefined();
    expect(store.getSnapshot().homebrewUpdatingItemIDs).toEqual([]);
  });
});
