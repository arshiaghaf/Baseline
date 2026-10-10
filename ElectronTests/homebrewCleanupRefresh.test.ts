// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type AppRecord,
  type HomebrewManagedItem
} from "../src/shared/domain";
import { version } from "../src/shared/version";
const directories: string[] = [];
const releaseGates: (() => void)[] = [];
const pendingOperations: Promise<unknown>[] = [];
const persistences: SnapshotPersistence[] = [];
let activeDrain: Promise<void> | undefined;
let testSignal: AbortSignal;
beforeEach(({ signal }) => {
  testSignal = signal;
});

function track<T>(operation: Promise<T>): Promise<T> {
  // Attach a rejection handler immediately, including for operations that are
  // never reached again after an assertion fails. Drain still reports failures.
  void operation.catch(() => undefined);
  pendingOperations.push(operation);
  return operation;
}

async function drain() {
  // A timeout can unwind the test's finally while afterEach has already begun.
  // Both must await the same work before either can remove fixture directories.
  if (activeDrain) return activeDrain;
  const task = settleFixtureOperations();
  activeDrain = task;
  try {
    await task;
  } finally {
    activeDrain = undefined;
  }
}

async function settleFixtureOperations() {
  for (const release of releaseGates.splice(0)) release();
  const results = await Promise.allSettled(pendingOperations.splice(0));
  // After producers settle, load waits for persistence's current save queue.
  const writes = await Promise.allSettled(persistences.splice(0).map((p) => p.load()));
  const errors = [...results, ...writes].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (errors.length) throw new AggregateError(errors, "Cleanup fixture operations failed");
}

afterEach(async () => {
  try {
    // Gates, commands, lookups, refreshes and persistence must settle even when
    // an assertion fails before the test's normal release/await sequence.
    await drain();
  } finally {
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
  }
});
const item: HomebrewManagedItem = {
  id: "formula:unused-tool",
  token: "unused-tool",
  name: "unused-tool",
  kind: "formula",
  formulaIdentity: {
    name: "unused-tool",
    fullName: "unused-tool",
    tap: "homebrew/core",
    oldNames: []
  },
  formulaIdentityVerified: true,
  installedVersion: version("1"),
  latestVersion: version("2"),
  isOutdated: true
};
const app: AppRecord = {
  id: "/Applications/Example.app",
  bundlePath: "/Applications/Example.app",
  displayName: "Example",
  bundleIdentifier: "com.example.app",
  localVersion: version("1"),
  sourceHint: "unknown"
};
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function operationGate<T = void>(teardownValue?: T) {
  const pending = deferred<T>();
  releaseGates.push(() => pending.resolve(teardownValue as T));
  return pending;
}
function observation(signal = testSignal) {
  const observed = deferred();
  const cancel = () => observed.reject(signal.reason);
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  const promise = observed.promise.finally(() => signal.removeEventListener("abort", cancel));
  // An observation can be interrupted before the test reaches its await.
  void promise.catch(() => undefined);
  return {
    promise,
    resolve: () => {
      // A real event during teardown must not resume a timed-out test body.
      if (signal.aborted) cancel();
      else observed.resolve();
    }
  };
}
function observeRefreshRequests(store: UpdateStore, expectedCalls = 1, signal = testSignal) {
  const requested = observation(signal);
  const refresh = store.refresh.bind(store);
  let calls = 0;
  const spy = vi.spyOn(store, "refresh").mockImplementation((...args) => {
    const operation = refresh(...args);
    if (++calls === expectedCalls) requested.resolve();
    return operation;
  });
  return { spy, requested: requested.promise };
}

