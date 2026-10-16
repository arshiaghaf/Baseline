// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import type { CommandResult, runBrewCommand } from "../src/main/commandRunner";
import type { HomebrewInventoryResult } from "../src/main/homebrewInventoryClient";
import { SnapshotPersistence } from "../src/main/persistence";
import { UpdateStore } from "../src/main/updateStore";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type HomebrewManagedItem
} from "../src/shared/domain";
import { version } from "../src/shared/version";

const item: HomebrewManagedItem = {
  id: "formula:tool",
  kind: "formula",
  token: "tool",
  name: "Tool",
  installedVersion: version("1"),
  latestVersion: version("2"),
  isOutdated: true,
  formulaIdentityVerified: true,
  formulaIdentity: { name: "tool", fullName: "tool", tap: "homebrew/core", oldNames: [] }
};
const inventory: HomebrewInventoryResult = {
  items: [item],
  inventoryReadSucceededByKind: { formula: true, cask: true },
  outdatedDetectionSucceeded: true,
  outdatedDetectionSucceededByKind: { formula: true, cask: true }
};
const ok: CommandResult = { success: true, status: 0, output: "" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(
  options: {
    run?: typeof runBrewCommand;
    fetch?: () => Promise<HomebrewInventoryResult>;
    cleanup?: () => boolean;
  } = {}
) {
  const run = vi.fn(options.run ?? (async () => ok));
  const fetch = vi.fn(options.fetch ?? (async () => inventory));
  const store = new UpdateStore({
    persistence: { save: async () => undefined } as unknown as SnapshotPersistence,
    persisted: { ...defaultPersistedSnapshot(), autoRefreshEnabled: false, homebrewItems: [item] },
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    runBrewCommand: run,
    runMasCommand: async () => ok,
    isHomebrewCleanupUnconfirmed: options.cleanup ?? (() => false),
    successRefreshDelayMS: 0,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    },
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
      homebrewInventory: { fetchInventory: fetch }
    }
  });
  return { store, run, fetch };
}
const discovery = {
  id: "formula:new",
  kind: "formula" as const,
  token: "new",
  displayName: "New",
  version: version("1")
};

describe("runner quarantine composition", () => {
  it("blocks future work before releasing an uncertain mutation reservation", async () => {
    const gate = deferred<CommandResult>();
    const { store, run, fetch } = fixture({ run: async () => gate.promise });
    const installing = store.installHomebrewItem(discovery);
    try {
      expect(await store.prepareToQuit()).toBe(false);
      gate.resolve({
        success: false,
        status: null,
        output: "",
        failure: { kind: "cleanup", message: "Unconfirmed" }
      });
      await installing;
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(true);
      expect(store.getSnapshot().homebrewItems.every((entry) => !entry.isOutdated)).toBe(true);
      expect(store.getSnapshot().lastRefreshNoticeMessage).toContain(
        "Check running Homebrew processes"
      );
      await store.installHomebrewItem(discovery);
      await store.performHomebrewUpdate(item.id);
      await store.refresh(true);
      expect(run).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(await store.prepareToQuit()).toBe(true);
    } finally {
      gate.resolve(ok);
      await installing;
      await store.prepareToQuit();
    }
  });

  it("observes the runner latch when older inventory loses failure details, after siblings settle", async () => {
    const gate = deferred<HomebrewInventoryResult>();
    const began = deferred<void>();
    let cleanup = false;
    const { store, fetch } = fixture({
      cleanup: () => cleanup,
      fetch: () => {
        began.resolve();
        return gate.promise;
      }
    });
    const refresh = store.refresh(true);
    try {
      await began.promise;
      cleanup = true;
      expect(await store.prepareToQuit()).toBe(false);
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(true);
      gate.resolve(inventory);
      await refresh;
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(true);
      expect(store.getSnapshot().homebrewItems.every((entry) => !entry.isOutdated)).toBe(true);
      expect(store.getSnapshot().homebrewItems[0]?.formulaIdentityVerified).toBe(false);
      await store.refresh(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await store.prepareToQuit()).toBe(true);
    } finally {
      gate.resolve(inventory);
      await refresh;
      await store.prepareToQuit();
    }
  });

  it("consumes the explicit inventory cleanup flag without a process-global latch", async () => {
    const unsafe: HomebrewInventoryResult & { cleanupUnconfirmed: boolean } = {
      ...inventory,
      cleanupUnconfirmed: true
    };
    const { store, fetch, run } = fixture({ fetch: async () => unsafe });
    try {
      await store.refresh(true);
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(true);
      expect(store.getSnapshot().homebrewItems.every((entry) => !entry.isOutdated)).toBe(true);
      await store.refresh(true);
      await store.installHomebrewItem(discovery);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
      expect(await store.prepareToQuit()).toBe(true);
    } finally {
      await store.prepareToQuit();
    }
  });

  it("does not launch inventory when the global latch was already set", async () => {
    const { store, fetch } = fixture({ cleanup: () => true });
    try {
      await store.refresh(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(true);
      expect(store.getSnapshot().homebrewItems.every((entry) => !entry.isOutdated)).toBe(true);
    } finally {
      await store.prepareToQuit();
    }
  });

  it("quarantines an inventory exception before freeing the read reservation", async () => {
    let cleanup = false;
    const { store } = fixture({
      cleanup: () => cleanup,
      fetch: async () => {
        cleanup = true;
        throw new Error("Fixture failure");
      }
    });
    try {
      await store.refresh(true);
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(true);
      expect(await store.prepareToQuit()).toBe(true);
    } finally {
      await store.prepareToQuit();
    }
  });
});
