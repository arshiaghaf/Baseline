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
  it.each([false, true])(
    "takes a fresh post-cleanup inventory even if a full refresh supersedes the awaited refresh (queued update: %s)",
    async (queueUpdate) => {
      const firstLookup = deferred<void>();
      const secondLookup = deferred<void>();
      let installed = [item];
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
          scanner: { scanApplications: async () => [app] },
          appStore: { lookupOutcome },
          homebrewInventory: { fetchInventory }
        }
      });
      await store.refreshToolStatus();
      const firstRefresh = store.refresh(false);
      await vi.waitFor(() => expect(lookupOutcome).toHaveBeenCalledTimes(1));
      const cleanup = store.cleanUpHomebrew(async () => true);
      await vi.waitFor(() =>
        expect(runBrewCommand).toHaveBeenCalledWith(["cleanup"], expect.any(Function))
      );
      const secondRefresh = store.refresh(false);
      await vi.waitFor(() => expect(lookupOutcome).toHaveBeenCalledTimes(2));
      const queued = queueUpdate ? store.performHomebrewUpdate(item.id) : undefined;
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
      expect(fetchInventory).toHaveBeenCalledTimes(2);
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
});
