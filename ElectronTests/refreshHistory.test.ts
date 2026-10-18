// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type AppRecord,
  type PersistedSnapshot,
  type UpdateRecord
} from "../src/shared/domain";
import { version } from "../src/shared/version";

type StoreOptions = ConstructorParameters<typeof UpdateStore>[0];
type AppleLookup = NonNullable<NonNullable<StoreOptions["clients"]>["appStore"]>["lookupOutcome"];
type AppleOutcome = Awaited<ReturnType<AppleLookup>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function fixture(buildOnly = false) {
  const previousApp: AppRecord = {
    id: "/fixture/Example.app",
    bundlePath: "/fixture/Example.app",
    displayName: "Example",
    bundleIdentifier: "com.example.fixture",
    localVersion: version("1"),
    sourceHint: buildOnly ? "sparkle" : "appStore",
    ...(buildOnly
      ? { bundleVersion: version("100"), sparkleFeedURL: "https://example.com/feed.xml" }
      : {})
  };
  const app = {
    ...previousApp,
    ...(buildOnly ? { bundleVersion: version("200") } : { localVersion: version("2") })
  };
  const previousUpdate: UpdateRecord = {
    id: app.id,
    appID: app.id,
    source: previousApp.sourceHint,
    supportLevel: "supported",
    localVersion: previousApp.localVersion,
    remoteVersion: app.localVersion,
    updateURL: "https://example.com/update",
    ...(buildOnly
      ? {
          localBuildVersion: previousApp.bundleVersion,
          remoteBuildVersion: app.bundleVersion,
          sparkleVersionComparison: "build" as const
        }
      : {}),
    checkedAt: new Date().toISOString()
  };
  return {
    app,
    persisted: { ...defaultPersistedSnapshot(), apps: [previousApp], updates: [previousUpdate] },
    history: {
      appID: app.id,
      fromVersion: previousApp.localVersion,
      toVersion: app.localVersion,
      ...(buildOnly ? { fromBuildVersion: version("100"), toBuildVersion: version("200") } : {})
    }
  };
}

async function setup(
  app: AppRecord,
  persisted: PersistedSnapshot,
  apple = vi.fn<AppleLookup>().mockResolvedValue({ type: "completed" })
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-refresh-history-"));
  directories.push(directory);
  const persistence = new SnapshotPersistence(directory);
  const clients: NonNullable<StoreOptions["clients"]> = {
    scanner: { scanApplications: async () => [app] },
    appStore: { lookupOutcome: apple },
    sparkle: { lookupOutcome: async () => ({ type: "completed", providerFound: true }) },
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
        inventoryReadSucceededByKind: { formula: true, cask: true },
        outdatedDetectionSucceededByKind: { formula: true, cask: true }
      })
    },
    selfUpdate: {
      lookup: async (currentVersion, checkedAt) => ({
        currentVersion,
        checkedAt,
        available: false,
        releaseURL: "https://example.com/releases"
      })
    }
  };
  const options = {
    persistence,
    persisted,
    clients,
    openExternalURL: async () => true,
    openAppBundle: async () => undefined,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => ({ ...stats, integrityStatus: "verified" as const }),
      seal: async (stats) => stats
    }
  } satisfies StoreOptions;
  return { store: new UpdateStore(options), persistence, options, apple };
}

