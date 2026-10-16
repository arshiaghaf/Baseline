// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  ProfileStatsEvent,
  UpdateRecord
} from "../src/shared/domain";
import { defaultPersistedSnapshot } from "../src/shared/domain";
import type { HomebrewMaintenanceRunEvent } from "../src/shared/homebrewProgress";
import { HomebrewMaintenanceProgressStage } from "../src/shared/homebrewProgress";
import type { CommandResult } from "../src/main/commandRunner";
import {
  HomebrewCommandService,
  TRANSIENT_HOMEBREW_FAILURE_MS,
  type HomebrewCommandHost
} from "../src/main/homebrewCommandService";
import type { OperationFailure } from "../src/shared/operationFailures";
import { version } from "../src/shared/version";

afterEach(() => {
  vi.useRealTimers();
});

type RefreshCall = {
  lightweight: boolean | undefined;
  options: Parameters<HomebrewCommandHost["refresh"]>[1];
  commandCount: number;
  commandLocked: boolean;
};

type FailureCall = {
  entityID: string;
  operation: OperationFailure["operation"];
  result: CommandResult;
  reason?: OperationFailure["reason"];
};

class FakeHost implements HomebrewCommandHost {
  state: BaselineSnapshot;
  brew = vi.fn<HomebrewCommandHost["runBrewCommand"]>(async () => successResult());
  commands: HomebrewMaintenanceRunEvent[] = [];
  stats: ProfileStatsEvent[] = [];
  failures: FailureCall[] = [];
  clearedFailures: Array<{ entityID: string; operation: OperationFailure["operation"] }> = [];
  refreshes: RefreshCall[] = [];
  notices: Array<string | undefined> = [];
  activeHomebrewInventoryCount = 0;
  homebrewRefreshLockSequence: number | undefined;
  homebrewCleanupRequiresInventory = false;
  hasCheckedHomebrewAvailability = true;
  refreshTask: Promise<void> | undefined;
  cleanupRefreshTask: Promise<void> | undefined;
  cleanupRefreshRequested = false;
  cleanupRefreshes = 0;
  commandCount: () => number = () => 0;
  statsGate: Promise<void> = Promise.resolve();

  constructor(state: BaselineSnapshot) {
    this.state = state;
  }

  get runBrewCommand(): HomebrewCommandHost["runBrewCommand"] {
    return this.brew;
  }

  patch(patch: Partial<BaselineSnapshot>): void {
    this.state = { ...this.state, ...patch };
  }

  emitHomebrewCommand(event: HomebrewMaintenanceRunEvent): void {
    this.commands.push(event);
  }

  async recordProfileStatsEvents(events: ProfileStatsEvent[]): Promise<void> {
    this.stats.push(...events);
    await this.statsGate;
  }

  recordOperationFailure(
    entityID: string,
    operation: OperationFailure["operation"],
    result: CommandResult,
    reason?: OperationFailure["reason"]
  ): Promise<void> {
    this.failures.push({ entityID, operation, result, reason });
    return Promise.resolve();
  }

  recordOperationFailures(
    failures: Array<{
      entityID: string;
      operation: OperationFailure["operation"];
      result: CommandResult;
      reason?: OperationFailure["reason"];
    }>
  ): Promise<void> {
    this.failures.push(...failures);
    return Promise.resolve();
  }

  clearOperationFailure(entityID: string, operation: OperationFailure["operation"]): void {
    this.clearedFailures.push({ entityID, operation });
  }

  refresh(
    lightweight?: boolean,
    options?: Parameters<HomebrewCommandHost["refresh"]>[1]
  ): Promise<void> {
    this.refreshes.push({
      lightweight,
      options,
      commandCount: this.commandCount(),
      commandLocked: this.state.isHomebrewCommandLocked
    });
    return Promise.resolve();
  }

  applyOperationNotice(message: string | undefined): void {
    this.notices.push(message);
  }

  refreshHomebrewCleanupInventory(): Promise<boolean> {
    this.cleanupRefreshes += 1;
    return Promise.resolve(true);
  }
}

function successResult(): CommandResult {
  return { success: true, status: 0, output: "" };
}

