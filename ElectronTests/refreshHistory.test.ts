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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
    currentAppVersion: "1.0.0",
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
  it.each(
    (["quit", "supersede", "preferenceSave"] as const).flatMap((transition) =>
      [false, true].flatMap((priorUpdate) =>
        [false, true].map((buildOnly) => ({ transition, priorUpdate, buildOnly }))
      )
    )
  )(
    "keeps a streamed comparison through $transition while metadata waits (prior update: $priorUpdate, build only: $buildOnly)",
    async ({ transition, priorUpdate, buildOnly }) => {
      const { app, persisted } = fixture(buildOnly);
      if (!priorUpdate) {
        persisted.updates = [];
        persisted.appUpdateComparisonBaseline = [];
      }
      const apple = vi.fn<AppleLookup>().mockResolvedValue(
        buildOnly
          ? { type: "completed" }
          : {
              type: "completed",
              value: { remoteVersion: version("3"), updateURL: "https://example.com/update" }
            }
      );
      const { store, persistence, options } = await setup(app, persisted, apple);
      if (buildOnly)
        options.clients.sparkle!.lookupOutcome = async () => ({
          type: "completed",
          providerFound: true,
          value: {
            remoteVersion: app.localVersion,
            remoteBuildVersion: version("300"),
            versionComparison: "build"
          }
        });
      const gate = deferred<typeof emptyHomebrewFormulaIndex>();
      options.clients.homebrewFormula!.fetchIndex = () => gate.promise;
      const first = store.refresh(false);
      let quit: Promise<boolean> | undefined;
      let successor: Promise<void> | undefined;
      let relaunched: UpdateStore | undefined;
      try {
        await vi.waitFor(() => {
          expect(store.getSnapshot().appProviderChecks?.[app.id]?.status).toBe("checked");
          expect(store.getSnapshot().updates).toMatchObject([
            {
              localVersion: app.localVersion,
              ...(buildOnly ? { localBuildVersion: app.bundleVersion } : {})
            }
          ]);
        });
        expect(store.getSnapshot().isRefreshing).toBe(true);
        if (transition === "preferenceSave")
          await store.updatePreferences({ appearancePreference: "dark" });

        options.clients.homebrewFormula!.fetchIndex = async () => emptyHomebrewFormulaIndex;
        const installed = {
          ...app,
          ...(buildOnly ? { bundleVersion: version("300") } : { localVersion: version("3") })
        };
        options.clients.scanner!.scanApplications = async () => [installed];
        apple.mockResolvedValue({ type: "completed", providerFound: !buildOnly });
        options.clients.sparkle!.lookupOutcome = async () => ({
          type: "completed",
          providerFound: true
        });
        let consumer: UpdateStore;
        if (transition === "supersede") {
          successor = store.refresh(false);
          await successor;
          const winner = store.getSnapshot();
          gate.reject(new Error("Superseded metadata failed"));
          await first;
          expect(store.getSnapshot().recentlyUpdated).toEqual(winner.recentlyUpdated);
          expect(store.getSnapshot().appUpdateComparisonBaseline).toEqual(
            winner.appUpdateComparisonBaseline
          );
          expect(store.getSnapshot().lastRefreshDate).toBe(winner.lastRefreshDate);
          expect(store.getSnapshot().refreshErrorMessage).toBeUndefined();
          consumer = store;
        } else {
          const preferenceSave =
            transition === "preferenceSave" ? await persistence.load() : undefined;
          quit = store.prepareToQuit();
          gate.resolve(emptyHomebrewFormulaIndex);
          expect(await quit).toBe(true);
          await first;
          const saved = preferenceSave ?? (await persistence.load());
          expect(saved.updates).toHaveLength(1);
          if (preferenceSave) expect(saved.appearancePreference).toBe("dark");
          relaunched = new UpdateStore({ ...options, persisted: saved });
          await relaunched.refresh(false);
          consumer = relaunched;
        }
        const history = {
          appID: app.id,
          source: buildOnly ? "sparkle" : "appStore",
          fromVersion: app.localVersion,
          toVersion: installed.localVersion,
          ...(buildOnly
            ? { fromBuildVersion: app.bundleVersion, toBuildVersion: installed.bundleVersion }
            : {})
        };
        expect(consumer.getSnapshot().recentlyUpdated).toMatchObject([history]);
        await consumer.refresh(false);
        expect(consumer.getSnapshot().recentlyUpdated).toMatchObject([history]);
        expect(consumer.getSnapshot().recentlyUpdated).toHaveLength(1);
        expect((await persistence.load()).recentlyUpdated).toMatchObject([history]);
      } finally {
        gate.resolve(emptyHomebrewFormulaIndex);
        await Promise.allSettled([first, quit, successor]);
        await store.prepareToQuit();
        await relaunched?.prepareToQuit();
      }
    }
  );

  it.each([false, true])(
    "saves a new comparison before other app lookups complete (build only: %s)",
    async (buildOnly) => {
      const { app, persisted } = fixture(buildOnly);
      persisted.updates = [];
      persisted.appUpdateComparisonBaseline = [];
      const gate = deferred<AppleOutcome>();
      const other = {
        ...app,
        id: "other",
        bundlePath: "/fixture/Other.app",
        displayName: "Other",
        bundleIdentifier: "com.example.other",
        sparkleFeedURL: undefined
      };
      const apple = vi
        .fn<AppleLookup>()
        .mockImplementation(async (bundleID) =>
          bundleID === other.bundleIdentifier
            ? gate.promise
            : buildOnly
              ? { type: "completed" }
              : { type: "completed", value: { remoteVersion: version("3") } }
        );
      const { store, persistence, options } = await setup(app, persisted, apple);
      options.clients.scanner!.scanApplications = async () => [app, other];
      if (buildOnly)
        options.clients.sparkle!.lookupOutcome = async () => ({
          type: "completed",
          providerFound: true,
          value: {
            remoteVersion: app.localVersion,
            remoteBuildVersion: version("300"),
            versionComparison: "build"
          }
        });
      const refresh = store.refresh(false);
      let quit: Promise<boolean> | undefined;
      let relaunched: UpdateStore | undefined;
      try {
        await vi.waitFor(() =>
          expect(store.getSnapshot().appProviderChecks?.[app.id]?.status).toBe("checked")
        );
        expect(store.getSnapshot().appProviderChecks?.[other.id]?.status).toBe("pending");
        await store.updatePreferences({ appearancePreference: "dark" });
        const saved = await persistence.load();
        quit = store.prepareToQuit();
        gate.resolve({ type: "completed" });
        expect(await quit).toBe(true);
        await refresh;
        const installed = {
          ...app,
          ...(buildOnly ? { bundleVersion: version("300") } : { localVersion: version("3") })
        };
        options.clients.scanner!.scanApplications = async () => [installed];
        apple.mockResolvedValue({ type: "completed", providerFound: !buildOnly });
        options.clients.sparkle!.lookupOutcome = async () => ({
          type: "completed",
          providerFound: true
        });
        relaunched = new UpdateStore({ ...options, persisted: saved });
        await relaunched.refresh(false);
        expect(relaunched.getSnapshot().recentlyUpdated).toMatchObject([
          {
            appID: app.id,
            source: buildOnly ? "sparkle" : "appStore",
            fromVersion: app.localVersion,
            toVersion: installed.localVersion,
            ...(buildOnly
              ? { fromBuildVersion: app.bundleVersion, toBuildVersion: installed.bundleVersion }
              : {})
          }
        ]);
        await relaunched.refresh(false);
        expect(relaunched.getSnapshot().recentlyUpdated).toHaveLength(1);
      } finally {
        gate.resolve({ type: "completed" });
        await Promise.allSettled([refresh, quit]);
        await store.prepareToQuit();
        await relaunched?.prepareToQuit();
      }
    }
  );

  it.each(
    (["formula", "selfUpdate"] as const).flatMap((provider) =>
      [false, true].flatMap((priorUpdate) =>
        [false, true].map((buildOnly) => ({ provider, priorUpdate, buildOnly }))
      )
    )
  )(
    "persists streamed comparisons through $provider failure and relaunch (prior update: $priorUpdate, build only: $buildOnly)",
    async ({ provider, priorUpdate, buildOnly }) => {
      const { app, persisted } = fixture(buildOnly);
      if (!priorUpdate) {
        persisted.updates = [];
        persisted.appUpdateComparisonBaseline = [];
      }
      const apple = vi.fn<AppleLookup>().mockResolvedValue(
        buildOnly
          ? { type: "completed" }
          : {
              type: "completed",
              value: { remoteVersion: version("3"), updateURL: "https://example.com/update" }
            }
      );
      const { store, persistence, options } = await setup(app, persisted, apple);
      if (buildOnly)
        options.clients.sparkle!.lookupOutcome = async () => ({
          type: "completed",
          providerFound: true,
          value: {
            remoteVersion: app.localVersion,
            remoteBuildVersion: version("300"),
            versionComparison: "build"
          }
        });
      const gate = deferred<void>();
      const failure = new Error("Unrelated metadata failed");
      const formulaLookup = options.clients.homebrewFormula!.fetchIndex;
      const selfLookup = options.clients.selfUpdate!.lookup;
      if (provider === "formula")
        options.clients.homebrewFormula!.fetchIndex = async () => {
          await gate.promise;
          throw failure;
        };
      else
        options.clients.selfUpdate!.lookup = async () => {
          await gate.promise;
          throw failure;
        };
      const refresh = store.refresh(false);
      let relaunched: UpdateStore | undefined;
      let stopped = false;
      try {
        await vi.waitFor(() =>
          expect(store.getSnapshot().updates).toMatchObject([
            {
              localVersion: app.localVersion,
              ...(buildOnly ? { localBuildVersion: app.bundleVersion } : {})
            }
          ])
        );
        expect(store.getSnapshot().isRefreshing).toBe(true);
        gate.resolve();
        await refresh;
        expect(store.getSnapshot().refreshErrorMessage).toBe(failure.message);
        await store.prepareToQuit();
        stopped = true;
        const saved = await persistence.load();
        expect(saved.updates).toHaveLength(1);
        expect(saved.appUpdateComparisonBaseline).toMatchObject([
          {
            appID: app.id,
            localVersion: app.localVersion,
            ...(buildOnly ? { localBuildVersion: app.bundleVersion } : {})
          }
        ]);
        expect(saved.appUpdateComparisonBaseline?.[0]).not.toHaveProperty("updateURL");
        expect(saved.appUpdateComparisonBaseline?.[0]).not.toHaveProperty("homebrewToken");

        options.clients.homebrewFormula!.fetchIndex = formulaLookup;
        options.clients.selfUpdate!.lookup = selfLookup;
        const installed = {
          ...app,
          ...(buildOnly ? { bundleVersion: version("300") } : { localVersion: version("3") })
        };
        options.clients.scanner!.scanApplications = async () => [installed];
        apple.mockResolvedValue({ type: "completed", providerFound: !buildOnly });
        options.clients.sparkle!.lookupOutcome = async () => ({
          type: "completed",
          providerFound: true
        });
        relaunched = new UpdateStore({ ...options, persisted: saved });
        await relaunched.refresh(false);
        const history = {
          appID: app.id,
          source: buildOnly ? "sparkle" : "appStore",
          fromVersion: app.localVersion,
          toVersion: installed.localVersion,
          ...(buildOnly
            ? { fromBuildVersion: app.bundleVersion, toBuildVersion: installed.bundleVersion }
            : {})
        };
        expect(relaunched.getSnapshot().recentlyUpdated).toMatchObject([history]);
        await relaunched.refresh(false);
        expect(relaunched.getSnapshot().recentlyUpdated).toMatchObject([history]);
        expect(relaunched.getSnapshot().recentlyUpdated).toHaveLength(1);
      } finally {
        gate.resolve();
        await Promise.allSettled([refresh]);
        if (!stopped) await store.prepareToQuit();
        await relaunched?.prepareToQuit();
      }
    }
  );

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
