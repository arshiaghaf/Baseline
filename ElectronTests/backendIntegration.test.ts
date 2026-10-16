// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { isTrustedBackendSender } from "../src/main/backendIpcAuthorization";
import type { CommandResult, runBrewCommand } from "../src/main/commandRunner";
import {
  HomebrewInventoryClient,
  type HomebrewInventoryResult
} from "../src/main/homebrewInventoryClient";
import {
  buildInstalledMetadata,
  type HomebrewInstalledMetadata
} from "../src/main/homebrewInstalledMetadata";
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
    save?: () => Promise<void>;
    scan?: () => Promise<never[]>;
    savedItems?: HomebrewManagedItem[];
  } = {}
) {
  const save = vi.fn(options.save ?? (async () => undefined));
  const run = vi.fn(options.run ?? (async () => ok));
  const fetchInventory = vi.fn(options.inventory ?? (async () => healthyInventory));
  const store = new UpdateStore({
    persistence: { save } as unknown as SnapshotPersistence,
    persisted: {
      ...defaultPersistedSnapshot(),
      autoRefreshEnabled: false,
      homebrewItems: options.savedItems ?? [formula]
    },
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    runBrewCommand: run,
    runMasCommand: async () => ok,
    successRefreshDelayMS: 0,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    },
    clients: {
      scanner: { scanApplications: options.scan ?? (async () => []) },
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
      homebrewInventory: { fetchInventory }
    }
  });
  return { store, run, save, fetchInventory };
}

