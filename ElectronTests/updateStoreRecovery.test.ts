// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as commandRunner from "../src/main/commandRunner";
import { HomebrewInventoryClient } from "../src/main/homebrewInventoryClient";
import { SnapshotPersistence } from "../src/main/persistence";
import { UpdateStore } from "../src/main/updateStore";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type AppRecord,
  type HomebrewManagedItem
} from "../src/shared/domain";
import { version } from "../src/shared/version";

const app: AppRecord = {
  id: "/Applications/Managed.app",
  bundlePath: "/Applications/Managed.app",
  displayName: "Managed",
  bundleIdentifier: "com.example.managed",
  localVersion: version("1"),
  sourceHint: "unknown"
};
const formula: HomebrewManagedItem = {
  id: "formula:managed-tool",
  token: "managed-tool",
  name: "managed-tool",
  kind: "formula",
  installedVersion: version("1"),
  latestVersion: version("2"),
  isOutdated: true
};
const cask: HomebrewManagedItem = {
  id: "cask:managed-app",
  token: "managed-app",
  fullToken: "managed-app",
  tap: "homebrew/cask",
  name: "Managed",
  kind: "cask",
  appID: app.id,
  installedVersion: version("1"),
  latestVersion: version("2"),
  isOutdated: true
};
const discover = {
  id: "discover:cask:new-app",
  token: "new-app",
  kind: "cask" as const,
  displayName: "New App",
  version: version("1")
};
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((p) => rm(p, { force: true, recursive: true })));
});

async function fixture(options: Partial<ConstructorParameters<typeof UpdateStore>[0]> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-store-recovery-"));
  directories.push(directory);
  const persistence = new SnapshotPersistence(directory);
  const store = new UpdateStore({
    persistence,
    persisted: { ...defaultPersistedSnapshot(), apps: [app], homebrewItems: [formula, cask] },
    openExternalURL: async () => true,
    openAppBundle: async () => undefined,
    runBrewCommand: async () => ({ success: true, status: 0, output: "" }),
    runMasCommand: async () => ({ success: true, status: 0, output: "" }),
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => ({ ...stats, integrityStatus: "verified" }),
      seal: async (stats) => ({ ...stats, signature: "fixture-signature" })
    },
    successRefreshDelayMS: 0,
    ...options,
    clients: {
      scanner: { scanApplications: async () => [app] },
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
          items: [formula, cask],
          outdatedDetectionSucceeded: true,
          outdatedDetectionSucceededByKind: { formula: true, cask: true }
        })
      },
      ...options.clients
    }
  });
  return { store, persistence };
}

function mockInventory(
  options: {
    failFormulaList?: boolean;
    failCaskList?: boolean;
    failFormulaOutdated?: boolean;
    empty?: boolean;
  } = {}
) {
  vi.spyOn(commandRunner, "runBrewCommand").mockImplementation(async (args) => {
    const isFormula = args.includes("--formula");
    let success = true;
    let stdout = "";
    if (args[0] === "list") {
      success = !(isFormula ? options.failFormulaList : options.failCaskList);
      stdout = options.empty ? "" : isFormula ? "managed-tool 1" : "managed-app 1";
      if (!success) stdout = "";
    } else if (args[0] === "info") {
      stdout = JSON.stringify({
        casks: options.empty
          ? []
          : [
              {
                token: "managed-app",
                full_token: "managed-app",
                tap: "homebrew/cask",
                version: "2",
                installed: "1",
                artifacts: [{ app: ["Managed.app"] }]
              }
            ]
      });
    } else if (args[0] === "outdated") {
      success = !(isFormula && options.failFormulaOutdated);
      stdout = JSON.stringify(
        isFormula
          ? { formulae: options.empty ? [] : [{ name: "managed-tool", current_version: "2" }] }
          : { casks: options.empty ? [] : [{ name: "managed-app", current_version: "2" }] }
      );
    }
    return { success, status: success ? 0 : 1, stdout, output: stdout };
  });
}

