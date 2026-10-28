// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import { CLIService } from "../src/main/cliService";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  type HomebrewManagedItem,
  type PersistedSnapshot
} from "../src/shared/domain";
import { version } from "../src/shared/version";
import type { CLIOperation, CLIResponse } from "../src/shared/cli";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function storeFixture(persisted = defaultPersistedSnapshot()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-cli-store-"));
  const persistence = new SnapshotPersistence(directory);
  const item: HomebrewManagedItem = {
    id: "formula:example-tool",
    token: "example-tool",
    name: "Example Tool",
    kind: "formula",
    installedVersion: version("1"),
    latestVersion: version("2"),
    isOutdated: true,
    formulaIdentity: {
      name: "example-tool",
      fullName: "example-tool",
      tap: "homebrew/core",
      oldNames: []
    }
  };
  const installed = [item];
  let discoveryComplete = true;
  const command = vi.fn<
    (args: string[]) => Promise<{ success: boolean; status: number; output: string }>
  >(async () => ({ success: true, status: 0, output: "" }));
  const mas = vi.fn(async () => ({ success: false, status: 1, output: "No fixture helper" }));
  const openURL = vi.fn<(url: string) => Promise<boolean>>(async () => true);
  const openApp = vi.fn<(path: string) => Promise<void>>(async () => undefined);
  const store = new UpdateStore({
    persistence,
    persisted: { ...persisted, autoRefreshEnabled: false },
    currentAppVersion: "1.0.0",
    currentAppIdentity: {
      bundleIdentifier: "com.arshiaghaf.baseline",
      bundlePath: "/Fixtures/Baseline.app"
    },
    openExternalURL: openURL,
    openAppBundle: openApp,
    runBrewCommand: command,
    runMasCommand: mas,
    successRefreshDelayMS: 0,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => ({ ...stats, integrityStatus: "verified" }),
      seal: async (stats) => ({ ...stats, signature: "fixture" })
    },
    clients: {
      scanner: {
        scanApplications: async (directories, options) => {
          if (!discoveryComplete)
            options?.onRootRead?.({
              directory: directories[0] ?? "/Applications",
              complete: false
            });
          return persisted.apps;
        }
      },
      appStore: { lookupOutcome: async () => ({ type: "completed" }) },
      sparkle: { lookupOutcome: async () => ({ type: "completed" }) },
      homebrew: {
        fetchIndex: async () => emptyHomebrewCaskIndex,
        lookupUpdate: () => undefined,
        searchCasks: () => []
      },
      homebrewFormula: {
        fetchIndex: async () => ({
          byToken: { "example-tool": { token: "example-tool", version: version("2") } }
        }),
        searchFormulae: () => []
      },
      homebrewInventory: {
        fetchInventory: async () => ({
          items: structuredClone(installed),
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
  cleanups.push(async () => {
    await store.prepareToQuit();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    service: new CLIService(store, "1.0.0"),
    persistence,
    installed,
    command,
    mas,
    openURL,
    openApp,
    setDiscoveryComplete: (complete: boolean) => {
      discoveryComplete = complete;
    }
  };
}

it("reports a cold incomplete app scan as partial even with healthy Homebrew, then recovers", async () => {
  const f = await storeFixture();
  f.setDiscoveryComplete(false);
  expect(
    await terminal(f.service, await f.service.handle({ schemaVersion: 1, command: "check" }))
  ).toMatchObject({ state: "partial", exitCode: 1 });
  expect(f.store.getSnapshot()).toMatchObject({
    appDiscoveryComplete: false,
    refreshCheckFailed: false,
    homebrewCheckStatus: "complete",
    apps: []
  });
  expect(await f.service.handle({ schemaVersion: 1, command: "status" })).toMatchObject({
    data: { appDiscoveryComplete: false, freshForUpdates: false }
  });
  expect(
    await terminal(
      f.service,
      await f.service.handle({
        schemaVersion: 1,
        command: "update",
        ids: ["brew:formula:example-tool"],
        yes: true
      })
    )
  ).toMatchObject({ results: [{ status: "blocked" }] });
  expect(f.command.mock.calls.some(([args]) => args[0] === "upgrade")).toBe(false);
  f.setDiscoveryComplete(true);
  expect(
    await terminal(f.service, await f.service.handle({ schemaVersion: 1, command: "check" }))
  ).toMatchObject({ state: "succeeded", exitCode: 0 });
  expect(await f.service.handle({ schemaVersion: 1, command: "status" })).toMatchObject({
    data: { appDiscoveryComplete: true, freshForUpdates: true }
  });
  expect(f.store.getSnapshot().lastRefreshNoticeMessage ?? "").not.toContain("Some app folders");
});
async function terminal(service: CLIService, response: CLIResponse): Promise<CLIOperation> {
  expect(response.ok, JSON.stringify(response)).toBe(true);
  const id = (response.data as { operation: CLIOperation }).operation.id;
  for (let n = 0; n < 500; n++) {
    const result = await service.handle({
      schemaVersion: 1,
      command: "operation",
      operationID: id
    });
    const op = (result.data as { operation: CLIOperation }).operation;
    if (op.finishedAt) return op;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Operation did not finish");
}

it("shares real store admission, command locks, fresh inventory reconciliation and persistence with GUI callers", async () => {
  const f = await storeFixture();
  expect(
    await terminal(f.service, await f.service.handle({ schemaVersion: 1, command: "check" }))
  ).toMatchObject({ state: "succeeded" });
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.command.mockImplementation(async (args) => {
    if (args[0] === "upgrade") {
      entered();
      await gate;
      f.installed[0]!.installedVersion = version("2");
      f.installed[0]!.isOutdated = false;
    }
    return { success: true, status: 0, output: "" };
  });
  const operation = await f.service.handle({
    schemaVersion: 1,
    command: "update",
    ids: ["brew:formula:example-tool"],
    yes: true
  });
  let gui: Promise<void> | undefined;
  try {
    await running;
    gui = f.store.performHomebrewUpdate("formula:example-tool");
    expect(await f.service.handle({ schemaVersion: 1, command: "check" })).toMatchObject({
      exitCode: 4
    });
    expect(f.store.getSnapshot().isHomebrewCommandLocked).toBe(true);
  } finally {
    release();
    await gui;
  }
  expect(await terminal(f.service, operation)).toMatchObject({
    state: "succeeded",
    results: [{ id: "brew:formula:example-tool", status: "updated" }]
  });
  expect(
    f.command.mock.calls.filter(([args]) => args[0] === "upgrade").map(([args]) => args)
  ).toEqual([["upgrade", "example-tool"]]);
  expect((await f.persistence.load()).homebrewItems[0]!.installedVersion.raw).toBe("2");
  expect(f.store.getSnapshot().isHomebrewCommandLocked).toBe(false);
});

function appSnapshot(): PersistedSnapshot {
  const persisted = defaultPersistedSnapshot();
  persisted.apps = [
    {
      id: "fixture-app",
      bundlePath: "/Fixtures/Example.app",
      displayName: "Example",
      sourceHint: "sparkle",
      localVersion: version("1")
    }
  ];
  persisted.updates = [
    {
      id: "fixture-update",
      appID: "fixture-app",
      source: "sparkle",
      supportLevel: "supported",
      localVersion: version("1"),
      remoteVersion: version("2"),
      checkedAt: new Date().toISOString(),
      updateURL: "https://example.test/update",
      updateURLKind: "download"
    }
  ];
  return persisted;
}

it("uses explicit validated app handoffs without invoking mas or package mutations, and surfaces open failures", async () => {
  const persisted = appSnapshot();
  persisted.useMasForAppStoreUpdates = true;
  persisted.updates[0]!.source = "appStore";
  persisted.updates[0]!.appStoreItemID = 123;
  const f = await storeFixture(persisted);
  await f.store.performCLIAppHandoff("fixture-app");
  expect(f.openURL).toHaveBeenCalledWith("https://example.test/update");
  expect(f.mas).not.toHaveBeenCalled();
  expect(f.command).not.toHaveBeenCalled();
  f.openURL.mockResolvedValue(false);
  f.openApp.mockRejectedValue(new Error("Fixture bundle unavailable"));
  await expect(f.store.performCLIAppHandoff("fixture-app")).rejects.toThrow(/unavailable/);
  expect(f.openApp).toHaveBeenCalledWith("/Fixtures/Example.app");
});

it.each(["ignored", "self", "missing-update", "missing-app"])(
  "does not open a protected %s app handoff",
  async (scenario) => {
    const persisted = appSnapshot();
    if (scenario === "ignored") persisted.ignoredIDs = ["fixture-app"];
    if (scenario === "self") persisted.apps[0]!.bundleIdentifier = "com.arshiaghaf.baseline";
    if (scenario === "missing-update") persisted.updates = [];
    if (scenario === "missing-app") persisted.apps = [];
    const f = await storeFixture(persisted);
    await expect(f.store.performCLIAppHandoff("fixture-app")).rejects.toThrow(
      /no longer available/
    );
    expect(f.openURL).not.toHaveBeenCalled();
    expect(f.openApp).not.toHaveBeenCalled();
    expect(f.command).not.toHaveBeenCalled();
  }
);
