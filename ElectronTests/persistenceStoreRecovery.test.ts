// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SnapshotPersistence } from "../src/main/persistence";
import { ProfileStatsIntegrityService } from "../src/main/profileStatsIntegrityService";
import { UpdateStore } from "../src/main/updateStore";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type HomebrewManagedItem
} from "../src/shared/domain";
import { homebrewCommandToken } from "../src/shared/homebrewIdentity";
import { version } from "../src/shared/version";

const directories: string[] = [];
const stores: UpdateStore[] = [];
type StoreOptions = ConstructorParameters<typeof UpdateStore>[0];
afterEach(async () => {
  const results = await Promise.allSettled(stores.splice(0).map((store) => store.prepareToQuit()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length) throw new AggregateError(failures, "Fixture stores did not stop cleanly.");
});

async function fixture(saved: unknown, inventory: () => HomebrewManagedItem[] = () => []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-persisted-store-"));
  directories.push(directory);
  await writeFile(path.join(directory, "baseline-snapshot.json"), JSON.stringify(saved));
  const persistence = new SnapshotPersistence(directory);
  const mas = vi.fn<NonNullable<StoreOptions["runMasCommand"]>>(async () => ({
    success: false,
    status: 1,
    output: "Fixture command failed."
  }));
  const external = vi.fn<StoreOptions["openExternalURL"]>(async () => true);
  const openApp = vi.fn<StoreOptions["openAppBundle"]>(async () => undefined);
  const options: StoreOptions = {
    persistence,
    persisted: await persistence.load(),
    openExternalURL: external,
    openAppBundle: openApp,
    runMasCommand: mas,
    runBrewCommand: async () => ({ success: false, status: 1, output: "Fixture command failed." }),
    profileStatsIntegrity: new ProfileStatsIntegrityService(async () => "fixture-secret"),
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
          items: inventory(),
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
  };
  const store = new UpdateStore(options);
  stores.push(store);
  return { store, persistence, options, mas, external, openApp };
}

it.each([true, false])(
  "does not admit a damaged saved App Store update through mas or publisher routing (mas enabled: %s)",
  async (useMas) => {
    const app = {
      id: "damaged",
      bundlePath: "/Fixture.app",
      displayName: "Fixture",
      sourceHint: "appStore",
      localVersion: version("1")
    };
    const update = {
      id: app.id,
      appID: app.id,
      source: "appStore",
      supportLevel: "supported",
      localVersion: version("1"),
      remoteVersion: version("2"),
      appStoreItemID: 123,
      updateURL: "https://example.com/update",
      checkedAt: "2026-10-18T00:00:00.000Z"
    };
    const validUpdate = {
      ...update,
      id: "valid",
      appID: "valid",
      appStoreItemID: 456,
      updateURL: "https://example.com/valid-update"
    };
    const { store, mas, external, openApp } = await fixture({
      ...defaultPersistedSnapshot(),
      autoRefreshEnabled: false,
      useMasForAppStoreUpdates: useMas,
      apps: [app, { ...app, id: "valid", bundlePath: "/Valid.app" }],
      updates: [{ ...update, remoteVersion: { raw: 5 } }, validUpdate]
    });
    expect.soft(store.getSnapshot().updates.map((row) => row.appID)).toEqual(["valid"]);
    await store.performAppUpdate("damaged");
    expect.soft(mas).not.toHaveBeenCalled();
    expect.soft(external).not.toHaveBeenCalled();
    expect.soft(openApp).toHaveBeenCalledExactlyOnceWith(app.bundlePath);
    await store.performAppUpdate("valid");
    if (useMas) expect(mas).toHaveBeenCalledExactlyOnceWith(["upgrade", "456"]);
    else expect(mas).not.toHaveBeenCalled();
    expect(external).toHaveBeenCalledExactlyOnceWith(validUpdate.updateURL);
  }
);

it("keeps saved IDs, ignored state, pins and history through a cold-load incomplete rename episode", async () => {
  const formula = (token: string, oldNames: string[] = []): HomebrewManagedItem => ({
    id: `formula:${token}`,
    token,
    name: token,
    kind: "formula",
    installedVersion: version("1"),
    isOutdated: false,
    formulaIdentityVerified: true,
    formulaIdentity: {
      name: token,
      fullName: `example/tools/${token}`,
      tap: "example/tools",
      oldNames
    }
  });
  const a = { ...formula("old-alpha"), pinned: true };
  const b = formula("old-beta");
  const newA = formula("new-alpha", [a.token]);
  const newB = formula("new-beta", [b.token]);
  const missing = (item: HomebrewManagedItem) => ({
    ...item,
    formulaIdentity: undefined,
    formulaIdentityVerified: undefined
  });
  const history = {
    id: b.id,
    itemID: b.id,
    token: b.token,
    kind: b.kind,
    displayName: b.name,
    fromVersion: version("0"),
    toVersion: version("1"),
    updatedAt: "2026-10-18T00:00:00.000Z"
  };
  let inventory = [missing(newA), b];
  const { store, persistence, options } = await fixture(
    {
      ...defaultPersistedSnapshot(),
      autoRefreshEnabled: false,
      homebrewItems: [a, b],
      ignoredHomebrewItemIDs: [a.id, b.id],
      homebrewRecentlyUpdated: [history]
    },
    () => inventory
  );
  await store.refresh(true);
  expect(store.getSnapshot().homebrewFormulaIdentityContinuity?.map((item) => item.id)).toEqual([
    a.id,
    b.id
  ]);
  expect(
    homebrewCommandToken(
      store.getSnapshot().homebrewItems.find((item) => item.token === newA.token)!
    )
  ).toBeUndefined();
  inventory = [missing(newA), missing(newB)];
  await store.refresh(true);
  const relaunched = new UpdateStore({ ...options, persisted: await persistence.load() });
  stores.push(relaunched);
  inventory = [newA, newB];
  await relaunched.refresh(true);
  const recovered = relaunched.getSnapshot();
  expect(recovered.homebrewItems.map((item) => item.id)).toEqual([a.id, b.id]);
  expect(recovered.homebrewItems.find((item) => item.id === a.id)?.pinned).toBe(true);
  expect(recovered.ignoredHomebrewItemIDs).toEqual([a.id, b.id]);
  expect(recovered.homebrewRecentlyUpdated).toEqual([history]);
});