describe("refresh inventory recovery", () => {
  it.each([
    { failFormulaList: true },
    { failCaskList: true },
    { failFormulaList: true, failCaskList: true }
  ])("preserves failed inventory kinds across refresh and persistence: %j", async (failure) => {
    mockInventory(failure);
    const { store, persistence } = await fixture({
      clients: { homebrewInventory: new HomebrewInventoryClient() }
    });
    await store.refresh(true);
    expect(
      store
        .getSnapshot()
        .homebrewItems.map((item) => item.id)
        .sort()
    ).toEqual([cask.id, formula.id].sort());
    expect(store.getSnapshot().homebrewItems.find((item) => item.id === cask.id)?.appID).toBe(
      app.id
    );
    expect((await persistence.load()).homebrewItems.map((item) => item.id).sort()).toEqual(
      [cask.id, formula.id].sort()
    );
    expect(store.getSnapshot().lastRefreshNoticeMessage).toContain("inventory");
  });

  it("removes known items after a successful empty inventory read", async () => {
    mockInventory({ empty: true });
    const { store } = await fixture({
      clients: { homebrewInventory: new HomebrewInventoryClient() }
    });
    await store.refresh(true);
    expect(store.getSnapshot().homebrewItems).toEqual([]);
    expect(store.getSnapshot().lastRefreshNoticeMessage).toBeUndefined();
  });

  it("preserves outdated state when membership succeeds but outdated detection fails", async () => {
    mockInventory({ failFormulaOutdated: true });
    const { store } = await fixture({
      clients: { homebrewInventory: new HomebrewInventoryClient() }
    });
    await store.refresh(true);
    expect(store.getSnapshot().homebrewItems.find((item) => item.id === formula.id)).toMatchObject({
      isOutdated: true,
      latestVersion: version("2")
    });
  });

  it("persists both real concurrent ignore actions", async () => {
    const { store, persistence } = await fixture();
    await Promise.all([store.toggleIgnoredApp(app.id), store.toggleIgnoredHomebrew(formula.id)]);
    expect(await persistence.load()).toMatchObject({
      ignoredIDs: [app.id],
      ignoredHomebrewItemIDs: [formula.id]
    });
  });
});

describe("Discover install recovery", () => {
  it("completes installation and accepts another operation after a history save failure", async () => {
    const commands: string[][] = [];
    const { store, persistence } = await fixture({
      runBrewCommand: async (args) => {
        commands.push(args);
        return { success: true, status: 0, output: "" };
      }
    });
    vi.spyOn(persistence, "save").mockRejectedValueOnce(new Error("Synthetic ENOSPC"));
    await expect(store.installHomebrewItem(discover)).resolves.toBeUndefined();
    expect(store.getSnapshot().homebrewDiscoverInstallingItemIDs).toEqual([]);
    expect(store.getSnapshot().isHomebrewCommandLocked).toBe(false);
    expect(store.getSnapshot().lastRefreshNoticeMessage).toContain(
      "local update history could not be saved"
    );
    await store.performHomebrewUpdate(formula.id);
    expect(commands).toContainEqual(["upgrade", formula.token]);
    expect(store.getSnapshot().homebrewQueuedItemIDs).toEqual([]);
  });

  it("clears transient state and drains an existing queue after unexpected finalization rejection", async () => {
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    let cleanupCount = 0;
    const commands: string[][] = [];
    const { store } = await fixture({
      runBrewCommand: async (args) => {
        commands.push(args);
        if (args[0] === "install") await installGate;
        if (args[0] === "cleanup" && ++cleanupCount === 1)
          throw new Error("Synthetic cleanup rejection");
        return { success: true, status: 0, output: "" };
      }
    });
    const install = store.installHomebrewItem(discover);
    const update = store.performHomebrewUpdate(formula.id);
    expect(store.getSnapshot().homebrewQueuedItemIDs).toContain(formula.id);
    releaseInstall();
    await expect(install).rejects.toThrow("Synthetic cleanup rejection");
    await update;
    expect(store.getSnapshot().homebrewDiscoverInstallingItemIDs).toEqual([]);
    expect(store.getSnapshot().homebrewDiscoverProgressByItemID[discover.id]).toBeUndefined();
    expect(store.getSnapshot().isHomebrewCommandLocked).toBe(false);
    expect(store.getSnapshot().homebrewQueuedItemIDs).toEqual([]);
    expect(commands).toContainEqual(["upgrade", formula.token]);
  });

  it("retains failure feedback while clearing installing state for a failed install command", async () => {
    const { store } = await fixture({
      runBrewCommand: async () => ({ success: false, status: 1, output: "" })
    });
    await store.installHomebrewItem(discover);
    expect(store.getSnapshot().homebrewDiscoverInstallingItemIDs).toEqual([]);
    expect(store.getSnapshot().homebrewDiscoverFailedItemIDs).toContain(discover.id);
    expect(store.getSnapshot().isHomebrewCommandLocked).toBe(false);
  });
});