function runtimeSnapshot(patch: Partial<BaselineSnapshot> = {}): BaselineSnapshot {
  return {
    ...defaultPersistedSnapshot("2026-10-16T00:00:00.000Z"),
    isMasInstalled: false,
    isHomebrewInstalled: true,
    isChecking: false,
    isRefreshing: false,
    searchText: "",
    isRunningHomebrewMaintenance: false,
    isHomebrewCommandLocked: false,
    isHomebrewCleanupLocked: false,
    isCleaningUpHomebrew: false,
    appUpdatingIDs: [],
    appUpdatedPendingRefreshIDs: [],
    homebrewUpdatingItemIDs: [],
    homebrewQueuedItemIDs: [],
    homebrewUninstallingItemIDs: [],
    homebrewUpdatedPendingRefreshItemIDs: [],
    homebrewBatchProgressByItemID: {},
    homebrewBatchFailedItemIDs: [],
    homebrewFallbackProgressByAppID: {},
    homebrewFallbackFailedAppIDs: [],
    homebrewDiscoverItems: [],
    homebrewDiscoverInstallingItemIDs: [],
    homebrewDiscoverInstalledPendingRefreshItemIDs: [],
    homebrewDiscoverFailedItemIDs: [],
    homebrewDiscoverProgressByItemID: {},
    laggingHomebrewCaskTokens: [],
    defaultScanDirectories: [],
    ...patch
  };
}

function homebrewItem(
  patch: Partial<HomebrewManagedItem> & Pick<HomebrewManagedItem, "id" | "token" | "name">
): HomebrewManagedItem {
  return {
    kind: "formula",
    installedVersion: version("1.0.0"),
    isOutdated: false,
    ...(patch.kind === "cask"
      ? { fullToken: patch.token, tap: "homebrew/cask" }
      : {
          formulaIdentity: {
            name: patch.token,
            fullName: patch.token,
            tap: "homebrew/core",
            oldNames: []
          }
        }),
    ...patch
  };
}

function discoverItem(
  patch: Partial<HomebrewCaskDiscoveryItem> & Pick<HomebrewCaskDiscoveryItem, "id" | "token">
): HomebrewCaskDiscoveryItem {
  return {
    kind: "formula",
    displayName: patch.token,
    presentation: "formula",
    version: version("1.0.0"),
    ...patch
  };
}

function createService(
  patch: Partial<BaselineSnapshot> = {},
  successRefreshDelayMS = 0
): { host: FakeHost; service: HomebrewCommandService } {
  const host = new FakeHost(runtimeSnapshot(patch));
  const service = new HomebrewCommandService(host, successRefreshDelayMS);
  host.commandCount = () => service.activeCommandCount;
  return { host, service };
}

const outdatedFormula = () =>
  homebrewItem({
    id: "formula:ripgrep",
    token: "ripgrep",
    name: "ripgrep",
    kind: "formula",
    isOutdated: true,
    latestVersion: version("14.1.0")
  });

const outdatedCask = () =>
  homebrewItem({
    id: "cask:firefox",
    token: "firefox",
    name: "Firefox",
    kind: "cask",
    isOutdated: true,
    latestVersion: version("120.0.0")
  });

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  expect(predicate()).toBe(true);
}

