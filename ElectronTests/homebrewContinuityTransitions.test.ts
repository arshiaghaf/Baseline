// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex
} from "../src/shared/domain";
import type { HomebrewManagedItem, PersistedSnapshot, ProfileStats } from "../src/shared/domain";
import type { VersionValue } from "../src/shared/version";
import { version } from "../src/shared/version";
import { homebrewCommandToken } from "../src/shared/homebrewIdentity";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
function formula(token: string, oldNames: string[] = [], pinned?: boolean): HomebrewManagedItem {
  return {
    id: `formula:${token}`,
    token,
    name: token,
    kind: "formula",
    installedVersion: version("1"),
    latestVersion: version("2"),
    isOutdated: true,
    pinned,
    formulaIdentity: {
      name: token,
      fullName: `example/tools/${token}`,
      tap: "example/tools",
      oldNames
    },
    formulaIdentityVerified: true
  };
}
function missing(item: HomebrewManagedItem): HomebrewManagedItem {
  return {
    ...item,
    formulaIdentity: undefined,
    formulaIdentityVerified: undefined,
    pinned: undefined,
    isOutdated: false,
    latestVersion: undefined
  };
}
async function setup(persisted: PersistedSnapshot, inventory: () => HomebrewManagedItem[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-sol-review-state-"));
  dirs.push(dir);
  const persistence = new SnapshotPersistence(dir);
  const runBrewCommand = vi.fn(async () => ({
    success: false,
    status: 1,
    output: "Synthetic failure"
  }));
  const options = {
    persistence,
    persisted,
    runBrewCommand,
    successRefreshDelayMS: 0,
    openExternalURL: async () => true,
    openAppBundle: async () => {},
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats: ProfileStats) => ({
        ...stats,
        integrityStatus: "verified" as const
      }),
      seal: async (stats: ProfileStats) => ({ ...stats, signature: "sealed" })
    },
    clients: {
      scanner: { scanApplications: async () => [] },
      appStore: { lookupOutcome: async () => ({ type: "completed" as const }) },
      sparkle: { lookupOutcome: async () => ({ type: "completed" as const }) },
      homebrew: {
        fetchIndex: async () => emptyHomebrewCaskIndex,
        lookupUpdate: () => undefined,
        searchCasks: () => []
      },
      homebrewFormula: {
        fetchIndex: async () => emptyHomebrewFormulaIndex,
        searchFormulae: () => []
      },
      selfUpdate: {
        lookup: async (currentVersion: VersionValue, checkedAt: string) => ({
          available: false,
          currentVersion,
          releaseURL: "https://github.com/arshiaghaf/Baseline/releases/latest",
          checkedAt
        })
      },
      homebrewInventory: {
        fetchInventory: async () => ({
          items: inventory(),
          inventoryReadSucceededByKind: { formula: true, cask: true },
          outdatedDetectionSucceeded: true,
          outdatedDetectionSucceededByKind: { formula: true, cask: true }
        })
      }
    }
  };
  return { store: new UpdateStore(options), options, persistence, runBrewCommand };
}

it.each([
  ["formula", undefined],
  ["cask", undefined],
  ["formula", true],
  ["cask", true]
] as const)(
  "preserve known %s pin across identity failure and missing pin on same-identity recovery (failure pin %s)",
  async (kind, failurePin) => {
    const known = formula("utility", [], true);
    const previous =
      kind === "formula"
        ? known
        : {
            ...known,
            id: "cask:utility",
            kind,
            fullToken: "utility",
            tap: "homebrew/cask",
            formulaIdentity: undefined
          };
    const unverified =
      kind === "formula"
        ? missing(previous)
        : { ...missing(previous), fullToken: undefined, tap: undefined };
    let inventory: HomebrewManagedItem[] = [{ ...unverified, pinned: failurePin }];
    const { store, options, persistence, runBrewCommand } = await setup(
      { ...defaultPersistedSnapshot(), homebrewItems: [previous] },
      () => inventory
    );
    await store.refresh(true);
    expect(homebrewCommandToken(store.getSnapshot().homebrewItems[0]!)).toBeUndefined();
    // Use real persistence normalization to exercise relaunch, not an in-memory-only snapshot.
    const relaunched = new UpdateStore({ ...options, persisted: await persistence.load() });
    inventory = [{ ...previous, pinned: undefined }];
    await relaunched.refresh(true);
    await relaunched.performHomebrewUpdate(previous.id);
    expect(runBrewCommand).not.toHaveBeenCalled();
    expect(relaunched.getSnapshot().homebrewItems[0]?.pinned).toBe(true);
  }
);

