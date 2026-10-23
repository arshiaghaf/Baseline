// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BundleScannerClient } from "../src/main/bundleScanner";
import { HomebrewCaskClient } from "../src/main/homebrewCaskClient";
import { HomebrewInventoryClient } from "../src/main/homebrewInventoryClient";
import { lookupAppUpdates } from "../src/main/appUpdateLookupService";
import {
  canUseHomebrewAppUpdate,
  homebrewCaskItemProvesAppOwnership,
  preservePreviousHomebrewOutdatedState,
  reconcileHomebrewInventory
} from "../src/main/homebrewReconciliation";
import { reconcileScannedApps } from "../src/main/scanReconciliation";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex
} from "../src/shared/domain";
import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewManagedItem,
  PersistedSnapshot
} from "../src/shared/domain";
import { caskIndexForInstalledItems } from "../src/shared/homebrewIdentity";
import { version } from "../src/shared/version";
import {
  combinedAvailableCount,
  deriveSections,
  uninstallableHomebrewItemForApp
} from "../src/renderer/helpers/sections";

// Exercise the real scanner with disposable bundles, without plist subprocesses or GUI IO.
vi.mock("../src/main/commandRunner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/commandRunner")>()),
  runCommand: async (_executable: string, args: string[]) => ({
    success: true,
    status: 0,
    stdout: await readFile(args.at(-1)!, "utf8")
  })
}));
vi.mock("electron", () => ({
  app: { getFileIcon: async () => ({ isEmpty: () => true }) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}));

const roots: string[] = [];
const stores: UpdateStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.prepareToQuit();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "baseline-cask-ownership-"));
  roots.push(root);
  return root;
}
async function bundle(root: string, name: string, identifier = true) {
  const target = path.join(root, name, "Example.app");
  await mkdir(path.join(target, "Contents"), { recursive: true });
  await writeFile(
    path.join(target, "Contents", "Info.plist"),
    JSON.stringify({
      CFBundleName: "Example",
      ...(identifier ? { CFBundleIdentifier: "org.example.fixture" } : {}),
      CFBundleShortVersionString: "1.5"
    })
  );
  return target;
}
function metadata(target?: string, packageVersion = "2", identifier = true) {
  return {
    token: "example",
    full_token: "example",
    tap: "homebrew/cask",
    version: packageVersion,
    installed: packageVersion,
    ...(identifier ? { bundle_id: "org.example.fixture" } : {}),
    artifacts: [{ app: ["Example.app"], ...(target ? { target } : {}) }]
  };
}
async function inventory(raw: ReturnType<typeof metadata>, outdated = true) {
  const client = new HomebrewInventoryClient(async (args) => {
    let output: string;
    if (args[0]! === "info") output = JSON.stringify({ formulae: [], casks: [raw] });
    else if (args[0]! === "list")
      output = args.includes("--cask") ? `example ${raw.installed}` : "";
    else
      output = JSON.stringify({
        formulae: [],
        casks:
          args.includes("--cask") && outdated
            ? [
                {
                  name: "example",
                  installed_versions: [raw.installed],
                  current_version: raw.version
                }
              ]
            : []
      });
    return { success: true, status: 0, output };
  });
  const result = await client.fetchInventory();
  expect(result.outdatedDetectionSucceededByKind).toEqual({ formula: true, cask: true });
  return result.items;
}
async function lookup(apps: AppRecord[], items: HomebrewManagedItem[]) {
  const homebrew = new HomebrewCaskClient();
  const index = caskIndexForInstalledItems(emptyHomebrewCaskIndex, items);
  const updates = await lookupAppUpdates(
    {
      appStore: { lookupOutcome: async () => ({ type: "completed" }) },
      sparkle: { lookupOutcome: async () => ({ type: "completed" }) },
      homebrew
    },
    {
      apps,
      homebrewItems: items,
      homebrewIndex: index,
      previousUpdates: new Map(),
      now: "2026-10-23T00:00:00.000Z",
      force: true,
      signal: new AbortController().signal,
      isCurrent: () => true,
      isSelfApp: () => false,
      canUseHomebrewAppUpdate
    }
  );
  return { index, updates: updates! };
}
function snapshot(apps: AppRecord[], homebrewItems: HomebrewManagedItem[]) {
  return {
    ...defaultPersistedSnapshot(),
    apps,
    homebrewItems,
    searchText: "",
    isMasInstalled: false,
    isHomebrewInstalled: true,
    isChecking: false,
    isRefreshing: false
  };
}

