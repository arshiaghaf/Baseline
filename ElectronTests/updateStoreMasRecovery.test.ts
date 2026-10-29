// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { Dashboard } from "../src/renderer/components/Dashboard";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LookupOutcome } from "../src/main/appStoreLookupClient";
import type { CommandResult } from "../src/main/commandRunner";
import { SnapshotPersistence } from "../src/main/persistence";
import { ProfileStatsIntegrityService } from "../src/main/profileStatsIntegrityService";
import { UpdateStore } from "../src/main/updateStore";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type AppRecord,
  type AppStoreLookupResult
} from "../src/shared/domain";
import { version } from "../src/shared/version";

const app: AppRecord = {
  id: "/fixture/Utility.app",
  bundlePath: "/fixture/Utility.app",
  displayName: "Utility",
  sourceHint: "appStore",
  localVersion: version("1")
};
const available: CommandResult = { success: true, status: 0, output: "" };
const missing: CommandResult = {
  success: false,
  status: null,
  output: "",
  failure: { kind: "spawn", code: "ENOENT", message: "Executable was not found." }
};
const dirs: string[] = [];
const stores: UpdateStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.prepareToQuit()));
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture({ inventoryWarning = true, initialApp = app } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-mas-recovery-"));
  dirs.push(dir);
  const persistence = new SnapshotPersistence(dir);
  const apple = vi.fn(async (): Promise<LookupOutcome<AppStoreLookupResult>> => ({
    type: "completed"
  }));
  const scan = vi.fn(async () => [{ ...app, localVersion: version("2") }]);
  const mas = vi.fn<(args: string[]) => Promise<CommandResult>>(async () => available);
  const external = vi.fn(async () => true);
  const openApp = vi.fn(async () => undefined);
  const store = new UpdateStore({
    persistence,
    persisted: {
      ...defaultPersistedSnapshot(),
      autoRefreshEnabled: false,
      apps: [initialApp],
      updates: [
        {
          id: app.id,
          appID: app.id,
          source: "appStore",
          localVersion: initialApp.localVersion,
          localBuildVersion: initialApp.bundleVersion,
          remoteVersion: version("2"),
          appStoreItemID: 123,
          updateURL: "https://apps.apple.com/app/example",
          supportLevel: "supported",
          checkedAt: "2026-10-18T00:00:00.000Z"
        }
      ]
    },
    successRefreshDelayMS: 0,
    openExternalURL: external,
    openAppBundle: openApp,
    profileStatsIntegrity: new ProfileStatsIntegrityService(async () => "fixture-secret"),
    runBrewCommand: async () => ({ success: false, status: null, output: "" }),
    runMasCommand: mas,
    clients: {
      scanner: { scanApplications: scan },
      appStore: { lookupOutcome: apple },
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
          inventoryReadSucceededByKind: { formula: true, cask: true },
          warning: inventoryWarning ? "Inventory warning." : undefined
        })
      },
      selfUpdate: {
        lookup: async (currentVersion, checkedAt) => ({
          available: false,
          currentVersion,
          checkedAt,
          releaseURL: "https://example.com/releases"
        })
      }
    }
  });
  stores.push(store);
  return { store, persistence, scan, mas, external, openApp, apple };
}

