// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { defaultPersistedSnapshot, type HomebrewManagedItem } from "../src/shared/domain";
import { version } from "../src/shared/version";
import { HomebrewWorkLock } from "../src/main/homebrewWorkLock";
import {
  HomebrewOperationsService,
  type HomebrewOperationsState
} from "../src/main/homebrewOperationsService";
import type { CommandResult } from "../src/main/commandRunner";

function formula(patch: Partial<HomebrewManagedItem> = {}): HomebrewManagedItem {
  return {
    id: "formula:example",
    kind: "formula",
    token: "example",
    name: "Example",
    installedVersion: version("1.0"),
    isOutdated: true,
    formulaIdentity: {
      name: "example",
      fullName: "example",
      tap: "homebrew/core",
      oldNames: []
    },
    ...patch
  };
}

function harness(
  run: (args: string[], onLine?: (line: string) => void) => Promise<CommandResult> = async () => ({
    success: true,
    status: 0,
    output: ""
  })
) {
  let state: HomebrewOperationsState = {
    ...defaultPersistedSnapshot(),
    homebrewItems: [formula()],
    homebrewUpdatingItemIDs: [],
    homebrewQueuedItemIDs: [],
    homebrewBatchFailedItemIDs: [],
    homebrewBatchProgressByItemID: {},
    homebrewUpdatedPendingRefreshItemIDs: [],
    homebrewDiscoverInstallingItemIDs: [],
    homebrewDiscoverFailedItemIDs: [],
    homebrewDiscoverProgressByItemID: {},
    homebrewDiscoverInstalledPendingRefreshItemIDs: [],
    homebrewUninstallingItemIDs: [],
    isRunningHomebrewMaintenance: false,
    isHomebrewInstalled: true
  };
  const runCommand = vi.fn(run);
  const refresh = vi.fn(async () => undefined);
  const stats = vi.fn(async () => undefined);
  const failure = vi.fn(async () => undefined);
  const events: string[] = [];
  const lock = new HomebrewWorkLock<never>({
    hasOtherMutation: () =>
      state.isRunningHomebrewMaintenance ||
      state.homebrewUninstallingItemIDs.length > 0 ||
      state.homebrewDiscoverInstallingItemIDs.length > 0,
    onLockStateChange: () => undefined,
    onCommandReleased: () => void service.processHomebrewUpdateQueue()
  });
  const service = new HomebrewOperationsService({
    getState: () => state,
    patch: (patch) => {
      state = { ...state, ...patch };
    },
    lock,
    runBrewCommand: runCommand,
    emitHomebrewCommand: (event) => events.push(event.type),
    refresh: async (allowInventory) => {
      expect(allowInventory).toBe(true);
      await refresh();
    },
    recordProfileStatsEvents: stats,
    clearOperationFailure: () => undefined,
    recordOperationFailure: failure,
    recordOperationFailures: vi.fn(async () => undefined),
    hasCheckedHomebrewAvailability: () => true,
    markHomebrewAvailabilityChecked: () => undefined,
    requiresInventory: () => false,
    successRefreshDelayMS: 0
  });
  return {
    service,
    lock,
    runCommand,
    refresh,
    stats,
    failure,
    events,
    get state() {
      return state;
    },
    setState(patch: Partial<HomebrewOperationsState>) {
      state = { ...state, ...patch };
    }
  };
}

describe("HomebrewOperationsService", () => {
  it("queues during refresh and verifies fresh installed identity before execution", async () => {
    const h = harness();
    h.lock.beginRefresh(1);
    const pending = h.service.performHomebrewUpdate("formula:example");
    try {
      expect(h.state.homebrewQueuedItemIDs).toEqual(["formula:example"]);
      expect(h.runCommand).not.toHaveBeenCalled();
      h.setState({
        homebrewItems: [
          formula({
            token: "different",
            formulaIdentity: {
              name: "different",
              fullName: "different",
              tap: "homebrew/core",
              oldNames: []
            }
          })
        ]
      });
    } finally {
      h.lock.endRefresh(1);
      await h.service.processHomebrewUpdateQueue();
      await pending;
    }
    expect(h.runCommand).not.toHaveBeenCalled();
    expect(h.state.homebrewUpdatingItemIDs).toEqual([]);
  });

  it("reports streamed progress and completes before refresh", async () => {
    let finish!: (result: CommandResult) => void;
    const commandGate = new Promise<CommandResult>((resolve) => {
      finish = resolve;
    });
    const h = harness(async (_args, onLine) => {
      onLine?.("Downloading example");
      return commandGate;
    });
    const pending = h.service.performHomebrewUpdate("formula:example");
    try {
      await vi.waitFor(() => expect(h.runCommand).toHaveBeenCalled());
      expect(h.state.homebrewBatchProgressByItemID["formula:example"]).toBeGreaterThan(0);
    } finally {
      finish({ success: true, status: 0, output: "" });
      await pending;
    }
    expect(h.runCommand).toHaveBeenCalledWith(["upgrade", "example"], expect.any(Function));
    expect(h.state.homebrewUpdatedPendingRefreshItemIDs).toEqual(["formula:example"]);
    expect(h.stats).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual(["commandStarted", "outputLine", "commandFinished"]);
  });

  it("records a failed update and keeps its transient failure state through refresh", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(async () => ({ success: false, status: 1, output: "failed" }));
      await h.service.performHomebrewUpdate("formula:example");
      expect(h.failure).toHaveBeenCalledWith(
        "formula:example",
        "update",
        expect.objectContaining({ success: false })
      );
      expect(h.state.homebrewBatchFailedItemIDs).toEqual(["formula:example"]);
      expect(h.state.refreshErrorMessage).toBe("Homebrew update failed for Example.");
      expect(h.stats).not.toHaveBeenCalled();
      expect(h.refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