async function fixture(options: Partial<ConstructorParameters<typeof UpdateStore>[0]> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-cleanup-refresh-"));
  directories.push(dir);
  const persistence = options.persistence ?? new SnapshotPersistence(dir);
  persistences.push(persistence);
  return new UpdateStore({
    persistence,
    persisted: { ...defaultPersistedSnapshot(), homebrewItems: [item] },
    openExternalURL: async () => true,
    openAppBundle: async () => undefined,
    runBrewCommand: async () => ({ success: true, status: 0, output: "" }),
    runMasCommand: async () => ({ success: true, status: 0, output: "" }),
    profileStatsIntegrity: {
      verifyOrInitialize: async (s) => ({ ...s, integrityStatus: "verified" }),
      seal: async (s) => ({ ...s, signature: "fixture" })
    },
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
          outdatedDetectionSucceededByKind: { formula: true, cask: true },
          inventoryReadSucceededByKind: { formula: true, cask: true }
        })
      },
      ...options.clients
    }
  });
}
describe("Homebrew cleanup inventory barrier", () => {
  it.each(
    ["add", "remove", "mas"].flatMap((mutation) =>
      ["success", "command failure", "scan failure"].map((outcome) => [mutation, outcome])
    )
  )("rescans after %s during cleanup with %s", async (mutation, outcome) => {
    const scanGate = operationGate();
    const extraDirectory = "/tmp/example-extra-applications";
    let installedApp = app;
    const scans: string[][] = [];
    const scanner = {
      scanApplications: vi.fn(async (paths: string[]) => {
        scans.push([...paths]);
        const found = mutation === "mas" || paths.includes(extraDirectory) ? [installedApp] : [];
        if (scans.length === 1) {
          await scanGate.promise;
          if (outcome === "scan failure") throw new Error("Synthetic cleanup scan failure");
        }
        return found;
      })
    };
    const store = await fixture({
      persisted: {
        ...defaultPersistedSnapshot(),
        additionalDirectories: mutation === "remove" ? [extraDirectory] : [],
        apps: [app],
        updates: [
          {
            id: app.id,
            appID: app.id,
            source: "appStore",
            supportLevel: "supported",
            localVersion: app.localVersion,
            remoteVersion: version("2"),
            appStoreItemID: 123,
            checkedAt: new Date().toISOString()
          }
        ]
      },
      runBrewCommand: async (args) => ({
        success: args[0] !== "cleanup" || outcome !== "command failure",
        status: args[0] === "cleanup" && outcome === "command failure" ? 1 : 0,
        output: ""
      }),
      runMasCommand: async (args) => {
        if (args[0] === "upgrade") installedApp = { ...app, localVersion: version("2") };
        return { success: true, status: 0, output: "" };
      },
      clients: {
        scanner,
        appStore: {
          lookupOutcome: async (_identifier, localVersion) => ({
            type: "completed",
            ...(localVersion.raw === "1"
              ? {
                  value: {
                    remoteVersion: version("2"),
                    appStoreItemID: 123,
                    updateURL: "https://apps.apple.com/app/example"
                  }
                }
              : {})
          })
        }
      }
    });
    const refreshRequests = observeRefreshRequests(store);
    await store.refreshToolStatus();
    const cleanup = track(store.cleanUpHomebrew(async () => true));
    await vi.waitFor(() => expect(scanner.scanApplications).toHaveBeenCalledTimes(1));
    const changed = track(
      mutation === "add"
        ? store.addDirectory(extraDirectory)
        : mutation === "remove"
          ? store.removeDirectory(extraDirectory)
          : store.performAppUpdate(app.id)
    );
    if (mutation === "mas") {
      await vi.waitFor(() => expect(installedApp.localVersion).toEqual(version("2")));
    } else {
      await vi.waitFor(() =>
        expect(store.getSnapshot().additionalDirectories.includes(extraDirectory)).toBe(
          mutation === "add"
        )
      );
    }
    // Snapshot publication precedes persistence. Wait for the real refresh
    // request after persistence/update completion, while cleanup's scan is held.
    await refreshRequests.requested;
    expect(refreshRequests.spy).toHaveBeenCalledWith(false, { forceMetadata: false });
    expect(scanner.scanApplications).toHaveBeenCalledTimes(1);
    scanGate.resolve();
    await Promise.all([cleanup, changed]);
    expect(scans.length).toBeGreaterThanOrEqual(2);
    expect(scans.at(-1)?.includes(extraDirectory)).toBe(mutation === "add");
    expect(store.getSnapshot().isHomebrewCommandLocked).toBe(false);
    if (mutation === "remove") {
      expect(store.getSnapshot().apps).toEqual([]);
    } else {
      expect(store.getSnapshot().apps[0]?.localVersion).toEqual(
        version(mutation === "mas" ? "2" : "1")
      );
    }
    if (mutation === "mas") {
      expect(store.getSnapshot().updates).toEqual([]);
      expect(store.getSnapshot().appUpdatingIDs).toEqual([]);
      expect(store.getSnapshot().appUpdatedPendingRefreshIDs).toEqual([]);
    }
  });

  it.each(["completion", "assertion failure", "cancelled observation"])(
    "settles cleanup and a delayed directory save after %s",
    async (exit) => {
      const scanGate = operationGate();
      const scanStarted = observation();
      const saveGate = operationGate();
      const saveStarted = observation();
      const extraDirectory = "/tmp/example-delayed-applications";
      const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-cleanup-delayed-save-"));
      directories.push(dir);
      const persistence = new SnapshotPersistence(dir);
      const scanner = {
        scanApplications: vi.fn(async (paths: string[]) => {
          if (scanner.scanApplications.mock.calls.length === 1) {
            scanStarted.resolve();
            await scanGate.promise;
          }
          return paths.includes(extraDirectory) ? [app] : [];
        })
      };
      const store = await fixture({ persistence, clients: { scanner } });
      await store.refreshToolStatus();
      const save = persistence.save.bind(persistence);
      let delayed = false;
      vi.spyOn(persistence, "save").mockImplementation(async (snapshot) => {
        if (!delayed && snapshot.additionalDirectories.includes(extraDirectory)) {
          delayed = true;
          saveStarted.resolve();
          await saveGate.promise;
        }
        await save(snapshot);
      });
      const cancelled = new Error("Synthetic missing-refresh cancellation");
      const controller = new AbortController();
      const refreshRequests = observeRefreshRequests(
        store,
        1,
        exit === "cancelled observation" ? controller.signal : testSignal
      );
      const cleanup = track(store.cleanUpHomebrew(async () => true));
      await scanStarted.promise;
      const changed = track(store.addDirectory(extraDirectory));
      await saveStarted.promise;

      const finish = async () => {
        try {
          // Published state alone does not mean the save has completed or that
          // the full refresh has joined cleanup's barrier.
          expect(store.getSnapshot().additionalDirectories).toEqual([extraDirectory]);
          expect(refreshRequests.spy).not.toHaveBeenCalled();
          expect(scanner.scanApplications).toHaveBeenCalledTimes(1);
          if (exit === "assertion failure") {
            // Interrupt the normal release sequence with a real assertion.
            expect(store.getSnapshot().isCleaningUpHomebrew).toBe(false);
          }
          saveGate.resolve();
          await refreshRequests.requested;
          expect(refreshRequests.spy).toHaveBeenCalledWith(false, { forceMetadata: false });
          expect(scanner.scanApplications).toHaveBeenCalledTimes(1);
          scanGate.resolve();
          await Promise.all([cleanup, changed]);
        } finally {
          // This is the same drain used before fixture teardown in afterEach.
          await drain();
        }
      };
      if (exit === "assertion failure") {
        await expect(finish()).rejects.toThrow("expected true to be false");
      } else if (exit === "cancelled observation") {
        const pending = finish();
        // Model a timed-out wait while persistence still prevents the expected
        // refresh. Draining will produce that event later; it must stay rejected.
        controller.abort(cancelled);
        await expect(pending).rejects.toBe(cancelled);
      } else {
        await finish();
      }
      // The refresh does happen during the cancellation drain, without turning
      // the cancelled observation into a successful continuation.
      expect(refreshRequests.spy).toHaveBeenCalledWith(false, { forceMetadata: false });
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(false);
      expect(store.getSnapshot().isRefreshing).toBe(false);
      const saved = await persistence.load();
      expect(saved.additionalDirectories).toEqual([extraDirectory]);
      expect(saved.apps.map((candidate) => candidate.id)).toEqual([app.id]);
      const restarted = await fixture({ persisted: saved });
      expect(restarted.getSnapshot().additionalDirectories).toEqual([extraDirectory]);
      expect(restarted.getSnapshot().apps.map((candidate) => candidate.id)).toEqual([app.id]);
    }
  );

  it("keeps the final directories after repeated mutations while lightweight callers join cleanup", async () => {
    const gate = operationGate();
    const first = "/tmp/example-first-applications";
    const second = "/tmp/example-second-applications";
    const scans: string[][] = [];
    const scanner = {
      scanApplications: vi.fn(async (paths: string[]) => {
        scans.push([...paths]);
        if (scans.length === 1) await gate.promise;
        return paths.includes(second) ? [app] : [];
      })
    };
    const store = await fixture({ clients: { scanner } });
    const refreshRequests = observeRefreshRequests(store, 4);
    await store.refreshToolStatus();
    const cleanup = track(store.cleanUpHomebrew(async () => true));
    await vi.waitFor(() => expect(scanner.scanApplications).toHaveBeenCalledTimes(1));
    const lightweight = track(store.refresh(true));
    const addFirst = track(store.addDirectory(first));
    const addSecond = track(store.addDirectory(second));
    const removeFirst = track(store.removeDirectory(first));
    await vi.waitFor(() => expect(store.getSnapshot().additionalDirectories).toEqual([second]));
    await refreshRequests.requested;
    expect(refreshRequests.spy).toHaveBeenCalledTimes(4);
    gate.resolve();
    await Promise.all([cleanup, lightweight, addFirst, addSecond, removeFirst]);
    expect(scans.at(-1)).toContain(second);
    expect(scans.at(-1)).not.toContain(first);
    expect(store.getSnapshot().apps.map((candidate) => candidate.id)).toEqual([app.id]);
  });

  it("preserves verified formula actions and the warning when cask identity is unavailable", async () => {
    const cask: HomebrewManagedItem = {
      id: "cask:example-unverified",
      token: "example-unverified",
      name: "Example unverified cask",
      kind: "cask",
      installedVersion: version("1"),
      isOutdated: false
    };
    const runBrewCommand = vi.fn<
      NonNullable<ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"]>
    >(async () => ({
      success: true,
      status: 0,
      output: ""
    }));
    const store = await fixture({
      runBrewCommand,
      clients: {
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [item, cask],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true },
            inventoryReadSucceededByKind: { formula: true, cask: true },
            warning: "Installed cask identity could not be verified."
          })
        }
      }
    });
    await store.refreshToolStatus();
    expect(await store.cleanUpHomebrew(async () => true)).toBe("Homebrew cleanup completed.");
    await store.refresh();
    await store.refresh();
    expect(
      store.getSnapshot().homebrewItems.find((candidate) => candidate.id === item.id)
    ).toMatchObject({ isOutdated: true, latestVersion: version("2") });
    expect(store.getSnapshot().lastRefreshNoticeMessage).toContain("cask identity");
    await store.performHomebrewUpdate(cask.id);
    await store.performHomebrewUpdate(item.id);
    await store.performHomebrewUpdateAll();
    expect(runBrewCommand.mock.calls.map(([args]) => args)).toEqual([
      ["--version"],
      ["cleanup"],
      ["upgrade", item.token],
      ["update"],
      ["upgrade", item.token]
    ]);
  });

  it.each(["formula membership", "cask membership", "formula outdated", "cask outdated"])(
    "still rejects incomplete %s despite an unrelated cask warning",
    async (failure) => {
      const store = await fixture({
        clients: {
          homebrewInventory: {
            fetchInventory: async () => ({
              items: [item],
              outdatedDetectionSucceeded: !failure.endsWith("outdated"),
              outdatedDetectionSucceededByKind: {
                formula: failure !== "formula outdated",
                cask: failure !== "cask outdated"
              },
              inventoryReadSucceededByKind: {
                formula: failure !== "formula membership",
                cask: failure !== "cask membership"
              },
              warning: "Installed cask identity could not be verified."
            })
          }
        }
      });
      await store.refreshToolStatus();
      expect(await store.cleanUpHomebrew(async () => true)).toContain("could not be refreshed");
      expect(store.getSnapshot().homebrewItems[0]?.isOutdated).toBe(false);
    }
  );

  it("drops a removed dependency from queued updates when no refresh supersedes cleanup", async () => {
    const commandGate = operationGate();
    const runBrewCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "cleanup") await commandGate.promise;
      return { success: true, status: 0, output: "" };
    });
    const store = await fixture({ runBrewCommand });
    await store.refreshToolStatus();
    const cleanup = track(store.cleanUpHomebrew(async () => true));
    await vi.waitFor(() =>
      expect(runBrewCommand).toHaveBeenCalledWith(["cleanup"], expect.any(Function))
    );
    const queued = track(store.performHomebrewUpdate(item.id));
    commandGate.resolve();
    await cleanup;
    await queued;
    expect(store.getSnapshot().homebrewItems).toEqual([]);
    expect(runBrewCommand.mock.calls.map(([args]) => args)).toEqual([["--version"], ["cleanup"]]);
  });
  it("reports real refresh failure without mocking the refresh method", async () => {
    const store = await fixture({
      clients: {
        homebrewInventory: {
          fetchInventory: async () => {
            throw new Error("Synthetic inventory read failure");
          }
        }
      }
    });
    await store.refreshToolStatus();
    const message = await store.cleanUpHomebrew(async () => true);
    expect(store.getSnapshot().refreshErrorMessage).toBe("Synthetic inventory read failure");
    expect(store.getSnapshot().isHomebrewCommandLocked).toBe(false);
    expect(message).toContain("Installed packages could not be refreshed");
  });
  it("keeps post-cleanup inventory when a full refresh supersedes cleanup's own lightweight refresh", async () => {
    const inventoryGate = operationGate();
    const fetchInventory = vi.fn(async () => {
      await inventoryGate.promise;
      return {
        items: [],
        outdatedDetectionSucceeded: true,
        outdatedDetectionSucceededByKind: { formula: true, cask: true },
        inventoryReadSucceededByKind: { formula: true, cask: true }
      };
    });
    const store = await fixture({ clients: { homebrewInventory: { fetchInventory } } });
    await store.refreshToolStatus();
    const cleanup = track(store.cleanUpHomebrew(async () => true));
    await vi.waitFor(() => expect(fetchInventory).toHaveBeenCalledTimes(1));
    const competingRefresh = track(store.refresh(false));
    inventoryGate.resolve();
    await cleanup;
    await competingRefresh;
    expect(store.getSnapshot().homebrewItems).toEqual([]);
  });
  it("reports unsuccessful inventory reads that preserve stale membership", async () => {
    const store = await fixture({
      clients: {
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [],
            outdatedDetectionSucceeded: false,
            outdatedDetectionSucceededByKind: { formula: false, cask: true },
            inventoryReadSucceededByKind: { formula: false, cask: true },
            warning: "Homebrew installed packages could not be read reliably."
          })
        }
      }
    });
    await store.refreshToolStatus();
    const message = await store.cleanUpHomebrew(async () => true);
    expect(store.getSnapshot().homebrewItems.map((i) => i.id)).toContain(item.id);
    expect(store.getSnapshot().lastRefreshNoticeMessage).toContain("could not be read");
    expect(message).toContain("Installed packages could not be refreshed");
  });
  it.each(
    ["appStore", "sparkle"].flatMap((provider) =>
      [false, true].map((queueUpdate) => ({ provider, queueUpdate }))
    )
  )(
    "takes a fresh post-cleanup inventory during a pending $provider lookup (queued update: $queueUpdate)",
    async ({ provider, queueUpdate }) => {
      const firstLookup = operationGate();
      const secondLookup = operationGate();
      let installed = [item];
      let includeApp = false;
      const fetchInventory = vi.fn(async () => ({
        items: [...installed],
        outdatedDetectionSucceeded: true,
        outdatedDetectionSucceededByKind: { formula: true, cask: true },
        inventoryReadSucceededByKind: { formula: true, cask: true }
      }));
      const lookupOutcome = vi
        .fn()
        .mockImplementationOnce(async () => {
          await firstLookup.promise;
          return { type: "completed" };
        })
        .mockImplementationOnce(async () => {
          await secondLookup.promise;
          return { type: "completed" };
        })
        .mockImplementation(async () => ({ type: "completed" }));
      const runBrewCommand = vi.fn(async (args: string[]) => {
        if (args[0] === "cleanup") installed = [];
        return { success: true, status: 0, output: "" };
      });
      const store = await fixture({
        runBrewCommand,
        clients: {
          scanner: {
            scanApplications: async () =>
              includeApp ? [{ ...app, sparkleFeedURL: "https://example.com/feed.xml" }] : []
          },
          [provider]: { lookupOutcome },
          homebrewInventory: { fetchInventory }
        }
      });
      await store.refreshToolStatus();
      await store.refresh(true);
      includeApp = true;
      const firstRefresh = track(store.refresh(false));
      await vi.waitFor(() => expect(lookupOutcome).toHaveBeenCalledTimes(1));
      expect(store.getSnapshot().isHomebrewCleanupLocked).toBe(false);
      const cleanup = track(store.cleanUpHomebrew(async () => true));
      await vi.waitFor(() =>
        expect(runBrewCommand).toHaveBeenCalledWith(["cleanup"], expect.any(Function))
      );
      const secondRefresh = track(store.refresh(false));
      await vi.waitFor(() => expect(lookupOutcome).toHaveBeenCalledTimes(2));
      const queued = queueUpdate ? track(store.performHomebrewUpdate(item.id)) : undefined;
      if (queueUpdate) expect(store.getSnapshot().homebrewQueuedItemIDs).toContain(item.id);
      expect(runBrewCommand.mock.calls.map(([args]) => args)).toEqual([["--version"], ["cleanup"]]);
      secondLookup.resolve();
      await secondRefresh;
      await cleanup;
      firstLookup.resolve();
      await firstRefresh;
      if (queued) {
        await queued;
        expect(runBrewCommand.mock.calls.map(([args]) => args)).toEqual([
          ["--version"],
          ["cleanup"]
        ]);
        return;
      }
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(false);
      expect(store.getSnapshot().homebrewItems).toEqual([]);
    }
  );
  it.each(["throw", "membership", "outdated", "scanner"])(
    "cancels stale queued upgrades after %s failure and revalidates after recovery",
    async (failure) => {
      const commandGate = operationGate();
      let recovered = false;
      const runBrewCommand = vi.fn(async (args: string[]) => {
        if (args[0] === "cleanup") await commandGate.promise;
        return { success: true, status: 0, output: "" };
      });
      const store = await fixture({
        runBrewCommand,
        clients: {
          scanner: {
            scanApplications: async () => {
              if (!recovered && failure === "scanner") throw new Error("Synthetic scanner failure");
              return [];
            }
          },
          homebrewInventory: {
            fetchInventory: async () => {
              if (!recovered && failure === "throw") throw new Error("Synthetic read failure");
              return {
                items: [item],
                outdatedDetectionSucceeded: recovered || failure !== "outdated",
                outdatedDetectionSucceededByKind: {
                  formula: recovered || failure !== "outdated",
                  cask: true
                },
                inventoryReadSucceededByKind: {
                  formula: recovered || failure !== "membership",
                  cask: true
                }
              };
            }
          }
        }
      });
      await store.refreshToolStatus();
      const cleanup = track(store.cleanUpHomebrew(async () => true));
      await vi.waitFor(() =>
        expect(runBrewCommand).toHaveBeenCalledWith(["cleanup"], expect.any(Function))
      );
      const queued = track(store.performHomebrewUpdate(item.id));
      commandGate.resolve();
      expect(await cleanup).toContain("Installed packages could not be refreshed");
      await queued;
      expect(store.getSnapshot().homebrewQueuedItemIDs).toEqual([]);
      expect(store.getSnapshot().homebrewUpdatingItemIDs).toEqual([]);
      expect(store.getSnapshot().homebrewItems[0]?.isOutdated).toBe(false);
      await store.performHomebrewUpdate(item.id);
      expect(runBrewCommand.mock.calls.map(([args]) => args)).toEqual([["--version"], ["cleanup"]]);
      await store.refresh();
      expect(store.getSnapshot().homebrewItems[0]?.isOutdated).toBe(false);
      recovered = true;
      await store.refresh();
      expect(store.getSnapshot().homebrewItems[0]?.isOutdated).toBe(true);
      await store.performHomebrewUpdate(item.id);
      expect(runBrewCommand.mock.calls.some(([args]) => args[0] === "upgrade")).toBe(true);
    }
  );

  it("persists invalidated targets after repeated partial reads", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-cleanup-persistence-"));
    directories.push(dir);
    const persistence = new SnapshotPersistence(dir);
    const store = await fixture({
      persistence,
      clients: {
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [item],
            outdatedDetectionSucceeded: false,
            outdatedDetectionSucceededByKind: { formula: false, cask: true },
            inventoryReadSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });
    await store.refreshToolStatus();
    await store.cleanUpHomebrew(async () => true);
    await store.refresh();
    const persisted = await persistence.load();
    expect(persisted.homebrewItems[0]?.isOutdated).toBe(false);
    expect(persisted.homebrewItems[0]?.latestVersion).toBeUndefined();
    const restarted = await fixture({ persisted });
    expect(restarted.getSnapshot().homebrewItems[0]?.isOutdated).toBe(false);
  });
  it("defers a full refresh through cleanup execution and the fresh inventory commit", async () => {
    const commandGate = operationGate();
    let includeApp = false;
    let installed = [item];
    const obsoleteLookup = operationGate();
    const runBrewCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "cleanup") {
        await commandGate.promise;
        installed = [];
      }
      return { success: true, status: 0, output: "" };
    });
    const lookupOutcome = vi
      .fn()
      .mockImplementationOnce(async () => {
        await obsoleteLookup.promise;
        return { type: "completed" };
      })
      .mockImplementation(async () => ({ type: "completed" }));
    const fetchInventory = vi.fn(async () => ({
      items: [...installed],
      outdatedDetectionSucceeded: true,
      outdatedDetectionSucceededByKind: { formula: true, cask: true },
      inventoryReadSucceededByKind: { formula: true, cask: true }
    }));
    const store = await fixture({
      runBrewCommand,
      clients: {
        scanner: { scanApplications: async () => (includeApp ? [app] : []) },
        appStore: { lookupOutcome },
        homebrewInventory: { fetchInventory }
      }
    });
    await store.refreshToolStatus();
    await store.refresh(true);
    includeApp = true;
    const cleanup = track(store.cleanUpHomebrew(async () => true));
    await vi.waitFor(() =>
      expect(runBrewCommand).toHaveBeenCalledWith(["cleanup"], expect.any(Function))
    );
    const obsolete = track(store.refresh());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(lookupOutcome).not.toHaveBeenCalled();
    const queued = track(store.performHomebrewUpdate(item.id));
    expect(store.getSnapshot().homebrewQueuedItemIDs).toContain(item.id);
    commandGate.resolve();
    await vi.waitFor(() => expect(lookupOutcome).toHaveBeenCalledTimes(1));
    expect(store.getSnapshot().homebrewQueuedItemIDs).toContain(item.id);
    obsoleteLookup.resolve();
    expect(await cleanup).toBe("Homebrew cleanup completed.");
    await queued;
    expect(store.getSnapshot().homebrewItems).toEqual([]);
    await obsolete;
    expect(lookupOutcome).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().homebrewItems).toEqual([]);
    expect(runBrewCommand.mock.calls.map(([args]) => args)).toEqual([["--version"], ["cleanup"]]);
  });
  it("refuses cleanup during an active inventory read without opening confirmation", async () => {
    const gate = operationGate();
    const fetchInventory = vi.fn(async () => {
      await gate.promise;
      return {
        items: [],
        outdatedDetectionSucceeded: true,
        outdatedDetectionSucceededByKind: { formula: true, cask: true },
        inventoryReadSucceededByKind: { formula: true, cask: true }
      };
    });
    const runBrewCommand = vi.fn(async () => ({ success: true, status: 0, output: "" }));
    const store = await fixture({
      runBrewCommand,
      clients: { homebrewInventory: { fetchInventory } }
    });
    await store.refreshToolStatus();
    runBrewCommand.mockClear();
    const publishedLocks: boolean[] = [];
    store.on("snapshot", (snapshot) => publishedLocks.push(snapshot.isHomebrewCleanupLocked));
    const refresh = track(store.refresh(true));
    await vi.waitFor(() => expect(fetchInventory).toHaveBeenCalledTimes(1));
    const confirm = vi.fn(async () => true);
    try {
      expect(store.getSnapshot().isHomebrewCleanupLocked).toBe(true);
      expect(await store.cleanUpHomebrew(confirm)).toContain("busy");
      expect(confirm).not.toHaveBeenCalled();
      expect(runBrewCommand).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await refresh;
    }
    expect(store.getSnapshot().isHomebrewCleanupLocked).toBe(false);
    expect(publishedLocks).toContain(true);
    expect(publishedLocks.at(-1)).toBe(false);
    expect(await store.cleanUpHomebrew(confirm)).toBe("Homebrew cleanup completed.");
  });

  it("refuses cleanup during an active upgrade without opening confirmation", async () => {
    const gate = operationGate();
    const runBrewCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "upgrade") await gate.promise;
      return { success: true, status: 0, output: "" };
    });
    const store = await fixture({
      runBrewCommand,
      clients: {
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [item],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true },
            inventoryReadSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });
    await store.refreshToolStatus();
    await store.refresh(true);
    runBrewCommand.mockClear();
    const update = track(store.performHomebrewUpdate(item.id));
    await vi.waitFor(() =>
      expect(runBrewCommand).toHaveBeenCalledWith(["upgrade", "unused-tool"], expect.any(Function))
    );
    const confirm = vi.fn(async () => true);
    try {
      expect(store.getSnapshot().isHomebrewCleanupLocked).toBe(true);
      expect(await store.cleanUpHomebrew(confirm)).toContain("busy");
      expect(confirm).not.toHaveBeenCalled();
      expect(runBrewCommand.mock.calls.map(([args]) => args)).toEqual([["upgrade", "unused-tool"]]);
    } finally {
      gate.resolve();
      await update;
    }
  });
  it("keeps superseded full-refresh waiters pending until the winning scan commits", async () => {
    const cleanupScan = operationGate();
    const firstScan = operationGate();
    const winningScan = operationGate();
    let scans = 0;
    const scanner = {
      scanApplications: vi.fn(async () => {
        const scan = ++scans;
        if (scan === 1) await cleanupScan.promise;
        if (scan === 2) await firstScan.promise;
        if (scan === 3) await winningScan.promise;
        return scan === 3 ? [{ ...app, localVersion: version("2") }] : [];
      })
    };
    const store = await fixture({ clients: { scanner } });
    await store.refreshToolStatus();
    const cleanup = track(store.cleanUpHomebrew(async () => true));
    await vi.waitFor(() => expect(scans).toBe(1));
    let firstResolved = false;
    const first = track(
      store.refresh(false).then(() => {
        firstResolved = true;
      })
    );
    const second = track(store.refresh(false));
    cleanupScan.resolve();
    await vi.waitFor(() => expect(scans).toBe(3));
    firstScan.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      expect(firstResolved).toBe(false);
      expect(store.getSnapshot().isRefreshing).toBe(true);
    } finally {
      winningScan.resolve();
      await Promise.all([cleanup, first, second]);
    }
    expect(store.getSnapshot().apps[0]?.localVersion).toEqual(version("2"));
  });

  it("publishes pending cleanup and its result without persisting runtime feedback", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-cleanup-feedback-"));
    directories.push(dir);
    const persistence = new SnapshotPersistence(dir);
    const gate = operationGate();
    const store = await fixture({
      persistence,
      runBrewCommand: async (args) => {
        if (args[0] === "cleanup") await gate.promise;
        return {
          success: args[0] !== "cleanup",
          status: args[0] === "cleanup" ? 1 : 0,
          output: "Synthetic failure"
        };
      }
    });
    // Availability is independently set by the tool-status probe.
    await store.refreshToolStatus();
    const cleanup = track(store.cleanUpHomebrew(async () => true));
    await vi.waitFor(() => expect(store.getSnapshot().isCleaningUpHomebrew).toBe(true));
    expect(store.getSnapshot().homebrewCleanupMessage).toBeUndefined();
    gate.resolve();
    const message = await cleanup;
    expect(message).toContain("did not complete");
    expect(store.getSnapshot().homebrewCleanupMessage).toBe(message);
    expect(store.getSnapshot().isCleaningUpHomebrew).toBe(false);
    const saved = await persistence.load();
    expect(saved).not.toHaveProperty("isCleaningUpHomebrew");
    expect(saved).not.toHaveProperty("homebrewCleanupMessage");
    const restarted = await fixture({ persisted: saved });
    expect(restarted.getSnapshot().isCleaningUpHomebrew).toBe(false);
    expect(restarted.getSnapshot().homebrewCleanupMessage).toBeUndefined();
  });

  it.each(
    ["formula", "cask"].flatMap((kind) =>
      ["cancel", "confirmation error", "membership failure"].map((outcome) => ({ kind, outcome }))
    )
  )(
    "keeps $kind upgrades excluded after $outcome and superseded pin observations",
    async ({ kind, outcome }) => {
      const target: HomebrewManagedItem =
        kind === "formula"
          ? item
          : {
              ...item,
              id: "cask:unused-tool",
              kind: "cask",
              fullToken: "unused-tool",
              tap: "homebrew/cask",
              formulaIdentity: undefined
            };
      let reads = 0;
      let includeApp = false;
      let pinned = false;
      const lookupGate = operationGate();
      const confirmGate = operationGate(false);
      const lookupOutcome = vi
        .fn()
        .mockImplementationOnce(async () => {
          await lookupGate.promise;
          return { type: "completed" };
        })
        .mockResolvedValue({ type: "completed" });
      const runBrewCommand = vi.fn(async (args: string[]) => ({
        success: true,
        status: 0,
        output: args.join(" ")
      }));
      const store = await fixture({
        runBrewCommand,
        clients: {
          scanner: { scanApplications: async () => (includeApp ? [app] : []) },
          appStore: { lookupOutcome },
          homebrewInventory: {
            fetchInventory: async () => {
              const complete = ++reads < 3 || outcome !== "membership failure";
              return {
                items: [{ ...target, pinned }],
                outdatedDetectionSucceeded: complete,
                outdatedDetectionSucceededByKind: { formula: true, cask: true },
                inventoryReadSucceededByKind: { formula: complete, cask: complete }
              };
            }
          }
        }
      });
      await store.refreshToolStatus();
      await store.refresh(true);
      pinned = true;
      includeApp = true;
      const old = track(store.refresh(false));
      await vi.waitFor(() => expect(lookupOutcome).toHaveBeenCalledTimes(1));
      const cleanup = track(
        store
          .cleanUpHomebrew(async () => {
            await confirmGate.promise;
            if (outcome === "confirmation error") throw new Error("Synthetic confirmation failure");
            return false;
          })
          .catch((error: unknown) => error)
      );
      const queued = track(store.performHomebrewUpdate(target.id));
      expect(store.getSnapshot().homebrewQueuedItemIDs).toContain(target.id);
      const next = track(store.refresh(false));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      confirmGate.resolve(false);
      const result = await cleanup;
      await Promise.all([next, queued]);
      if (outcome === "confirmation error") {
        expect(result).toBeInstanceOf(Error);
        expect(store.getSnapshot().homebrewCleanupMessage).toContain("could not run");
      } else if (outcome === "membership failure") {
        expect(result).toContain("Installed packages could not be refreshed");
        expect(store.getSnapshot().homebrewItems[0]?.isOutdated).toBe(false);
      } else {
        expect(result).toBe("");
        expect(store.getSnapshot().homebrewItems[0]?.pinned).toBe(true);
      }
      expect(store.getSnapshot().isCleaningUpHomebrew).toBe(false);
      lookupGate.resolve();
      await old;
      expect(runBrewCommand.mock.calls.filter(([args]) => args[0] === "upgrade")).toEqual([]);
    }
  );
});