describe("refresh history comparison evidence", () => {
  it("advances the committed comparison when an installed upgrade still has a newer pending update", async () => {
    const { app, persisted } = fixture();
    const apple = vi.fn<AppleLookup>().mockResolvedValue({
      type: "completed",
      providerFound: true,
      value: { remoteVersion: version("3"), updateURL: "https://example.com/update" }
    });
    const { store, options, persistence } = await setup(app, persisted, apple);
    try {
      await store.refresh(false);
      expect(store.getSnapshot().recentlyUpdated).toEqual([]);
      expect(store.getSnapshot().updates).toMatchObject([
        { localVersion: version("2"), remoteVersion: version("3") }
      ]);
      expect((await persistence.load()).appUpdateComparisonBaseline).toMatchObject([
        { localVersion: version("2") }
      ]);
      options.clients.scanner!.scanApplications = async () => [
        { ...app, localVersion: version("3") }
      ];
      apple.mockResolvedValue({ type: "completed", providerFound: true });
      await store.refresh(false);
      expect(store.getSnapshot().recentlyUpdated).toMatchObject([
        { fromVersion: version("2"), toVersion: version("3") }
      ]);
      const saved = await persistence.load();
      expect(saved.appUpdateComparisonBaseline).toEqual([]);
      const relaunched = new UpdateStore({ ...options, persisted: saved });
      try {
        await relaunched.refresh(false);
        expect(relaunched.getSnapshot().recentlyUpdated).toEqual(saved.recentlyUpdated);
      } finally {
        await relaunched.prepareToQuit();
      }
    } finally {
      await store.prepareToQuit();
    }
  });

  it.each([false, true])(
    "retains an installed upgrade across superseded previews (build only: %s)",
    async (buildOnly) => {
      const { app, persisted, history } = fixture(buildOnly);
      const gate = deferred<AppleOutcome>();
      const apple = vi
        .fn()
        .mockImplementationOnce(() => gate.promise)
        .mockResolvedValue({ type: "completed" });
      const { store } = await setup(app, persisted, apple);
      const first = store.refresh(false);
      let second: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(apple).toHaveBeenCalledTimes(1));
        expect(store.getSnapshot().updates).toEqual([]);
        expect(store.getSnapshot().recentlyUpdated).toEqual([]);
        second = store.refresh(false);
        await second;
        expect(store.getSnapshot()).toMatchObject({
          apps: [app],
          updates: [],
          isRefreshing: false,
          recentlyUpdated: [history]
        });
        await store.refresh(false);
        expect(store.getSnapshot().recentlyUpdated).toHaveLength(1);
        gate.resolve({ type: "completed" });
        await first;
        expect(store.getSnapshot().recentlyUpdated).toMatchObject([history]);
      } finally {
        gate.resolve({ type: "completed" });
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        await store.prepareToQuit();
      }
    }
  );

  it.each([false, true])(
    "retains history through a preference save and relaunch during streaming (build only: %s)",
    async (buildOnly) => {
      const { app, persisted, history } = fixture(buildOnly);
      const gate = deferred<AppleOutcome>();
      const apple = vi
        .fn()
        .mockImplementationOnce(() => gate.promise)
        .mockResolvedValue({ type: "completed" });
      const { store, persistence, options } = await setup(app, persisted, apple);
      const task = store.refresh(false);
      let relaunched: UpdateStore | undefined;
      try {
        await vi.waitFor(() => expect(apple).toHaveBeenCalledTimes(1));
        expect(store.getSnapshot().updates).toEqual([]);
        await store.updatePreferences({ appearancePreference: "dark" });
        const saved = await persistence.load();
        expect(saved).toMatchObject({
          apps: [app],
          updates: [],
          appearancePreference: "dark",
          appUpdateComparisonBaseline: [{ appID: app.id, localVersion: version("1") }]
        });
        expect(saved.appUpdateComparisonBaseline?.[0]).not.toHaveProperty("updateURL");
        expect(saved.appUpdateComparisonBaseline?.[0]).not.toHaveProperty("homebrewToken");
        relaunched = new UpdateStore({ ...options, persisted: saved });
        expect(relaunched.getSnapshot().updates).toEqual([]);
        await relaunched.refresh(false);
        expect(relaunched.getSnapshot().recentlyUpdated).toMatchObject([history]);
      } finally {
        gate.resolve({ type: "completed" });
        await Promise.allSettled([task]);
        await store.prepareToQuit();
        await relaunched?.prepareToQuit();
      }
    }
  );

  it("retains comparison evidence on a failed generation and consumes it only once on recovery", async () => {
    const { app, persisted, history } = fixture();
    const gate = deferred<AppleOutcome>();
    const apple = vi
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue({ type: "completed" });
    const { store, options, persistence } = await setup(app, persisted, apple);
    const first = store.refresh(false);
    const tasks = [first];
    try {
      await vi.waitFor(() => expect(apple).toHaveBeenCalledTimes(1));
      options.clients.scanner!.scanApplications = vi
        .fn()
        .mockRejectedValueOnce(new Error("Scan failed"))
        .mockResolvedValue([app]);
      const failed = store.refresh(false);
      tasks.push(failed);
      await failed;
      expect(store.getSnapshot().refreshErrorMessage).toBe("Scan failed");
      expect((await persistence.load()).appUpdateComparisonBaseline).toMatchObject([
        { localVersion: version("1") }
      ]);
      const recovery = store.refresh(false);
      tasks.push(recovery);
      await recovery;
      expect(store.getSnapshot().recentlyUpdated).toMatchObject([history]);
      expect(store.getSnapshot().recentlyUpdated).toHaveLength(1);
      expect((await persistence.load()).appUpdateComparisonBaseline).toEqual([]);
    } finally {
      gate.resolve({ type: "completed" });
      await Promise.allSettled(tasks);
      await store.prepareToQuit();
    }
  });
});