describe("backend composition", () => {
  it.each([
    "healthy",
    "provider failure",
    "inventory failure",
    "failure-details save only",
    "persistence failure",
    "cleanup uncertainty",
    "cleanup and persistence failure"
  ])(
    "retains the failed install outcome and current warnings after %s reconciliation",
    async (scenario) => {
      vi.useFakeTimers();
      let saveCount = 0;
      const { store, save } = fixture({
        run: async () => ({ ...ok, success: false, status: 1, output: "private install output" }),
        save: async () => {
          if (
            scenario.includes("persistence failure") ||
            (scenario === "failure-details save only" && saveCount++ === 0)
          )
            throw new Error("Reconciliation save failed.");
        },
        scan: async () => {
          if (scenario === "provider failure") throw new Error("Application scan failed.");
          return [];
        },
        inventory: async () => {
          if (scenario === "inventory failure") throw new Error("Inventory read failed.");
          return {
            ...healthyInventory,
            warning: "Fresh inventory warning.",
            ...(scenario.startsWith("cleanup") ? { cleanupUnconfirmed: true } : {})
          };
        }
      });
      try {
        await store
          .installHomebrewItem({
            id: "formula:new",
            kind: "formula",
            token: "new",
            displayName: "New",
            version: version("1")
          })
          .catch((error: Error) => {
            expect(scenario).toContain("persistence failure");
            expect(error.message).toBe("Reconciliation save failed.");
          });
        const state = store.getSnapshot();
        expect(state.refreshErrorMessage).toContain("Homebrew install failed for New.");
        if (scenario === "provider failure")
          expect(state.refreshErrorMessage).toContain("Application scan failed.");
        if (scenario === "inventory failure")
          expect(state.refreshErrorMessage).toContain("Inventory read failed.");
        if (scenario.includes("persistence failure")) {
          expect(state.refreshErrorMessage).toContain("Reconciliation save failed.");
        }
        if (scenario.includes("persistence failure") || scenario === "failure-details save only")
          expect(state.lastRefreshNoticeMessage).toContain("Failure details could not be saved.");
        if (!scenario.startsWith("cleanup") && scenario !== "inventory failure")
          expect(state.lastRefreshNoticeMessage).toContain("Fresh inventory warning.");
        if (scenario.startsWith("cleanup")) {
          expect(state.lastRefreshNoticeMessage).toContain("Check running Homebrew processes");
          expect(state.isHomebrewCommandLocked).toBe(true);
        }
        expect(JSON.stringify(state)).not.toContain("private install output");
        await vi.advanceTimersByTimeAsync(4_001);
        expect(store.getSnapshot().homebrewDiscoverFailedItemIDs).not.toContain("formula:new");
        expect(store.getSnapshot().refreshErrorMessage).toContain(
          "Homebrew install failed for New."
        );
      } finally {
        save.mockResolvedValue(undefined);
        await store.prepareToQuit();
        vi.useRealTimers();
      }
    }
  );

  it("does not restore an unrelated old notice when failed-install reconciliation succeeds", async () => {
    let warning: string | undefined = "Old unrelated inventory warning.";
    const { store } = fixture({
      run: async () => ({ ...ok, success: false, status: 1 }),
      inventory: async () => ({ ...healthyInventory, warning })
    });
    try {
      await store.refresh(true);
      expect(store.getSnapshot().lastRefreshNoticeMessage).toBe(warning);
      warning = undefined;
      await store.installHomebrewItem({
        id: "formula:new",
        kind: "formula",
        token: "new",
        displayName: "New",
        version: version("1")
      });
      expect(store.getSnapshot().refreshErrorMessage).toBe("Homebrew install failed for New.");
      expect(store.getSnapshot().lastRefreshNoticeMessage).toBeUndefined();
    } finally {
      await store.prepareToQuit();
    }
  });

  it("binds fresh metadata to the saved ID only through a unique verified renamed identity", async () => {
    const previous = {
      ...formula,
      id: "formula:old",
      token: "old",
      formulaIdentity: {
        name: "old",
        fullName: "vendor/tools/old",
        tap: "vendor/tools",
        oldNames: []
      }
    };
    const renamed = {
      ...formula,
      id: "formula:new",
      token: "new",
      formulaIdentity: {
        name: "new",
        fullName: "vendor/tools/new",
        tap: "vendor/tools",
        oldNames: ["old"]
      }
    };
    const metadata: HomebrewInstalledMetadata = {
      identity: "vendor/tools/new",
      kind: "formula",
      deprecated: true,
      caveats: "private renamed caveats",
      installedReceipts: [],
      dependencies: [],
      installedDependents: []
    };
    let inventory: HomebrewInventoryResult = {
      ...healthyInventory,
      items: [renamed],
      installedMetadataByItemID: { [renamed.id]: metadata }
    };
    const { store, save } = fixture({ savedItems: [previous], inventory: async () => inventory });
    try {
      await store.refresh(true);
      expect(store.getSnapshot().homebrewItems[0]?.id).toBe(previous.id);
      expect(store.getHomebrewInstalledContext(previous.id)).toMatchObject({
        deprecated: true,
        caveatsAvailable: true
      });
      expect(store.getHomebrewInstalledContext(renamed.id)).toBeUndefined();
      expect(JSON.stringify(save.mock.calls)).not.toContain("private renamed caveats");
      inventory = { ...inventory, inventoryReadSucceededByKind: { formula: false, cask: true } };
      await store.refresh(true);
      expect(store.getHomebrewInstalledContext(previous.id)).toBeUndefined();
    } finally {
      await store.prepareToQuit();
    }
  });

  it.each(["duplicate inventory", "duplicate metadata", "unverified", "different tap", "absent"])(
    "rejects installed context for %s rather than using ID or token continuity",
    async (scenario) => {
      const metadata: HomebrewInstalledMetadata = {
        identity: "example",
        kind: "formula",
        installedReceipts: [],
        dependencies: [],
        installedDependents: []
      };
      const { store } = fixture({
        inventory: async () => ({
          ...healthyInventory,
          items:
            scenario === "absent"
              ? []
              : scenario === "duplicate inventory"
                ? [formula, { ...formula, id: "formula:duplicate" }]
                : [
                    {
                      ...formula,
                      ...(scenario === "unverified" ? { formulaIdentityVerified: false } : {}),
                      ...(scenario === "different tap"
                        ? {
                            formulaIdentity: {
                              name: "example",
                              fullName: "vendor/tools/example",
                              tap: "vendor/tools",
                              oldNames: []
                            }
                          }
                        : {})
                    }
                  ],
          installedMetadataByItemID: {
            [formula.id]: metadata,
            ...(scenario === "duplicate metadata" ? { duplicate: metadata } : {})
          }
        })
      });
      try {
        await store.refresh(true);
        expect(store.getHomebrewInstalledContext(formula.id)).toBeUndefined();
      } finally {
        await store.prepareToQuit();
      }
    }
  );

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
      installedOnRequest: false,
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
        installedOnRequest: false,
        caveatsAvailable: true,
        observedRuntimeDependencyCount: 1,
        observedInstalledDependentCount: 1
      });
      expect(context).not.toHaveProperty("installedAsDependency");
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

  it("keeps serialized cask info separate from formula receipt counts in installed context", async () => {
    const cask: HomebrewManagedItem = {
      id: "cask:desktop",
      kind: "cask",
      token: "desktop",
      fullToken: "desktop",
      tap: "homebrew/cask",
      name: "Desktop",
      installedVersion: version("1"),
      isOutdated: false
    };
    // Cask::Cask#to_h emits installed/version fields, not Formula installed-keg records.
    const metadata = buildInstalledMetadata(
      [cask],
      { ...ok, stdout: '{"formulae":[]}' },
      {
        ...ok,
        stdout: JSON.stringify({
          casks: [
            {
              token: "desktop",
              full_token: "desktop",
              tap: "homebrew/cask",
              version: "2",
              installed: "1",
              installed_time: 1700000000,
              auto_updates: true,
              caveats: "private cask prose /Users/private/settings",
              depends_on: { formula: ["dependency"] }
            }
          ]
        })
      }
    );
    const { store, save } = fixture({
      inventory: async () => ({
        ...healthyInventory,
        items: [cask],
        installedMetadataByItemID: metadata
      })
    });
    try {
      await store.refresh(true);
      expect(store.getHomebrewInstalledContext(cask.id)).toEqual({
        deprecated: undefined,
        disabled: undefined,
        autoUpdates: true,
        installedOnRequest: undefined,
        caveatsAvailable: true,
        installedReceiptCount: 0,
        declaredDependencyCount: 1,
        observedRuntimeDependencyCount: 0,
        observedInstalledDependentCount: 0
      });
      expect(JSON.stringify(save.mock.calls)).not.toContain("private cask prose");
      expect(JSON.stringify(store.getSnapshot())).not.toContain("caskInstalledVersion");
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