it("preserve known pin across a proven same-tap rename with omitted pin field", async () => {
  const previous = formula("old-utility", [], true);
  const current = formula("new-utility", ["old-utility"]);
  const { store, runBrewCommand } = await setup(
    { ...defaultPersistedSnapshot(), homebrewItems: [previous] },
    () => [current]
  );
  await store.refresh(true);
  expect(store.getSnapshot().homebrewItems[0]?.id).toBe(previous.id);
  await store.performHomebrewUpdate(previous.id);
  expect(runBrewCommand).not.toHaveBeenCalled();
  expect(store.getSnapshot().homebrewItems[0]?.pinned).toBe(true);
});

it("preserve a second rename during an incomplete metadata episode", async () => {
  const a = formula("old-alpha");
  const b = formula("old-beta");
  const newA = formula("new-alpha", ["old-alpha"]);
  const newB = formula("new-beta", ["old-beta"]);
  const history = {
    id: b.id,
    itemID: b.id,
    token: b.token,
    kind: b.kind,
    displayName: b.name,
    fromVersion: version("0"),
    toVersion: version("1"),
    updatedAt: new Date().toISOString()
  };
  let inventory: HomebrewManagedItem[] = [missing(newA), b];
  const { store, options, persistence } = await setup(
    {
      ...defaultPersistedSnapshot(),
      homebrewItems: [a, b],
      ignoredHomebrewItemIDs: [a.id, b.id],
      homebrewRecentlyUpdated: [history]
    },
    () => inventory
  );
  await store.refresh(true);
  expect(store.getSnapshot().homebrewFormulaIdentityContinuity?.map((i) => i.id)).toEqual([
    a.id,
    b.id
  ]);
  inventory = [missing(newA), missing(newB)];
  await store.refresh(true);
  const historyAfterFailure = store.getSnapshot().homebrewRecentlyUpdated;
  const relaunched = new UpdateStore({ ...options, persisted: await persistence.load() });
  inventory = [newA, newB];
  await relaunched.refresh(true);
  expect.soft(relaunched.getSnapshot().homebrewItems.map((i) => i.id)).toEqual([a.id, b.id]);
  expect.soft(historyAfterFailure).toEqual([history]);
  expect.soft(relaunched.getSnapshot().homebrewRecentlyUpdated).toEqual([history]);
});

it.each(["formula", "cask"] as const)(
  "explicit false clears the known %s pin after recovery",
  async (kind) => {
    const known = formula("utility", [], true);
    const previous: HomebrewManagedItem =
      kind === "formula"
        ? known
        : {
            ...known,
            kind,
            id: "cask:utility",
            formulaIdentity: undefined,
            fullToken: "utility",
            tap: "homebrew/cask"
          };
    let inventory: HomebrewManagedItem[] = [
      { ...missing(previous), fullToken: undefined, tap: undefined }
    ];
    const { store } = await setup(
      { ...defaultPersistedSnapshot(), homebrewItems: [previous] },
      () => inventory
    );
    await store.refresh(true);
    inventory = [{ ...previous, pinned: false }];
    await store.refresh(true);
    expect(store.getSnapshot().homebrewItems[0]?.pinned).toBe(false);
  }
);

it.each(["formula", "cask"] as const)(
  "does not carry a %s pin across a tap switch after relaunch",
  async (kind) => {
    const known = formula("utility", [], true);
    const previous: HomebrewManagedItem =
      kind === "formula"
        ? known
        : {
            ...known,
            kind,
            id: "cask:utility",
            formulaIdentity: undefined,
            fullToken: "example/tools/utility",
            tap: "example/tools"
          };
    let inventory: HomebrewManagedItem[] = [
      { ...missing(previous), fullToken: undefined, tap: undefined }
    ];
    const { store, options, persistence } = await setup(
      { ...defaultPersistedSnapshot(), homebrewItems: [previous] },
      () => inventory
    );
    await store.refresh(true);
    expect(store.getSnapshot().homebrewItems[0]?.pinned).toBe(true);
    const relaunched = new UpdateStore({ ...options, persisted: await persistence.load() });
    inventory = [
      {
        ...previous,
        pinned: undefined,
        fullToken: "other/tools/utility",
        tap: "other/tools",
        formulaIdentity:
          kind === "formula"
            ? { ...known.formulaIdentity!, tap: "other/tools", fullName: "other/tools/utility" }
            : undefined
      }
    ];
    await relaunched.refresh(true);
    expect(relaunched.getSnapshot().homebrewItems[0]?.pinned).toBeUndefined();
  }
);