describe("App Store update recovery", () => {
  it.each(["", "Nothing to upgrade"])(
    "never counts successful no-op retries (%j)",
    async (output) => {
      const initialApp = { ...app, bundleIdentifier: "org.example.utility" };
      const { store, scan, mas, apple, persistence } = await fixture({
        inventoryWarning: false,
        initialApp
      });
      scan.mockResolvedValue([initialApp]);
      mas.mockResolvedValue({ ...available, output });
      apple.mockResolvedValue({
        type: "completed",
        value: { remoteVersion: version("2"), appStoreItemID: 123 }
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        await store.performAppUpdate(app.id);
        expect(store.getSnapshot().updates).toHaveLength(1);
        expect(store.getSnapshot().profileStats.events).toEqual([]);
        expect(store.getSnapshot().appUpdatedPendingRefreshIDs).toEqual([]);
        expect((await persistence.load()).profileStats.events).toEqual([]);
      }
      expect(mas).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    ["unchanged", "1", "10", "1", "10", false],
    ["equivalent", "1.0", "10", "1.0.0", "10", false],
    ["marketing", "1", "10", "2", "1", true],
    ["build", "1", "10", "1", "11", true],
    ["downgrade", "2", "10", "1", "11", false],
    ["missing build", "1", "", "1", "11", false],
    ["missing version", "1", "10", "", "11", false]
  ] as const)(
    "records only observed installation advancement: %s",
    async (_label, before, beforeBuild, after, afterBuild, changed) => {
      const { store, scan, persistence, mas } = await fixture({
        inventoryWarning: false,
        initialApp: { ...app, localVersion: version(before), bundleVersion: version(beforeBuild) }
      });
      scan.mockResolvedValue([
        { ...app, localVersion: version(after), bundleVersion: version(afterBuild) }
      ]);
      await store.performAppUpdate(app.id);
      expect(mas).toHaveBeenCalledOnce();
      expect(store.getSnapshot().profileStats.events).toHaveLength(changed ? 1 : 0);
      expect((await persistence.load()).profileStats.events).toHaveLength(changed ? 1 : 0);
      expect(store.getSnapshot().appUpdatedPendingRefreshIDs).toEqual([]);
      if (!changed)
        expect(store.getSnapshot().lastRefreshNoticeMessage).toContain("could not be confirmed");
    }
  );

  it.each(["absent", "replaced", "unreadable"] as const)(
    "does not count a zero exit when the app is %s after the command",
    async (outcome) => {
      const { store, scan, external, openApp } = await fixture({ inventoryWarning: false });
      if (outcome === "unreadable") scan.mockRejectedValue(new Error("fixture scan unavailable"));
      else
        scan.mockResolvedValue(
          outcome === "absent"
            ? []
            : [{ ...app, localVersion: version("2"), bundleIdentifier: "org.example.replacement" }]
        );
      await store.performAppUpdate(app.id);
      expect(store.getSnapshot().profileStats.events).toEqual([]);
      expect(store.getSnapshot().appUpdatedPendingRefreshIDs).toEqual([]);
      expect(store.getSnapshot().lastRefreshNoticeMessage).toContain("could not be confirmed");
      expect(external).not.toHaveBeenCalled();
      expect(openApp).not.toHaveBeenCalled();
    }
  );

  it("keeps no-ops uncounted and coalesces overlapping actions through reconciliation", async () => {
    const { store, scan, mas } = await fixture({ inventoryWarning: false });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scan.mockImplementation(async () => {
      await gate;
      return [app];
    });
    const first = store.performAppUpdate(app.id);
    try {
      await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
      expect(store.getSnapshot().appUpdatedPendingRefreshIDs).toEqual([]);
      expect(store.getSnapshot().profileStats.events).toEqual([]);
      await store.performAppUpdate(app.id);
      expect(mas).toHaveBeenCalledOnce();
      expect(await store.prepareToQuit()).toBe(false);
    } finally {
      release();
      await first;
    }
    expect(store.getSnapshot().profileStats.events).toEqual([]);
  });

  it.each([false, true])(
    "reconciles command success despite history save rejection (continued write failure: %s)",
    async (continuedFailure) => {
      const { store, persistence, scan, mas, external } = await fixture();
      scan.mockImplementation(async () => {
        expect(store.getSnapshot().appUpdatingIDs).toEqual([app.id]);
        expect(store.getSnapshot().appUpdatedPendingRefreshIDs).toEqual([]);
        expect(store.hasActiveUpdateOperation()).toBe(true);
        return [{ ...app, localVersion: version("2") }];
      });
      const originalSave = persistence.save.bind(persistence);
      const save = vi.spyOn(persistence, "save");
      if (continuedFailure) save.mockRejectedValue(new Error("fixture storage unavailable"));
      else {
        let rejected = false;
        save.mockImplementation(async (snapshot) => {
          if (!rejected && snapshot.profileStats.events.length > 0) {
            rejected = true;
            throw new Error("fixture storage unavailable");
          }
          await originalSave(snapshot);
        });
      }
      try {
        if (continuedFailure)
          await expect(store.performAppUpdate(app.id)).rejects.toThrow(
            "fixture storage unavailable"
          );
        else await store.performAppUpdate(app.id);
        expect(scan).toHaveBeenCalledOnce();
        expect(mas).toHaveBeenCalledExactlyOnceWith(["upgrade", "123"]);
        expect(external).not.toHaveBeenCalled();
        const snapshot = store.getSnapshot();
        expect(snapshot.apps[0]!.localVersion.raw).toBe("2");
        expect(snapshot.operationFailures).toEqual([]);
        expect(snapshot.appUpdatingIDs).toEqual([]);
        expect(snapshot.appUpdatedPendingRefreshIDs).toEqual([]);
        expect(snapshot.lastRefreshNoticeMessage).toMatch(
          /Inventory warning.*local update history could not be saved/
        );
        if (continuedFailure)
          expect(snapshot.refreshErrorMessage).toBe("fixture storage unavailable");
        else {
          expect(snapshot.refreshErrorMessage).toBeUndefined();
          expect((await persistence.load()).apps[0]!.localVersion.raw).toBe("2");
          expect((await persistence.load()).profileStats.events).toHaveLength(0);
          await store.refresh(false);
          expect((await persistence.load()).profileStats.events).toHaveLength(1);
        }
        expect(snapshot.profileStats.events).toHaveLength(1);
        await store.performAppUpdate(app.id);
        expect(mas).toHaveBeenCalledOnce();
      } finally {
        save.mockRestore();
      }
    }
  );

  it("bypasses known unavailable mas, preserves the preference and recovers after Check Again", async () => {
    const { store, mas, external, persistence } = await fixture();
    mas.mockResolvedValue(missing);
    await store.refreshToolStatus();
    expect(store.getSnapshot().isMasInstalled).toBe(false);
    mas.mockClear();
    const save = vi.spyOn(persistence, "save");
    await store.performAppUpdate(app.id);
    expect(mas).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(external).toHaveBeenCalledWith("https://apps.apple.com/app/example");
    expect(store.getSnapshot().operationFailures).toEqual([]);
    expect(store.getSnapshot().useMasForAppStoreUpdates).toBe(true);
    mas.mockResolvedValue(available);
    await store.refreshToolStatus();
    expect(store.getSnapshot().isMasInstalled).toBe(true);
    await store.performAppUpdate(app.id);
    expect(mas.mock.calls.map(([args]) => args)).toEqual([["version"], ["upgrade", "123"]]);
    expect(store.getSnapshot().profileStats.events).toHaveLength(1);
  });

  it.each([false, true])(
    "falls back without app failure when mas disappears (readiness known: %s)",
    async (checked) => {
      const { store, mas, external, persistence } = await fixture();
      if (checked) await store.refreshToolStatus();
      mas.mockClear();
      mas.mockResolvedValue(missing);
      const save = vi.spyOn(persistence, "save");
      await store.performAppUpdate(app.id);
      await store.performAppUpdate(app.id);
      expect(mas).toHaveBeenCalledExactlyOnceWith(["upgrade", "123"]);
      expect(save).not.toHaveBeenCalled();
      expect(external).toHaveBeenCalledTimes(2);
      expect(store.getSnapshot().isMasInstalled).toBe(false);
      expect(store.getSnapshot().operationFailures).toEqual([]);
      expect(store.getSnapshot().appUpdatingIDs).toEqual([]);
      expect(store.getSnapshot().profileStats.events).toEqual([]);
      expect(store.getSnapshot().useMasForAppStoreUpdates).toBe(true);
    }
  );

  it.each([
    { success: false, status: 1, output: "" },
    {
      success: false,
      status: null,
      output: "",
      failure: { kind: "spawn", code: "EACCES", message: "Command could not start." }
    },
    {
      success: false,
      status: null,
      output: "",
      failure: { kind: "timeout", message: "Command timed out." }
    }
  ] satisfies CommandResult[])(
    "retains genuine installed-mas failures before fallback: %j",
    async (result) => {
      const { store, mas, external } = await fixture();
      await store.refreshToolStatus();
      mas.mockClear();
      mas.mockResolvedValue(result);
      await store.performAppUpdate(app.id);
      expect(mas).toHaveBeenCalledExactlyOnceWith(["upgrade", "123"]);
      expect(external).toHaveBeenCalledWith("https://apps.apple.com/app/example");
      expect(store.getSnapshot().operationFailures).toMatchObject([
        {
          entityID: app.id,
          operation: "update",
          reason: result.failure?.kind === "timeout" ? "interrupted" : "command"
        }
      ]);
      expect(store.getSnapshot().profileStats.events).toEqual([]);
      expect(store.getSnapshot().isMasInstalled).toBe(true);
      expect(store.getSnapshot().masAvailability).toBe("unknown");
    }
  );

  it("preserves detected readiness after an inconclusive version probe and still uses mas", async () => {
    const { store, mas } = await fixture();
    await store.refreshToolStatus();
    mas.mockResolvedValueOnce({
      success: false,
      status: null,
      output: "",
      failure: { kind: "timeout", message: "Probe timed out." }
    });
    await store.refreshToolStatus();
    expect(store.getSnapshot().isMasInstalled).toBe(true);
    expect(store.getSnapshot().masAvailability).toBe("unknown");
    await store.performAppUpdate(app.id);
    expect(mas).toHaveBeenCalledWith(["upgrade", "123"]);
    expect(store.getSnapshot().profileStats.events).toHaveLength(1);
  });

  it.each([
    { success: false, status: 1, output: "" },
    {
      success: false,
      status: null,
      output: "",
      failure: { kind: "timeout", message: "Probe timed out." }
    },
    {
      success: false,
      status: null,
      output: "",
      failure: { kind: "signal", message: "Probe was interrupted." }
    },
    {
      success: false,
      status: null,
      output: "",
      failure: { kind: "spawn", code: "EACCES", message: "Probe could not start." }
    }
  ] satisfies CommandResult[])(
    "does not hide an upgrade failure after an inconclusive probe: %j",
    async (probeResult) => {
      const { store, mas, external } = await fixture();
      mas.mockImplementation(async (args) =>
        args[0] === "version" ? probeResult : { success: false, status: 1, output: "" }
      );
      await store.refreshToolStatus();
      await store.performAppUpdate(app.id);
      expect(mas.mock.calls.map(([args]) => args)).toEqual([["version"], ["upgrade", "123"]]);
      expect(external).toHaveBeenCalledOnce();
      expect(store.getSnapshot().operationFailures).toMatchObject([
        { entityID: app.id, operation: "update", reason: "command" }
      ]);
    }
  );

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false]
  ] as const)(
    "retains newer command availability when a probe settles late (probe first: %s, command succeeds: %s)",
    async (probeFirst, succeeds) => {
      const { store, mas } = await fixture();
      let releaseProbe!: (result: CommandResult) => void;
      const probeGate = new Promise<CommandResult>((resolve) => {
        releaseProbe = resolve;
      });
      let releaseCommand!: (result: CommandResult) => void;
      const commandGate = new Promise<CommandResult>((resolve) => {
        releaseCommand = resolve;
      });
      mas.mockImplementation((args) => (args[0] === "version" ? probeGate : commandGate));
      const tasks: Promise<void>[] = [];
      const start = async (probe: boolean) => {
        const task = probe ? store.refreshToolStatus() : store.performAppUpdate(app.id);
        tasks.push(task);
        void task.catch(() => undefined);
        await vi.waitFor(() =>
          expect(mas).toHaveBeenCalledWith(probe ? ["version"] : ["upgrade", "123"])
        );
        return { task };
      };
      try {
        const first = await start(probeFirst);
        const second = await start(!probeFirst);
        const updating = probeFirst ? second.task : first.task;
        const checking = probeFirst ? first.task : second.task;
        releaseCommand(succeeds ? available : missing);
        await updating;
        releaseProbe(succeeds ? missing : available);
        await checking;
        expect(store.getSnapshot().isMasInstalled).toBe(succeeds);
        expect(store.getSnapshot().masAvailability).toBe(succeeds ? "available" : "missing");
        expect(store.getSnapshot().operationFailures).toEqual([]);
      } finally {
        releaseCommand(succeeds ? available : missing);
        releaseProbe(succeeds ? missing : available);
        await Promise.allSettled(tasks);
      }
    }
  );
});