async function storeFixture(
  root: string,
  apps: AppRecord[],
  items: HomebrewManagedItem[],
  directories = [root]
) {
  const persistence = new SnapshotPersistence(path.join(root, "store-profile"));
  await persistence.save({
    ...defaultPersistedSnapshot(),
    apps,
    homebrewItems: items,
    additionalDirectories: directories,
    ignoredIDs: ["unrelated-app"],
    ignoredHomebrewItemIDs: ["cask:other"]
  });
  const persisted: PersistedSnapshot = await persistence.load();
  const client = new HomebrewCaskClient();
  const run = vi.fn(async () => ({
    success: false,
    status: 1,
    output: "Synthetic refusal"
  }));
  const open = vi.fn(async () => undefined);
  const apple = vi.fn(async () => ({ type: "completed" as const }));
  const store = new UpdateStore({
    persistence,
    persisted,
    openExternalURL: async () => false,
    openAppBundle: open,
    runBrewCommand: run,
    runMasCommand: run,
    isHomebrewCleanupUnconfirmed: () => false,
    successRefreshDelayMS: 0,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => ({ ...stats, integrityStatus: "verified" }),
      seal: async (stats) => stats
    },
    clients: {
      scanner: {
        scanApplications: async (_directories, options) =>
          new BundleScannerClient().scanApplications(directories, options)
      },
      appStore: { lookupOutcome: apple },
      sparkle: { lookupOutcome: async () => ({ type: "completed" }) },
      homebrew: {
        fetchIndex: async () => emptyHomebrewCaskIndex,
        lookupUpdate: client.lookupUpdate.bind(client),
        searchCasks: () => []
      },
      homebrewFormula: {
        fetchIndex: async () => emptyHomebrewFormulaIndex,
        searchFormulae: () => []
      },
      homebrewInventory: {
        fetchInventory: async () => ({
          items: structuredClone(items),
          inventoryReadSucceededByKind: { formula: true, cask: true },
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
      }
    }
  });
  stores.push(store);
  return { store, run, open, apple, persistence };
}

describe("installed cask app ownership", () => {
  it.each([true, false])(
    "requires the installed target with bundle metadata present: %s",
    async (identifier) => {
      const root = await temporaryRoot();
      const target = await bundle(root, "Installed", identifier);
      await bundle(root, "Archive", identifier);
      const apps = await new BundleScannerClient().scanApplications([
        path.join(root, "Archive"),
        path.join(root, "Installed")
      ]);
      expect(apps).toHaveLength(2);
      const archive = apps.find((app) => app.bundlePath !== target)!;
      const installed = apps.find((app) => app.bundlePath === target)!;
      const items = await inventory(metadata(target, "2", identifier));
      items[0]!.appID = archive.id; // A saved link must not override fresh contrary evidence.
      const { index, updates } = await lookup(apps, items);
      expect(canUseHomebrewAppUpdate(archive, "example", items, index, apps)).toBe(false);
      expect(canUseHomebrewAppUpdate(installed, "example", items, index, apps)).toBe(true);
      expect(updates.map((update) => update.appID)).toEqual([installed.id]);
      const reconciled = reconcileHomebrewInventory(items, updates, apps, index, items);
      expect(reconciled[0]!.appID).toBe(installed.id);
      const state = { ...snapshot(apps, reconciled), updates } as BaselineSnapshot;
      expect(uninstallableHomebrewItemForApp(archive, state)).toBeUndefined();
      expect(uninstallableHomebrewItemForApp(installed, state)?.id).toBe(items[0]!.id);
      expect(combinedAvailableCount(deriveSections(state))).toBe(1);
    }
  );

  it("retains a package row when installed targets are absent from the scan", async () => {
    const root = await temporaryRoot();
    const target = await bundle(root, "Installed");
    await bundle(root, "Archive");
    const apps = await new BundleScannerClient().scanApplications([path.join(root, "Archive")]);
    const items = await inventory(metadata(target));
    items[0]!.appID = apps[0]!.id;
    const { index, updates } = await lookup(apps, items);
    expect(updates).toEqual([]);
    const reconciled = reconcileHomebrewInventory(items, [], apps, index, items);
    expect(reconciled[0]!).toMatchObject({
      appID: undefined,
      isOutdated: true,
      installedVersion: version("2")
    });
    expect(deriveSections(snapshot(apps, reconciled)).allHomebrewOutdated).toHaveLength(1);
  });

  it("does not choose a duplicate by scan order, saved ID or previous update without target evidence", async () => {
    const root = await temporaryRoot();
    await bundle(root, "Installed");
    await bundle(root, "Archive");
    const apps = await new BundleScannerClient().scanApplications([root]);
    const items = await inventory(metadata());
    items[0]!.appID = apps[0]!.id;
    const { index, updates } = await lookup(apps, items);
    expect(updates).toEqual([]);
    const staleUpdate = {
      id: apps[0]!.id,
      appID: apps[0]!.id,
      source: "homebrew" as const,
      supportLevel: "limited" as const,
      homebrewToken: "example",
      localVersion: version("1.5"),
      remoteVersion: version("9"),
      checkedAt: "2026-10-23T00:00:00Z"
    };
    for (const ordered of [apps, [...apps].reverse()]) {
      expect(canUseHomebrewAppUpdate(ordered[0]!, "example", items, index, ordered)).toBe(false);
      expect(
        reconcileHomebrewInventory(items, [staleUpdate], ordered, index, items)[0]!
      ).toMatchObject({ appID: undefined, latestVersion: version("2"), isOutdated: true });
    }
    // A single candidate keeps the established metadata fallback for older inventories.
    expect(reconcileHomebrewInventory(items, [], [apps[0]!], index)[0]!.appID).toBe(apps[0]!.id);
  });

  it("matches canonical aliases while preserving saved app identity and preferences", async () => {
    const root = await temporaryRoot();
    const target = await bundle(root, "Installed");
    const aliases = path.join(root, "Aliases");
    await mkdir(aliases);
    const alias = path.join(aliases, "Example.app");
    await symlink(target, alias);
    const apps = await new BundleScannerClient().scanApplications([aliases, path.dirname(target)]);
    expect(apps).toHaveLength(1);
    expect(apps[0]!.bundlePath).toBe(alias);
    expect(apps[0]!.canonicalBundlePath).toBe(await realpath(target));
    apps[0]!.id = "saved-app-identity";
    const items = await inventory(metadata(alias));
    const { index, updates } = await lookup(apps, items);
    expect(updates.map((update) => update.appID)).toEqual(["saved-app-identity"]);
    const reconciled = reconcileHomebrewInventory(items, updates, apps, index);
    expect(reconciled[0]!.appID).toBe("saved-app-identity");
    expect(
      homebrewCaskItemProvesAppOwnership(reconciled[0]!, apps[0]!, items[0]!.caskMetadata, apps)
    ).toBe(true);
    const persistence = new SnapshotPersistence(path.join(root, "profile"));
    await persistence.save({ ...snapshot(apps, reconciled), ignoredIDs: [apps[0]!.id] });
    const saved = await persistence.load();
    expect(saved.apps[0]!.canonicalBundlePath).toBe(await realpath(target));
    const canonicalPaths = new Map<string, string>();
    const rescanned = await new BundleScannerClient().scanApplications([path.dirname(target)], {
      onAppRead: (bundlePath, canonical) => canonicalPaths.set(bundlePath, canonical)
    });
    const recovered = await reconcileScannedApps(
      rescanned,
      saved.apps,
      saved.apps,
      canonicalPaths,
      saved.ignoredIDs,
      new AbortController().signal
    );
    expect(recovered.scannedApps[0]!.id).toBe("saved-app-identity");
    expect(recovered.retainedApps).toEqual([]);
    expect(reconcileHomebrewInventory(items, [], recovered.scannedApps, index)[0]!.appID).toBe(
      "saved-app-identity"
    );
  });
});

describe("cask ownership at store boundaries", () => {
  it.each([false, true])(
    "revalidates persisted app links before the first refresh (correct target %s)",
    async (correctTarget) => {
      const root = await temporaryRoot();
      const target = await bundle(root, "Installed");
      const archivePath = await bundle(root, "Archive");
      const apps = await new BundleScannerClient().scanApplications([root]);
      const archive = apps.find((app) => app.bundlePath === archivePath)!;
      const targetApp = apps.find((app) => app.bundlePath === target)!;
      const items = await inventory(metadata(target));
      items[0]!.appID = correctTarget ? targetApp.id : archive.id;
      items[0]!.iconDataURL = "data:image/png;base64,cached";
      const { store, run } = await storeFixture(root, apps, items);
      const state = store.getSnapshot();
      const control = uninstallableHomebrewItemForApp(archive, state);
      if (control) await store.uninstallHomebrewItem(control.id);
      expect(run).not.toHaveBeenCalled();
      expect(control).toBeUndefined();
      expect(state.homebrewItems[0]!.appID).toBe(correctTarget ? targetApp.id : undefined);
      expect(state.homebrewItems[0]!.iconDataURL).toBe(
        correctTarget ? items[0]!.iconDataURL : undefined
      );
      expect(state.homebrewItems[0]!.isOutdated).toBe(true);
      expect(state.ignoredIDs).toEqual(["unrelated-app"]);
      expect(state.ignoredHomebrewItemIDs).toEqual(["cask:other"]);
      expect(uninstallableHomebrewItemForApp(targetApp, state)?.id).toBe(
        correctTarget ? items[0]!.id : undefined
      );
    }
  );

  it.each([undefined, "healthy", "unavailable"] as const)(
    "uses retained copies only as ambiguity constraints (target %s)",
    async (targetKind) => {
      const root = await temporaryRoot();
      const healthyPath = await bundle(root, "Healthy");
      const unavailablePath = await bundle(root, "Unavailable");
      const apps = await new BundleScannerClient().scanApplications([root]);
      await rename(path.dirname(unavailablePath), path.join(root, "Moved"));
      const target =
        targetKind === "healthy"
          ? healthyPath
          : targetKind === "unavailable"
            ? unavailablePath
            : undefined;
      const items = await inventory(metadata(target));
      const { store, run, apple, persistence } = await storeFixture(root, apps, items, [
        path.dirname(healthyPath),
        path.dirname(unavailablePath)
      ]);
      const observed: BaselineSnapshot[] = [];
      store.on("snapshot", (state) => observed.push(state));
      await store.refresh(false);
      const state = store.getSnapshot();
      expect(state.apps).toHaveLength(2);
      expect(state.lastRefreshNoticeMessage).toContain("Previously found apps have been kept");
      const expectedUpdateIDs = targetKind === "healthy" ? [healthyPath] : [];
      expect(state.updates.map((update) => update.appID)).toEqual(expectedUpdateIDs);
      expect(
        observed.every((state) =>
          state.updates.every((update) => expectedUpdateIDs.includes(update.appID))
        )
      ).toBe(true);
      expect(state.homebrewItems[0]!.appID).toBe(
        targetKind === "healthy" ? healthyPath : undefined
      );
      expect(state.homebrewItems[0]!.isOutdated).toBe(true);
      expect(apple).toHaveBeenCalledTimes(1);
      expect(deriveSections(state).allHomebrewOutdated).toHaveLength(
        targetKind === "healthy" ? 0 : 1
      );
      expect(combinedAvailableCount(deriveSections(state))).toBe(1);
      if (!targetKind) {
        for (const app of state.apps) await store.performAppUpdate(app.id);
        expect(run).not.toHaveBeenCalled();
      }
      expect((await persistence.load()).homebrewItems[0]!.appID).toBe(
        state.homebrewItems[0]!.appID
      );
    }
  );
});

describe("app-backed latest casks", () => {
  it.each([true, false])(
    "preserves a greedy outdated result with a scanned app: %s",
    async (withApp) => {
      const root = await temporaryRoot();
      const target = await bundle(root, "Installed");
      const apps = withApp ? await new BundleScannerClient().scanApplications([root]) : [];
      const items = await inventory(metadata(target, "latest"));
      expect(items[0]!).toMatchObject({
        installedVersion: version("latest"),
        latestVersion: version("latest"),
        isOutdated: true
      });
      const { index, updates } = await lookup(apps, items);
      expect(updates).toEqual([]);
      const reconciled = reconcileHomebrewInventory(items, updates, apps, index);
      expect(reconciled[0]!).toMatchObject({
        installedVersion: version(withApp ? "1.5" : "latest"),
        packageInstalledVersion: version("latest"),
        latestVersion: version("latest"),
        isOutdated: true
      });
      expect(combinedAvailableCount(deriveSections(snapshot(apps, reconciled)))).toBe(1);
      const persistence = new SnapshotPersistence(path.join(root, "profile"));
      await persistence.save({
        ...snapshot(apps, reconciled),
        ignoredIDs: ["unrelated-app"],
        ignoredHomebrewItemIDs: ["cask:other"]
      });
      const saved = await persistence.load();
      expect(saved.homebrewItems[0]!).toMatchObject({
        packageInstalledVersion: version("latest"),
        installedVersion: version(withApp ? "1.5" : "latest"),
        latestVersion: version("latest"),
        isOutdated: true
      });
      expect(saved.ignoredIDs).toEqual(["unrelated-app"]);
      expect(saved.ignoredHomebrewItemIDs).toEqual(["cask:other"]);
      const fresh = await inventory(metadata(target, "latest"), false);
      const failedDetection = preservePreviousHomebrewOutdatedState(fresh, saved.homebrewItems, {
        cask: false,
        formula: true
      });
      expect(reconcileHomebrewInventory(failedDetection, [], apps, index)[0]!.isOutdated).toBe(
        true
      );
      expect(reconcileHomebrewInventory(fresh, [], apps, index)[0]!.isOutdated).toBe(false);
    }
  );

  it.each([
    { latest: "1.5", expected: false },
    { latest: "1.4", expected: false },
    { latest: "2", expected: true }
  ])("still suppresses stale numeric package updates: %j", async ({ latest, expected }) => {
    const root = await temporaryRoot();
    const target = await bundle(root, "Installed");
    const apps = await new BundleScannerClient().scanApplications([root]);
    const items = await inventory({ ...metadata(target, latest), installed: "1" });
    const { index, updates } = await lookup(apps, items);
    const reconciled = reconcileHomebrewInventory(items, updates, apps, index);
    expect(reconciled[0]!).toMatchObject({
      installedVersion: version("1.5"),
      packageInstalledVersion: version("1"),
      isOutdated: expected
    });
    expect(combinedAvailableCount(deriveSections({ ...snapshot(apps, reconciled), updates }))).toBe(
      Number(expected)
    );
  });
});
