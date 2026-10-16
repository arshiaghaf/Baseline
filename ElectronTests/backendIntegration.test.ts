// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import path from "node:path";
import os from "node:os";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { isTrustedBackendSender } from "../src/main/backendIpcAuthorization";
import { catalogueCacheDirectory } from "../src/main/catalogueCacheDirectory";
import type { CommandResult, runBrewCommand } from "../src/main/commandRunner";
import {
  HomebrewInventoryClient,
  type HomebrewInventoryResult
} from "../src/main/homebrewInventoryClient";
import type { HomebrewInstalledMetadata } from "../src/main/homebrewInstalledMetadata";
import { SnapshotPersistence } from "../src/main/persistence";
import { UpdateStore } from "../src/main/updateStore";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type HomebrewManagedItem
} from "../src/shared/domain";
import { version } from "../src/shared/version";

const formula: HomebrewManagedItem = {
  id: "formula:example",
  kind: "formula",
  token: "example",
  name: "Example",
  installedVersion: version("1"),
  latestVersion: version("2"),
  isOutdated: true,
  formulaIdentityVerified: true,
  formulaIdentity: { name: "example", fullName: "example", tap: "homebrew/core", oldNames: [] }
};
const healthyInventory: HomebrewInventoryResult = {
  items: [formula],
  inventoryReadSucceededByKind: { formula: true, cask: true },
  outdatedDetectionSucceeded: true,
  outdatedDetectionSucceededByKind: { formula: true, cask: true }
};
const ok: CommandResult = { success: true, status: 0, output: "", stdout: "" };

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
    inventory?: () => Promise<HomebrewInventoryResult>;
    catalogueCacheRoot?: string;
    realCatalogueClients?: boolean;
  } = {}
) {
  const save = vi.fn(async () => undefined);
  const run = vi.fn(options.run ?? (async () => ok));
  const fetchInventory = vi.fn(options.inventory ?? (async () => healthyInventory));
  const store = new UpdateStore({
    persistence: { save } as unknown as SnapshotPersistence,
    persisted: {
      ...defaultPersistedSnapshot(),
      autoRefreshEnabled: false,
      homebrewItems: [formula]
    },
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    runBrewCommand: run,
    runMasCommand: async () => ok,
    successRefreshDelayMS: 0,
    catalogueCacheRoot: options.catalogueCacheRoot,
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
      homebrewInventory: { fetchInventory },
      ...(options.realCatalogueClients ? { homebrew: undefined, homebrewFormula: undefined } : {})
    }
  });
  return { store, run, save, fetchInventory };
}

