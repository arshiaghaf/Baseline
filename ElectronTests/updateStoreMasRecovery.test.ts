// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../src/main/commandRunner";
import { SnapshotPersistence } from "../src/main/persistence";
import { ProfileStatsIntegrityService } from "../src/main/profileStatsIntegrityService";
import { UpdateStore } from "../src/main/updateStore";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type AppRecord
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

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-mas-recovery-"));
  dirs.push(dir);
  const persistence = new SnapshotPersistence(dir);
  const scan = vi.fn(async () => [{ ...app, localVersion: version("2") }]);
  const mas = vi.fn<(args: string[]) => Promise<CommandResult>>(async () => available);
  const external = vi.fn(async () => true);
  const openApp = vi.fn(async () => undefined);
  const store = new UpdateStore({
    persistence,
    persisted: {
      ...defaultPersistedSnapshot(),
      autoRefreshEnabled: false,
      apps: [app],
      updates: [
        {
          id: app.id,
          appID: app.id,
          source: "appStore",
          localVersion: version("1"),
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
          inventoryReadSucceededByKind: { formula: true, cask: true },
          warning: "Inventory warning."
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
  return { store, persistence, scan, mas, external, openApp };
}

describe("App Store update recovery", () => {
  it.each([false, true])(
    "reconciles command success despite history save rejection (continued write failure: %s)",
    async (continuedFailure) => {
      const { store, persistence, scan, mas, external } = await fixture();
      scan.mockImplementation(async () => {
        expect(store.getSnapshot().appUpdatingIDs).toEqual([app.id]);
        expect(store.getSnapshot().appUpdatedPendingRefreshIDs).toEqual([app.id]);
        expect(store.hasActiveUpdateOperation()).toBe(true);
        return [{ ...app, localVersion: version("2") }];
      });
      const save = vi.spyOn(persistence, "save");
      if (continuedFailure) save.mockRejectedValue(new Error("fixture storage unavailable"));
      else save.mockRejectedValueOnce(new Error("fixture storage unavailable"));
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