it.each([false, true])(
  "keeps a successful Homebrew check separate from an actual history-save failure (compact=%s)",
  async (compact) => {
    const { store, persistence } = await fixture({ inventoryWarning: false });
    const originalSave = persistence.save.bind(persistence);
    const save = vi.spyOn(persistence, "save").mockImplementation(async (snapshot) => {
      if (snapshot.profileStats.events.length > 0) throw new Error("Fixture history write failure");
      await originalSave(snapshot);
    });
    try {
      await store.performAppUpdate(app.id);
      const snapshot = store.getSnapshot();
      expect(snapshot.homebrewCheckStatus).toBe("complete");
      expect(snapshot.homebrewCheckNoticeMessage).toBeUndefined();
      expect(snapshot.refreshErrorMessage).toBeUndefined();
      expect(snapshot.lastRefreshNoticeMessage).toContain(
        "local update history could not be saved"
      );
      render(
        createElement(Dashboard, {
          snapshot: { ...snapshot, selectedTab: "homebrew" },
          compact,
          onOpenSettings: () => undefined
        })
      );
      expect(screen.getByText("All your Homebrew items are up to date.")).toBeVisible();
      expect(
        screen.getByText(/App update completed, but local update history could not be saved/)
      ).toBeVisible();
      expect(
        screen.queryByText(/Homebrew update information may be incomplete/)
      ).not.toBeInTheDocument();
    } finally {
      save.mockRestore();
    }
  }
);
