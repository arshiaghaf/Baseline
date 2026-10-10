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
  type HomebrewManagedItem
} from "../src/shared/domain";
import { version } from "../src/shared/version";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(options: Partial<ConstructorParameters<typeof UpdateStore>[0]> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-cleanup-refresh-"));
  directories.push(dir);
  return new UpdateStore({
    persistence: new SnapshotPersistence(dir),
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
    const scanGate = deferred<void>();
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
    const refreshRequested = vi.spyOn(store, "refresh");
    await store.refreshToolStatus();
    const cleanup = store.cleanUpHomebrew(async () => true);
    await vi.waitFor(() => expect(scanner.scanApplications).toHaveBeenCalledTimes(1));
    const changed =
      mutation === "add"
        ? store.addDirectory(extraDirectory)
        : mutation === "remove"
          ? store.removeDirectory(extraDirectory)
          : store.performAppUpdate(app.id);
    if (mutation === "mas") {
      await vi.waitFor(() => expect(installedApp.localVersion).toEqual(version("2")));
    } else {
      await vi.waitFor(() =>
        expect(store.getSnapshot().additionalDirectories.includes(extraDirectory)).toBe(
          mutation === "add"
        )
      );
    }
    // The mutation has persisted or completed; its full refresh must wait.
    await vi.waitFor(() =>
      expect(refreshRequested).toHaveBeenCalledWith(false, { forceMetadata: false })
    );
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

  it("keeps the final directories after repeated mutations while lightweight callers join cleanup", async () => {
    const gate = deferred<void>();
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
    const refreshRequested = vi.spyOn(store, "refresh");
    await store.refreshToolStatus();
    const cleanup = store.cleanUpHomebrew(async () => true);
    await vi.waitFor(() => expect(scanner.scanApplications).toHaveBeenCalledTimes(1));
    const lightweight = store.refresh(true);
    const addFirst = store.addDirectory(first);
    const addSecond = store.addDirectory(second);
    const removeFirst = store.removeDirectory(first);
    await vi.waitFor(() => expect(store.getSnapshot().additionalDirectories).toEqual([second]));
    await vi.waitFor(() => expect(refreshRequested).toHaveBeenCalledTimes(4));
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
    const commandGate = deferred<void>();
    const runBrewCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "cleanup") await commandGate.promise;
      return { success: true, status: 0, output: "" };
    });
    const store = await fixture({ runBrewCommand });
    await store.refreshToolStatus();
    const cleanup = store.cleanUpHomebrew(async () => true);
    await vi.waitFor(() =>
      expect(runBrewCommand).toHaveBeenCalledWith(["cleanup"], expect.any(Function))
    );
    const queued = store.performHomebrewUpdate(item.id);
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
    const inventoryGate = deferred<void>();
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
    const cleanup = store.cleanUpHomebrew(async () => true);
    await vi.waitFor(() => expect(fetchInventory).toHaveBeenCalledTimes(1));
    const competingRefresh = store.refresh(false);
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
      const firstLookup = deferred<void>();
      const secondLookup = deferred<void>();
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
      const firstRefresh = store.refresh(false);
      await vi.waitFor(() => expect(lookupOutcome).toHaveBeenCalledTimes(1));
      expect(store.getSnapshot().isHomebrewCleanupLocked).toBe(false);
      const cleanup = store.cleanUpHomebrew(async () => true);
      await vi.waitFor(() =>
        expect(runBrewCommand).toHaveBeenCalledWith(["cleanup"], expect.any(Function))
      );
      const secondRefresh = store.refresh(false);
      await vi.waitFor(() => expect(lookupOutcome).toHaveBeenCalledTimes(2));
      const queued = queueUpdate ? store.performHomebrewUpdate(item.id) : undefined;
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
      // The full caller now performs its own refresh after cleanup commits.
      expect(fetchInventory).toHaveBeenCalledTimes(4);
    }
  );
  it.each(["throw", "membership", "outdated", "scanner"])(
    "cancels stale queued upgrades after %s failure and revalidates after recovery",
    async (failure) => {
      const commandGate = deferred<void>();
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
      const cleanup = store.cleanUpHomebrew(async () => true);
      await vi.waitFor(() =>
        expect(runBrewCommand).toHaveBeenCalledWith(["cleanup"], expect.any(Function))
      );
      const queued = store.performHomebrewUpdate(item.id);
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
  it("supersedes a full refresh started while cleanup is still executing", async () => {
    const commandGate = deferred<void>();
    const obsoleteLookup = deferred<void>();
    const runBrewCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "cleanup") await commandGate.promise;
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
      items: [],
      outdatedDetectionSucceeded: true,
      outdatedDetectionSucceededByKind: { formula: true, cask: true },
      inventoryReadSucceededByKind: { formula: true, cask: true }
    }));
    const store = await fixture({
      runBrewCommand,
      clients: {
        scanner: { scanApplications: async () => [app] },
        appStore: { lookupOutcome },
        homebrewInventory: { fetchInventory }
      }
    });
    await store.refreshToolStatus();
    const cleanup = store.cleanUpHomebrew(async () => true);
    await vi.waitFor(() =>
      expect(runBrewCommand).toHaveBeenCalledWith(["cleanup"], expect.any(Function))
    );
    const obsolete = store.refresh();
    await vi.waitFor(() => expect(lookupOutcome).toHaveBeenCalledTimes(1));
    const queued = store.performHomebrewUpdate(item.id);
    commandGate.resolve();
    expect(await cleanup).toBe("Homebrew cleanup completed.");
    await queued;
    expect(store.getSnapshot().homebrewItems).toEqual([]);
    expect(fetchInventory).toHaveBeenCalledTimes(1);
    obsoleteLookup.resolve();
    await obsolete;
    expect(store.getSnapshot().homebrewItems).toEqual([]);
    expect(runBrewCommand.mock.calls.map(([args]) => args)).toEqual([["--version"], ["cleanup"]]);
  });
  it("refuses cleanup during an active inventory read without opening confirmation", async () => {
    const gate = deferred<void>();
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
    const refresh = store.refresh(true);
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
    const gate = deferred<void>();
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
    const update = store.performHomebrewUpdate(item.id);
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
});
