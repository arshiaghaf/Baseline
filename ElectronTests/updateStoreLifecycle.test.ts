// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appProviderFingerprint } from "../src/main/appUpdateLookupService";
import { SnapshotPersistence } from "../src/main/persistence";
import { UpdateStore } from "../src/main/updateStore";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type AppRecord
} from "../src/shared/domain";
import { version } from "../src/shared/version";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function app(localVersion: string): AppRecord {
  return {
    id: "/fixture/Utility.app",
    bundlePath: "/fixture/Utility.app",
    displayName: "Utility",
    localVersion: version(localVersion),
    sourceHint: "unknown"
  };
}

async function makeStore(
  clients: ConstructorParameters<typeof UpdateStore>[0]["clients"] = {},
  commands: Pick<
    ConstructorParameters<typeof UpdateStore>[0],
    "runBrewCommand" | "runMasCommand"
  > = {},
  options: Partial<
    Pick<
      ConstructorParameters<typeof UpdateStore>[0],
      "persistence" | "profileStatsIntegrity" | "persisted"
    >
  > = {}
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-store-lifecycle-"));
  directories.push(directory);
  return new UpdateStore({
    persistence: new SnapshotPersistence(directory),
    persisted: defaultPersistedSnapshot(),
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    },
    runBrewCommand: async () => ({ success: true, status: 0, output: "" }),
    runMasCommand: async () => ({ success: true, status: 0, output: "" }),
    ...commands,
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
      ...clients
    }
  });
}