it("does not assign a pin or saved ID when fresh rename aliases are ambiguous", async () => {
  const a = formula("old-alpha", [], true);
  const b = formula("old-beta", [], true);
  const renamed = formula("new-tool", [a.token, b.token]);
  let inventory: HomebrewManagedItem[] = [missing(renamed)];
  const { store, options, persistence } = await setup(
    { ...defaultPersistedSnapshot(), homebrewItems: [a, b], ignoredHomebrewItemIDs: [a.id, b.id] },
    () => inventory
  );
  await store.refresh(true);
  const relaunched = new UpdateStore({ ...options, persisted: await persistence.load() });
  inventory = [renamed];
  await relaunched.refresh(true);
  expect(relaunched.getSnapshot().homebrewItems).toMatchObject([
    { id: renamed.id, pinned: undefined }
  ]);
  expect(relaunched.getSnapshot().homebrewFormulaIdentityContinuity).toBeUndefined();
});

it.each([false, true])(
  "preserves pin evidence through a first renamed-rack failure and accepts explicit unpin %s",
  async (unpin) => {
    const previous = formula("old-tool", [], true);
    const renamed = formula("new-tool", [previous.token], unpin ? false : undefined);
    let inventory: HomebrewManagedItem[] = [missing(renamed)];
    const { store, options, persistence, runBrewCommand } = await setup(
      { ...defaultPersistedSnapshot(), homebrewItems: [previous] },
      () => inventory
    );
    await store.refresh(true);
    const relaunched = new UpdateStore({ ...options, persisted: await persistence.load() });
    inventory = [renamed];
    await relaunched.refresh(true);
    expect(relaunched.getSnapshot().homebrewItems[0]).toMatchObject({
      id: previous.id,
      pinned: !unpin
    });
    if (!unpin) {
      await relaunched.performHomebrewUpdate(previous.id);
      expect(runBrewCommand).not.toHaveBeenCalled();
    }
  }
);

it.each([false, true])(
  "keeps current versions and explicit unpin ahead of frozen records without accumulating or duplicating history (recovery changes version %s)",
  async (recoveryChangesVersion) => {
    const a = formula("old-alpha");
    const b = formula("old-beta", [], true);
    const newA = formula("new-alpha", [a.token]);
    const newB = formula("new-beta", [b.token]);
    const later = formula("later-tool");
    let inventory: HomebrewManagedItem[] = [missing(newA), b];
    const { store, options, persistence } = await setup(
      { ...defaultPersistedSnapshot(), homebrewItems: [a, b] },
      () => inventory
    );
    await store.refresh(true);
    inventory = [
      missing(newA),
      { ...b, installedVersion: version("2"), isOutdated: false, pinned: false },
      later
    ];
    await store.refresh(true);
    expect(store.getSnapshot().homebrewRecentlyUpdated).toHaveLength(1);
    expect(store.getSnapshot().homebrewRecentlyUpdated[0]).toMatchObject({
      itemID: b.id,
      toVersion: version("2")
    });
    expect(store.getSnapshot().homebrewFormulaIdentityContinuity?.map((item) => item.id)).toEqual([
      a.id,
      b.id
    ]);
    await store.refresh(true);
    expect(store.getSnapshot().homebrewRecentlyUpdated).toHaveLength(1);
    inventory = [missing(newA), { ...missing(newB), installedVersion: version("2") }];
    await store.refresh(true);
    const relaunched = new UpdateStore({ ...options, persisted: await persistence.load() });
    const recoveredVersion = version(recoveryChangesVersion ? "3" : "2");
    inventory = [newA, { ...newB, installedVersion: recoveredVersion, isOutdated: false }];
    await relaunched.refresh(true);
    expect(relaunched.getSnapshot().homebrewItems[1]).toMatchObject({
      id: b.id,
      installedVersion: recoveredVersion,
      pinned: undefined
    });
    expect(relaunched.getSnapshot().homebrewRecentlyUpdated).toHaveLength(1);
    expect(relaunched.getSnapshot().homebrewRecentlyUpdated[0]).toMatchObject({
      itemID: b.id,
      toVersion: recoveredVersion
    });
  }
);

it("does not inherit an ambiguous alias pin when a historical saved ID collides with the fresh rack ID", async () => {
  const a = { ...formula("old-alpha", [], true), id: "formula:new-tool" };
  const b = formula("old-beta", [], true);
  const renamed = formula("new-tool", [a.token, b.token]);
  const { store } = await setup({ ...defaultPersistedSnapshot(), homebrewItems: [a, b] }, () => [
    renamed
  ]);
  await store.refresh(true);
  expect(store.getSnapshot().homebrewItems[0]?.pinned).toBeUndefined();
});