describe("backend composition", () => {
  it("injects both durable catalogue adapters and restores them in a new store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-composition-"));
    const fetch = vi.fn(
      async () =>
        new Response("[]", { headers: { "cache-control": "max-age=600", etag: '"catalogue"' } })
    );
    vi.stubGlobal("fetch", fetch);
    const first = fixture({ catalogueCacheRoot: root, realCatalogueClients: true });
    let second: ReturnType<typeof fixture> | undefined;
    try {
      await first.store.refresh(true);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect((await readdir(root)).sort()).toEqual([
        "cask-catalogue-v1.cache",
        "formula-catalogue-v1.cache"
      ]);
      expect(first.store.getCatalogueDiagnostics()).toContain(
        "0 entries, 0 skipped, 0 schema warnings"
      );
      await first.store.prepareToQuit();
      second = fixture({ catalogueCacheRoot: root, realCatalogueClients: true });
      await second.store.refresh(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await first.store.prepareToQuit();
      await second?.store.prepareToQuit();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("awaits started inventory siblings before quarantining the shared reservation", async () => {
    const sibling = deferred<CommandResult>();
    const began = deferred<void>();
    const calls: string[] = [];
    const client = new HomebrewInventoryClient(async (args) => {
      const command = args.join(" ");
      calls.push(command);
      if (command === "info --installed --json=v2")
        return {
          success: false,
          status: null,
          output: "",
          failure: { kind: "cleanup", message: "Unconfirmed" }
        };
      if (command === "list --formula --versions") {
        began.resolve();
        return sibling.promise;
      }
      return ok;
    });
    const { store } = fixture({ inventory: () => client.fetchInventory() });
    const refresh = store.refresh(true);
    try {
      await began.promise;
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(true);
      expect(await store.collectHomebrewDiagnostics()).toEqual({ status: "busy" });
      expect(await store.prepareToQuit()).toBe(false);
      sibling.resolve(ok);
      await refresh;
      expect(calls).toHaveLength(5);
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(true);
      expect(store.getSnapshot().homebrewItems.every((item) => !item.isOutdated)).toBe(true);
      expect(await store.prepareToQuit()).toBe(true);
    } finally {
      sibling.resolve(ok);
      await refresh;
      await store.prepareToQuit();
    }
  });
  it("isolates rebuildable caches under an explicit user-data override", () => {
    expect(catalogueCacheDirectory("/home/test", "/tmp/isolated", true)).toBe(
      path.join("/tmp/isolated", "cache", "catalogues")
    );
    expect(catalogueCacheDirectory("/home/test", "/data", false)).toBe(
      path.join("/home/test", "Library", "Caches", "com.arshiaghaf.baseline", "catalogues")
    );
  });

  it("runs diagnostics only explicitly and holds the shared reservation until result settlement", async () => {
    const gate = deferred<CommandResult>();
    const { store, run, save } = fixture({ run: async () => gate.promise });
    await store.refresh(true);
    expect(run).not.toHaveBeenCalled();
    const request = store.collectHomebrewDiagnostics();
    try {
      expect(run).toHaveBeenCalledWith(
        ["config"],
        undefined,
        expect.objectContaining({ capture: "complete", timeoutMs: 15_000 })
      );
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(true);
      expect(await store.collectHomebrewDiagnostics({ doctor: true })).toEqual({ status: "busy" });
      await store.installHomebrewItem({
        id: "formula:new",
        kind: "formula",
        token: "new",
        displayName: "New",
        version: version("1")
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(await store.prepareToQuit()).toBe(false);
      gate.resolve({
        success: true,
        status: 0,
        output: "HOMEBREW_VERSION: 5.0.0\nHTTPS_PROXY: https://private-secret@example.test"
      });
      const report = await request;
      expect(report.status).toBe("complete");
      expect(JSON.stringify(report)).not.toContain("private-secret");
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(false);
      expect(JSON.stringify(save.mock.calls)).not.toContain("proxyConfigured");
      expect(JSON.stringify(store.getSnapshot())).not.toContain("certificateConfigured");
    } finally {
      gate.resolve(ok);
      await request;
      await store.prepareToQuit();
    }
  });

  it("reconciles an interrupted install before releasing the mutation reservation", async () => {
    const inventory = deferred<HomebrewInventoryResult>();
    const beganInventory = deferred<void>();
    const { store } = fixture({
      run: async () => ({
        success: false,
        status: null,
        output: "/private/output",
        failure: { kind: "cancelled", message: "Cancelled" }
      }),
      inventory: () => {
        beganInventory.resolve();
        return inventory.promise;
      }
    });
    const install = store.installHomebrewItem({
      id: "formula:new",
      kind: "formula",
      token: "new",
      displayName: "New",
      version: version("1")
    });
    try {
      await beganInventory.promise;
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(true);
      expect(await store.collectHomebrewDiagnostics()).toEqual({ status: "busy" });
      expect(await store.prepareToQuit()).toBe(false);
      inventory.resolve(healthyInventory);
      await install;
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(false);
      expect(store.getSnapshot().operationFailures?.[0]?.reason).toBe("interrupted");
      expect(JSON.stringify(store.getSnapshot())).not.toContain("/private/output");
    } finally {
      inventory.resolve(healthyInventory);
      await install;
      await store.prepareToQuit();
    }
  });

  it("quarantines uncertain cleanup before release, refuses further work and permits quitting", async () => {
    const { store, run, fetchInventory } = fixture({
      run: async () => ({
        success: false,
        status: null,
        output: "",
        failure: { kind: "cleanup", message: "Cleanup unconfirmed" }
      })
    });
    try {
      expect(
        (await store.collectHomebrewDiagnostics({ doctor: true, services: true })).status
      ).toBe("unavailable");
      expect(run).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().isHomebrewCommandLocked).toBe(true);
      expect(store.getSnapshot().lastRefreshNoticeMessage).toContain(
        "Check running Homebrew processes"
      );
      expect(await store.collectHomebrewDiagnostics()).toEqual({ status: "busy" });
      await store.refresh(true);
      expect(fetchInventory).not.toHaveBeenCalled();
      await store.performHomebrewUpdate(formula.id);
      expect(run).toHaveBeenCalledTimes(1);
      expect(await store.prepareToQuit()).toBe(true);
    } finally {
      await store.prepareToQuit();
    }
  });

  it("projects installed context without retaining caveat text or stale failed-read metadata", async () => {
    const metadata: HomebrewInstalledMetadata = {
      identity: "example",
      kind: "formula",
      caveats: "secret /Users/private/config",
      deprecated: true,
      installedAsDependency: true,
      installedReceipts: [{ version: "1", runtimeDependencies: [] }],
      dependencies: [{ kind: "formula", token: "dependency", scope: "runtime", source: "receipt" }],
      installedDependents: ["formula:dependent"]
    };
    let result: HomebrewInventoryResult = {
      ...healthyInventory,
      installedMetadataByItemID: { [formula.id]: metadata }
    };
    const { store, save } = fixture({ inventory: async () => result });
    try {
      expect(store.getHomebrewInstalledContext(formula.id)).toBeUndefined();
      await store.refresh(true);
      const context = store.getHomebrewInstalledContext(formula.id);
      expect(context).toMatchObject({
        deprecated: true,
        installedAsDependency: true,
        caveatsAvailable: true,
        observedRuntimeDependencyCount: 1,
        observedInstalledDependentCount: 1
      });
      expect(JSON.stringify(context)).not.toContain("secret");
      expect(JSON.stringify(save.mock.calls)).not.toContain("secret");
      expect(JSON.stringify(store.getSnapshot())).not.toContain("installedReceipts");
      result = {
        ...healthyInventory,
        inventoryReadSucceededByKind: { formula: false, cask: true }
      };
      await store.refresh(true);
      expect(store.getHomebrewInstalledContext(formula.id)).toBeUndefined();
    } finally {
      await store.prepareToQuit();
    }
  });
});

describe("new backend IPC authorization", () => {
  it("accepts only a known window's main frame at the exact app document", () => {
    const frame = { url: "file:///app/index.html#/settings" };
    const sender = { mainFrame: frame } as unknown as WebContents;
    const event = { sender, senderFrame: frame } as IpcMainInvokeEvent;
    expect(isTrustedBackendSender(event, [sender], "file:///app/index.html")).toBe(true);
    expect(isTrustedBackendSender(event, [], "file:///app/index.html")).toBe(false);
    expect(
      isTrustedBackendSender(
        { ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent,
        [sender],
        "file:///app/index.html"
      )
    ).toBe(false);
    frame.url = "https://untrusted.example/app/index.html";
    expect(isTrustedBackendSender(event, [sender], "file:///app/index.html")).toBe(false);
    frame.url = "file:///app/other.html";
    expect(isTrustedBackendSender(event, [sender], "file:///app/index.html")).toBe(false);
  });
});