describe("HomebrewCommandService", () => {
  it("keeps a refresh lock from reserving commands while cleanup can supersede it", () => {
    const { host, service } = createService();
    host.homebrewRefreshLockSequence = 4;

    expect(service.reserveHomebrewCommandLock()).toBeUndefined();
    expect(service.isHomebrewMutationActive()).toBe(false);

    const release = service.reserveHomebrewCommandLock({ allowRefreshSupersession: true });
    expect(release).toEqual(expect.any(Function));
    expect(service.activeCommandCount).toBe(1);
    release?.();

    host.homebrewRefreshLockSequence = undefined;
    host.activeHomebrewInventoryCount = 1;
    service.updateHomebrewCommandLockState();
    expect(host.state.isHomebrewCommandLocked).toBe(true);
    expect(host.state.isHomebrewCleanupLocked).toBe(true);
    expect(service.reserveHomebrewCommandLock({ allowRefreshSupersession: true })).toBeUndefined();

    host.activeHomebrewInventoryCount = 0;
    host.homebrewRefreshLockSequence = 4;
    service.updateHomebrewCommandLockState();
    expect(host.state.isHomebrewCommandLocked).toBe(true);
    expect(host.state.isHomebrewCleanupLocked).toBe(false);
  });

  it("upgrades one formula, holds, then refreshes while the command lock is still held", async () => {
    vi.useFakeTimers();
    const formula = outdatedFormula();
    const { host, service } = createService({ homebrewItems: [formula] }, 50);
    let releaseStats!: () => void;
    host.statsGate = new Promise<void>((resolve) => {
      releaseStats = resolve;
    });
    host.brew.mockImplementation(async (_command, onLine) => {
      onLine?.("==> Pouring ripgrep");
      return successResult();
    });

    const pending = service.performHomebrewUpdate(formula.id);
    await flushUntil(() => host.stats.length === 1);
    expect(host.refreshes).toHaveLength(0);
    expect(host.commands.map((event) => event.type)).toEqual([
      "commandStarted",
      "outputLine",
      "commandFinished"
    ]);
    expect(host.brew.mock.calls.map(([command]) => command)).toEqual([["upgrade", "ripgrep"]]);
    expect(host.stats[0]?.type).toBe("homebrewUpdate");
    expect(service.activeCommandCount).toBe(1);
    expect(host.state.homebrewBatchProgressByItemID[formula.id]).toBe(
      HomebrewMaintenanceProgressStage.finalizing
    );

    releaseStats();
    await flushUntil(() => host.state.homebrewUpdatedPendingRefreshItemIDs.includes(formula.id));
    expect(host.refreshes).toHaveLength(0);
    expect(host.state.homebrewBatchProgressByItemID[formula.id]).toBe(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(host.refreshes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(host.refreshes).toEqual([
      {
        lightweight: false,
        options: { allowHomebrewInventoryDuringActiveCommand: true },
        commandCount: 1,
        commandLocked: true
      }
    ]);
    expect(service.activeCommandCount).toBe(0);
    expect(host.state.isHomebrewCommandLocked).toBe(false);
    expect(host.state.homebrewBatchProgressByItemID[formula.id]).toBe(1);
  });

  it("upgrades a cask with the greedy cask arguments", async () => {
    const cask = outdatedCask();
    const { host, service } = createService({ homebrewItems: [cask] });

    await service.performHomebrewUpdate(cask.id);

    expect(host.brew.mock.calls.map(([command]) => command)).toEqual([
      ["upgrade", "--cask", "--greedy", "firefox"]
    ]);
  });

  it("skips pinned, self, and duplicate upgrade requests", async () => {
    const pinned = homebrewItem({
      id: "formula:wget",
      token: "wget",
      name: "wget",
      kind: "formula",
      isOutdated: true,
      pinned: true
    });
    const selfItem = homebrewItem({
      id: "cask:baseline",
      token: "baseline",
      name: "Baseline",
      kind: "cask",
      isOutdated: true,
      isSelf: true
    });
    const formula = outdatedFormula();
    const { host, service } = createService({ homebrewItems: [pinned, selfItem, formula] });
    let releaseBrew!: () => void;
    host.brew.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseBrew = () => resolve(successResult());
        })
    );

    await service.performHomebrewUpdate(pinned.id);
    await service.performHomebrewUpdate(selfItem.id);
    expect(host.brew).not.toHaveBeenCalled();

    const first = service.performHomebrewUpdate(formula.id);
    await flushUntil(() => host.brew.mock.calls.length === 1);
    await service.performHomebrewUpdate(formula.id);
    expect(host.brew).toHaveBeenCalledTimes(1);
    releaseBrew();
    await first;
    expect(host.brew).toHaveBeenCalledTimes(1);
  });

  it("runs update-all as update, formula upgrade, then greedy cask upgrade", async () => {
    const formula = outdatedFormula();
    const cask = outdatedCask();
    const { host, service } = createService({ homebrewItems: [cask, formula] });

    await service.performHomebrewUpdateAll();

    expect(host.brew.mock.calls.map(([command]) => command)).toEqual([
      ["update"],
      ["upgrade", "ripgrep"],
      ["upgrade", "--cask", "--greedy", "firefox"]
    ]);
    expect(host.state.isRunningHomebrewMaintenance).toBe(false);
    expect(host.refreshes[0]?.commandCount).toBe(1);
    expect(host.stats.map((event) => event.targetID).sort()).toEqual([cask.id, formula.id].sort());
  });

  it("leaves an app-backed cask out of update-all", async () => {
    const formula = outdatedFormula();
    const cask = homebrewItem({ ...outdatedCask(), appID: "app-firefox" });
    const app: AppRecord = {
      id: "app-firefox",
      bundlePath: "/Applications/Firefox.app",
      displayName: "Firefox",
      localVersion: version("119.0.0"),
      sourceHint: "sparkle"
    };
    const update: UpdateRecord = {
      id: app.id,
      appID: app.id,
      source: "sparkle",
      supportLevel: "limited",
      localVersion: version("119.0.0"),
      remoteVersion: version("120.0.0"),
      checkedAt: "2026-10-16T00:00:00.000Z"
    };
    const { host, service } = createService({
      apps: [app],
      updates: [update],
      homebrewItems: [formula, cask]
    });

    await service.performHomebrewUpdateAll();

    expect(host.brew.mock.calls.map(([command]) => command)).toEqual([
      ["update"],
      ["upgrade", "ripgrep"]
    ]);
  });

  it("records a partial update-all failure without treating the finished kind as failed", async () => {
    const formula = outdatedFormula();
    const cask = outdatedCask();
    const { host, service } = createService({ homebrewItems: [formula, cask] });
    host.brew.mockImplementation(async (command) => {
      if (command.includes("--cask")) {
        return {
          success: false,
          status: 1,
          output: "Error: cask upgrade failed",
          stderr: "Error: cask upgrade failed"
        };
      }
      return successResult();
    });

    await service.performHomebrewUpdateAll();

    expect(host.state.homebrewUpdatedPendingRefreshItemIDs).toEqual([formula.id]);
    expect(host.state.homebrewBatchFailedItemIDs).toEqual([cask.id]);
    expect(host.failures.map((failure) => failure.entityID)).toEqual([
      "homebrew:maintenance",
      cask.id
    ]);
    expect(host.failures[1]?.reason).toBeUndefined();
    expect(host.stats.map((event) => event.targetID)).toEqual([formula.id]);
    expect(host.refreshes).toHaveLength(1);
  });

  it("coalesces upgrades that were queued while inventory was active", async () => {
    const formula = outdatedFormula();
    const cask = outdatedCask();
    const { host, service } = createService({ homebrewItems: [formula, cask] });
    host.activeHomebrewInventoryCount = 1;

    const first = service.performHomebrewUpdate(formula.id);
    const second = service.performHomebrewUpdate(cask.id);
    await flushUntil(() => host.state.homebrewQueuedItemIDs.length === 2);
    expect(host.brew).not.toHaveBeenCalled();

    host.activeHomebrewInventoryCount = 0;
    await service.processHomebrewUpdateQueue();
    await Promise.all([first, second]);

    expect(host.brew.mock.calls.map(([command]) => command)).toEqual([
      ["upgrade", "ripgrep"],
      ["upgrade", "--cask", "--greedy", "firefox"]
    ]);
    expect(host.state.homebrewQueuedItemIDs).toEqual([]);
  });

  it("queues update-all behind an active command instead of starting brew update", async () => {
    const formula = outdatedFormula();
    const { host, service } = createService({ homebrewItems: [formula] });
    const release = service.reserveHomebrewCommandLock();
    expect(release).toEqual(expect.any(Function));

    await service.performHomebrewUpdateAll();
    expect(host.brew).not.toHaveBeenCalled();
    expect(host.state.homebrewQueuedItemIDs).toEqual([formula.id]);

    release?.();
    await flushUntil(() => host.refreshes.length === 1);
    expect(host.brew.mock.calls.map(([command]) => command)).toEqual([["upgrade", "ripgrep"]]);
  });

  it("clears a failed upgrade marker after the transient failure interval", async () => {
    vi.useFakeTimers();
    const formula = outdatedFormula();
    const { host, service } = createService({ homebrewItems: [formula] });
    host.brew.mockResolvedValue({
      success: false,
      status: 1,
      output: "Error: upgrade failed",
      stderr: "Error: upgrade failed"
    });

    await service.performHomebrewUpdate(formula.id);

    expect(host.failures.map((failure) => failure.entityID)).toEqual([formula.id]);
    expect(host.state.homebrewBatchFailedItemIDs).toEqual([formula.id]);
    expect(host.state.refreshErrorMessage).toBe("Homebrew update failed for ripgrep.");
    expect(host.refreshes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TRANSIENT_HOMEBREW_FAILURE_MS - 1);
    expect(host.state.homebrewBatchFailedItemIDs).toEqual([formula.id]);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.state.homebrewBatchFailedItemIDs).toEqual([]);
    expect(host.state.homebrewBatchProgressByItemID[formula.id]).toBeUndefined();
  });

  it("installs a formula and reports progress from brew output", async () => {
    const item = discoverItem({ id: "formula:fd", token: "fd", displayName: "fd" });
    const { host, service } = createService();
    host.brew.mockImplementation(async (_command, onLine) => {
      onLine?.("==> Pouring fd");
      return successResult();
    });

    await service.installHomebrewItem(item);

    expect(host.brew.mock.calls.map(([command]) => command)).toEqual([["install", "fd"]]);
    expect(host.commands.map((event) => event.type)).toEqual([
      "commandStarted",
      "outputLine",
      "commandFinished"
    ]);
    expect(host.stats.map((event) => event.type)).toEqual(["homebrewInstall"]);
    expect(host.state.homebrewDiscoverInstalledPendingRefreshItemIDs).toEqual([item.id]);
    expect(host.state.isHomebrewInstalled).toBe(true);
    expect(host.refreshes[0]?.options).toEqual({ allowHomebrewInventoryDuringActiveCommand: true });
    expect(host.refreshes[0]?.commandCount).toBe(1);
  });

  it("blocks an unsafe install token before running brew", async () => {
    const { host, service } = createService();

    await service.installHomebrewItem(
      discoverItem({ id: "formula:bad", token: "bad token", displayName: "Bad" })
    );

    expect(host.brew).not.toHaveBeenCalled();
    expect(host.state.refreshErrorMessage).toBe("Blocked unsafe Homebrew token for Bad.");
  });

  it("checks brew availability before installing when Homebrew was previously missing", async () => {
    const item = discoverItem({ id: "formula:fd", token: "fd" });
    const { host, service } = createService({ isHomebrewInstalled: false });
    host.brew.mockResolvedValue({ success: false, status: null, output: "" });

    await service.installHomebrewItem(item);

    expect(host.brew.mock.calls.map(([command]) => command)).toEqual([["--version"]]);
    expect(host.state.refreshErrorMessage).toBe(
      "Homebrew is not installed. Install Homebrew to install Discover items."
    );
    expect(host.state.homebrewDiscoverInstallingItemIDs).toEqual([]);
  });

  it("uninstalls a cask and keeps the command lock through the refresh", async () => {
    const cask = outdatedCask();
    const { host, service } = createService({ homebrewItems: [cask] });
    host.brew.mockImplementation(async (_command, onLine) => {
      onLine?.("Error: because it is required by other formulae");
      return {
        success: false,
        status: 1,
        output: "Error: because it is required by other formulae"
      };
    });

    await service.uninstallHomebrewItem(cask.id);

    expect(host.brew.mock.calls.map(([command]) => command)).toEqual([
      ["uninstall", "--cask", "firefox"]
    ]);
    expect(host.refreshes[0]?.commandCount).toBe(1);
    expect(host.failures.map((failure) => failure.operation)).toEqual(["uninstall"]);
    expect(host.state.refreshErrorMessage).toContain("Homebrew uninstall failed for Firefox.");
    expect(host.state.refreshErrorMessage).toContain("required by other formulae");
    expect(host.state.homebrewUninstallingItemIDs).toEqual([]);
  });

  it("refuses cleanup while inventory is active and does not ask for confirmation", async () => {
    const { host, service } = createService();
    host.activeHomebrewInventoryCount = 1;
    const confirm = vi.fn(async () => true);

    await expect(service.cleanUpHomebrew(confirm)).resolves.toBe(
      "Homebrew is busy. Try again when the current operation finishes."
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(host.brew).not.toHaveBeenCalled();
    expect(host.cleanupRefreshTask).toBeUndefined();
  });

  it("runs cleanup only after confirmation and publishes the cleanup refresh barrier first", async () => {
    const { host, service } = createService();
    let taskDuringConfirm: Promise<void> | undefined;

    const message = await service.cleanUpHomebrew(async () => {
      taskDuringConfirm = host.cleanupRefreshTask;
      host.cleanupRefreshRequested = true;
      return false;
    });

    expect(taskDuringConfirm).toEqual(expect.any(Promise));
    expect(host.brew).not.toHaveBeenCalled();
    expect(host.cleanupRefreshes).toBe(1);
    expect(message).toBe("");
    expect(host.cleanupRefreshTask).toBeUndefined();
    expect(host.state.isCleaningUpHomebrew).toBe(false);

    await service.cleanUpHomebrew(async () => true);
    expect(host.brew.mock.calls.map(([command]) => command)).toEqual([["cleanup"]]);
    expect(host.state.homebrewCleanupMessage).toBe("Homebrew cleanup completed.");
  });
});