describe("update store lifecycle boundaries", () => {
  it("keeps the superseded caller pending until the winning refresh commits", async () => {
    const scans = [deferred<AppRecord[]>(), deferred<AppRecord[]>()];
    const scanApplications = vi.fn(() => scans[scanApplications.mock.calls.length - 1]!.promise);
    const store = await makeStore({ scanner: { scanApplications } });
    const first = store.refresh(false);
    const second = store.refresh(false);
    let firstSettled = false;
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      }
    );

    try {
      scans[0]!.resolve([app("1")]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(firstSettled).toBe(false);
      expect(store.getSnapshot().apps).toEqual([]);

      scans[1]!.resolve([app("2")]);
      await Promise.all([first, second]);
      expect(firstSettled).toBe(true);
      expect(store.getSnapshot().apps).toEqual([app("2")]);
    } finally {
      scans[0]!.resolve([]);
      scans[1]!.resolve([]);
      await Promise.allSettled([first, second]);
    }
  });

  it("does not publish a late error from a superseded refresh", async () => {
    const oldScan = deferred<AppRecord[]>();
    const scanApplications = vi
      .fn<() => Promise<AppRecord[]>>()
      .mockImplementationOnce(() => oldScan.promise)
      .mockResolvedValueOnce([app("2")]);
    const store = await makeStore({ scanner: { scanApplications } });
    const first = store.refresh(false);
    const second = store.refresh(false);

    try {
      await second;
      const winningDate = store.getSnapshot().lastRefreshDate;
      oldScan.reject(new Error("obsolete scan failed"));
      await first;
      expect(store.getSnapshot()).toMatchObject({
        apps: [app("2")],
        lastRefreshDate: winningDate,
        isRefreshing: false
      });
      expect(store.getSnapshot().refreshErrorMessage).toBeUndefined();
    } finally {
      oldScan.resolve([]);
      await Promise.allSettled([first, second]);
    }
  });

  it("releases the Homebrew command lock when a tool-status probe rejects", async () => {
    const runBrewCommand = vi
      .fn<NonNullable<ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"]>>()
      .mockRejectedValueOnce(new Error("brew probe failed"))
      .mockResolvedValue({ success: true, status: 0, output: "" });
    const store = await makeStore({}, { runBrewCommand });

    await expect(store.refreshToolStatus()).rejects.toThrow("brew probe failed");
    expect(store.getSnapshot().isHomebrewCommandLocked).toBe(false);
    await store.refreshToolStatus();
    expect(store.getSnapshot()).toMatchObject({
      isHomebrewCommandLocked: false,
      isHomebrewInstalled: true,
      isChecking: false
    });
    expect(runBrewCommand).toHaveBeenCalledTimes(2);
  });

  it("runs interval refreshes in lightweight mode and stops scheduling after quit", async () => {
    vi.useFakeTimers();
    const scan = deferred<AppRecord[]>();
    const scanApplications = vi.fn(() => scan.promise);
    const fetchIndex = vi.fn(async () => emptyHomebrewCaskIndex);
    const store = await makeStore({
      scanner: { scanApplications },
      homebrew: { fetchIndex, lookupUpdate: () => undefined, searchCasks: () => [] }
    });

    let joining: Promise<void> | undefined;
    try {
      await store.updatePreferences({ autoRefreshEnabled: true, refreshIntervalMinutes: 5 });
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(scanApplications).toHaveBeenCalledTimes(1);
      expect(fetchIndex).toHaveBeenCalledWith({ force: false });
      joining = store.refresh(true);
      expect(scanApplications).toHaveBeenCalledTimes(1);
      scan.resolve([]);
      await joining;

      expect(await store.prepareToQuit()).toBe(true);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(scanApplications).toHaveBeenCalledTimes(1);
    } finally {
      scan.resolve([]);
      await Promise.allSettled([joining]);
      await store.prepareToQuit();
    }
  });

  it.each(["preference", "ignore"])(
    "fences new intents and drains an accepted %s change before the final durable save",
    async (change) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-quit-save-"));
      directories.push(directory);
      const persistence = new SnapshotPersistence(directory);
      const save = persistence.save.bind(persistence);
      const firstSave = deferred<void>();
      const finalSave = deferred<void>();
      const firstStarted = deferred<void>();
      const finalStarted = deferred<void>();
      const saveSpy = vi
        .spyOn(persistence, "save")
        .mockImplementationOnce(async (snapshot) => {
          firstStarted.resolve();
          await firstSave.promise;
          await save(snapshot);
        })
        .mockImplementationOnce(async (snapshot) => {
          finalStarted.resolve();
          await finalSave.promise;
          await save(snapshot);
        });
      const runMasCommand = vi.fn(async () => ({ success: true, status: 0, output: "" }));
      const store = await makeStore({}, { runMasCommand }, { persistence });
      const mutation =
        change === "preference"
          ? store.updatePreferences({ appearancePreference: "dark" })
          : store.toggleIgnoredApp("accepted-before-quit");
      let quit: Promise<boolean> | undefined;
      try {
        await firstStarted.promise;
        quit = store.prepareToQuit();
        expect(store.prepareToQuit()).toBe(quit);
        await expect(store.toggleIgnoredApp("late-intent")).rejects.toThrow("before quitting");
        await expect(store.updatePreferences({ appearancePreference: "light" })).rejects.toThrow(
          "before quitting"
        );
        await expect(store.performAppUpdate("late-update")).rejects.toThrow("before quitting");
        await expect(store.cleanUpHomebrew(async () => true)).rejects.toThrow("before quitting");
        expect(await store.collectHomebrewDiagnostics()).toEqual({ status: "busy" });
        expect(runMasCommand).not.toHaveBeenCalled();
        expect(saveSpy).toHaveBeenCalledTimes(1);
        firstSave.resolve();
        await finalStarted.promise;
        let ready = false;
        void quit.then(() => {
          ready = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(ready).toBe(false);
        finalSave.resolve();
        expect(await quit).toBe(true);
        expect(await persistence.load()).toMatchObject({
          appearancePreference: change === "preference" ? "dark" : "system",
          ignoredIDs: change === "ignore" ? ["accepted-before-quit"] : []
        });
      } finally {
        firstSave.resolve();
        finalSave.resolve();
        await Promise.allSettled([mutation, quit]);
      }
    }
  );

  it("drains a completing refresh save before taking the final snapshot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-quit-refresh-"));
    directories.push(directory);
    const persistence = new SnapshotPersistence(directory);
    const save = persistence.save.bind(persistence);
    const saving = deferred<void>();
    const release = deferred<void>();
    const saveSpy = vi.spyOn(persistence, "save").mockImplementationOnce(async (snapshot) => {
      saving.resolve();
      await release.promise;
      await save(snapshot);
    });
    const store = await makeStore(
      { scanner: { scanApplications: async () => [app("2")] } },
      {},
      { persistence }
    );
    const refresh = store.refresh();
    let quit: Promise<boolean> | undefined;
    try {
      await saving.promise;
      quit = store.prepareToQuit();
      await store.refresh();
      await new Promise((resolve) => setImmediate(resolve));
      expect(saveSpy).toHaveBeenCalledTimes(1);
      release.resolve();
      expect(await quit).toBe(true);
      expect(saveSpy).toHaveBeenCalledTimes(2);
      expect((await persistence.load()).apps).toEqual([app("2")]);
    } finally {
      release.resolve();
      await Promise.allSettled([refresh, quit]);
    }
  });

  it("drains superseded refresh producers and prevents obsolete commits", async () => {
    const scans = [deferred<AppRecord[]>(), deferred<AppRecord[]>()];
    const scanApplications = vi.fn(() => scans[scanApplications.mock.calls.length - 1]!.promise);
    const store = await makeStore({ scanner: { scanApplications } });
    const first = store.refresh();
    const second = store.refresh();
    // Let the synthetic inventory read release its operation reservation.
    await new Promise((resolve) => setImmediate(resolve));
    const quit = store.prepareToQuit();
    let ready = false;
    void quit.then(() => {
      ready = true;
    });
    try {
      scans[1]!.resolve([app("2")]);
      await second;
      await new Promise((resolve) => setImmediate(resolve));
      expect(ready).toBe(false);
      scans[0]!.resolve([app("1")]);
      expect(await quit).toBe(true);
      expect(store.getSnapshot()).toMatchObject({ apps: [], isRefreshing: false });
    } finally {
      scans[0]!.resolve([]);
      scans[1]!.resolve([]);
      await Promise.allSettled([first, second, quit]);
    }
  });

  it("drains admitted profile verification before the final durable snapshot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-quit-stats-"));
    directories.push(directory);
    const persistence = new SnapshotPersistence(directory);
    const verified = deferred<void>();
    const store = await makeStore(
      {},
      {},
      {
        persistence,
        profileStatsIntegrity: {
          verifyOrInitialize: async (stats) => {
            await verified.promise;
            return { ...stats, signature: "synthetic-seal", integrityStatus: "verified" };
          },
          seal: async (stats) => stats
        }
      }
    );
    const verification = store.verifyProfileStatsIntegrity();
    const quit = store.prepareToQuit();
    try {
      await expect(store.verifyProfileStatsIntegrity()).rejects.toThrow("before quitting");
      let ready = false;
      void quit.then(() => {
        ready = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(ready).toBe(false);
      verified.resolve();
      expect(await quit).toBe(true);
      expect((await persistence.load()).profileStats.signature).toBe("synthetic-seal");
    } finally {
      verified.resolve();
      await Promise.allSettled([verification, quit]);
    }
  });

  it("reopens admission and interval scheduling when the final save fails", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-quit-retry-"));
    directories.push(directory);
    const persistence = new SnapshotPersistence(directory);
    const scanApplications = vi.fn(async () => []);
    const store = await makeStore({ scanner: { scanApplications } }, {}, { persistence });
    await store.updatePreferences({ autoRefreshEnabled: true, refreshIntervalMinutes: 5 });
    vi.spyOn(persistence, "save").mockRejectedValueOnce(new Error("save unavailable"));
    await expect(store.prepareToQuit()).rejects.toThrow("save unavailable");
    await store.toggleIgnoredApp("accepted-after-failure");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await store.refresh(true);
    expect(scanApplications).toHaveBeenCalledTimes(1);
    expect(await store.prepareToQuit()).toBe(true);
    expect((await persistence.load()).ignoredIDs).toEqual(["accepted-after-failure"]);
  });

  it("resumes an interrupted refresh when quitting is abandoned after a save failure", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-quit-resume-"));
    directories.push(directory);
    const persistence = new SnapshotPersistence(directory);
    vi.spyOn(persistence, "save").mockRejectedValueOnce(new Error("save unavailable"));
    const oldScan = deferred<AppRecord[]>();
    const scanApplications = vi
      .fn<() => Promise<AppRecord[]>>()
      .mockImplementationOnce(() => oldScan.promise)
      .mockResolvedValue([app("2")]);
    const store = await makeStore({ scanner: { scanApplications } }, {}, { persistence });
    const refresh = store.refresh();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const quitting = store.prepareToQuit();
      oldScan.resolve([]);
      await expect(quitting).rejects.toThrow("save unavailable");
      await store.refresh(true);
      expect(scanApplications).toHaveBeenCalledTimes(2);
      expect((await persistence.load()).apps).toEqual([app("2")]);
    } finally {
      oldScan.resolve([]);
      await Promise.allSettled([refresh]);
      await store.prepareToQuit();
    }
  });

  it.each(["add", "remove"])(
    "replays an admitted directory %s refresh after quit saving fails",
    async (change) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-quit-directory-"));
      directories.push(directory);
      const persistence = new SnapshotPersistence(directory);
      const save = persistence.save.bind(persistence);
      const saving = deferred<void>();
      const release = deferred<void>();
      vi.spyOn(persistence, "save")
        .mockImplementationOnce(async (snapshot) => {
          saving.resolve();
          await release.promise;
          await save(snapshot);
        })
        .mockRejectedValueOnce(new Error("final save unavailable"));
      const scanApplications = vi.fn<(directories: string[]) => Promise<AppRecord[]>>(async () => [
        app("2")
      ]);
      const fetchIndex = vi.fn(async () => emptyHomebrewCaskIndex);
      const additional = "/fixture/additional";
      const store = await makeStore(
        {
          scanner: { scanApplications },
          homebrew: { fetchIndex, lookupUpdate: () => undefined, searchCasks: () => [] }
        },
        {},
        {
          persistence,
          persisted: {
            ...defaultPersistedSnapshot(),
            additionalDirectories: change === "remove" ? [additional] : []
          }
        }
      );
      const mutation =
        change === "add" ? store.addDirectory(additional) : store.removeDirectory(additional);
      let quit: Promise<boolean> | undefined;
      try {
        await saving.promise;
        quit = store.prepareToQuit();
        const rejected = expect(quit).rejects.toThrow("final save unavailable");
        release.resolve();
        await mutation;
        await rejected;
        await vi.waitFor(() => expect(scanApplications).toHaveBeenCalledTimes(1));
        const scannedDirectories = scanApplications.mock.calls[0]?.[0];
        if (change === "add") expect(scannedDirectories).toContain(additional);
        else expect(scannedDirectories).not.toContain(additional);
        expect(fetchIndex).toHaveBeenCalledWith({ force: false });
        await vi.waitFor(async () => expect((await persistence.load()).apps).toEqual([app("2")]));
        expect(await store.prepareToQuit()).toBe(true);
      } finally {
        release.resolve();
        await Promise.allSettled([mutation, quit]);
        await store.refresh(true);
        await store.prepareToQuit();
      }
    }
  );

  it("preserves forced metadata checks when coalescing refresh requests during a failed quit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-quit-deferred-refresh-"));
    directories.push(directory);
    const persistence = new SnapshotPersistence(directory);
    const saving = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(persistence, "save").mockImplementationOnce(async () => {
      saving.resolve();
      await release.promise;
      throw new Error("final save unavailable");
    });
    const fetchIndex = vi.fn(async () => emptyHomebrewCaskIndex);
    const store = await makeStore(
      {
        homebrew: { fetchIndex, lookupUpdate: () => undefined, searchCasks: () => [] }
      },
      {},
      { persistence }
    );
    const quit = store.prepareToQuit();
    const rejected = expect(quit).rejects.toThrow("final save unavailable");
    try {
      await saving.promise;
      await store.refresh(true);
      await store.refresh(false, { forceMetadata: true, forceAppDiscovery: true });
      await store.refresh(true);
      expect(fetchIndex).not.toHaveBeenCalled();
      release.resolve();
      await rejected;
      await vi.waitFor(() => expect(fetchIndex).toHaveBeenCalledExactlyOnceWith({ force: true }));
      await vi.waitFor(() => expect(store.getSnapshot().isRefreshing).toBe(false));
      expect(await store.prepareToQuit()).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([quit, rejected]);
      await store.refresh(true);
      await store.prepareToQuit();
    }
  });

  it.each([false, true])(
    "retains interrupted source discovery and metadata strength (%s) with a joining refresh",
    async (forceMetadata) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-quit-interrupted-options-"));
      directories.push(directory);
      const persistence = new SnapshotPersistence(directory);
      vi.spyOn(persistence, "save").mockRejectedValueOnce(new Error("final save unavailable"));
      const oldScan = deferred<AppRecord[]>();
      const record = {
        ...app("2"),
        bundleIdentifier: "com.example.utility",
        sparkleFeedURL: "https://example.test/appcast.xml"
      };
      const now = new Date().toISOString();
      const scanApplications = vi
        .fn<() => Promise<AppRecord[]>>()
        .mockImplementationOnce(() => oldScan.promise)
        .mockResolvedValue([record]);
      const lookupOutcome = vi.fn(async () => ({ type: "completed" as const }));
      const fetchIndex = vi.fn(async () => emptyHomebrewCaskIndex);
      const store = await makeStore(
        {
          scanner: { scanApplications },
          appStore: { lookupOutcome },
          homebrew: { fetchIndex, lookupUpdate: () => undefined, searchCasks: () => [] }
        },
        {},
        {
          persistence,
          persisted: {
            ...defaultPersistedSnapshot(),
            appProviderChecks: {
              [record.id]: {
                fingerprint: appProviderFingerprint(record),
                storefront: "us",
                status: "checked",
                source: "sparkle",
                sparkleFeedURL: record.sparkleFeedURL,
                checkedAt: now,
                discoveryCheckedAt: now
              }
            }
          }
        }
      );
      const refresh = store.refresh(false, { forceMetadata, forceAppDiscovery: true });
      const joining = store.refresh(true);
      let quit: Promise<boolean> | undefined;
      try {
        await new Promise((resolve) => setImmediate(resolve));
        quit = store.prepareToQuit();
        const rejected = expect(quit).rejects.toThrow("final save unavailable");
        oldScan.resolve([record]);
        await rejected;
        await vi.waitFor(() => expect(scanApplications).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(store.getSnapshot().isRefreshing).toBe(false));
        expect(lookupOutcome).toHaveBeenCalledTimes(1);
        expect(lookupOutcome).toHaveBeenCalledWith(
          record.bundleIdentifier,
          record.localVersion,
          expect.objectContaining({ force: true })
        );
        expect(fetchIndex).toHaveBeenLastCalledWith({ force: forceMetadata });
        expect(await store.prepareToQuit()).toBe(true);
      } finally {
        oldScan.resolve([]);
        await Promise.allSettled([refresh, joining, quit]);
        await store.refresh(true);
        await store.prepareToQuit();
      }
    }
  );
});
