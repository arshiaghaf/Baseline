// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import {
  defaultPersistedSnapshot,
  type HomebrewManagedItem,
  type ProfileStatsEvent
} from "../src/shared/domain";
import { version } from "../src/shared/version";
import { HomebrewWorkLock } from "../src/main/homebrewWorkLock";
import {
  HomebrewOperationsService,
  type HomebrewOperationsState
} from "../src/main/homebrewOperationsService";
import type { CommandOptions, CommandResult } from "../src/main/commandRunner";

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
  run: (
    args: string[],
    onLine?: (line: string) => void,
    options?: CommandOptions
  ) => Promise<CommandResult> = async () => ({
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
  const failures = vi.fn(async () => undefined);
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
    recordOperationFailures: failures,
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
    failures,
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
  it.each(["single", "queued", "batch"] as const)(
    "reconciles successful %s updates after a history save rejection without retrying commands",
    async (scenario) => {
      const h = harness();
      const items = [
        formula(),
        formula({
          id: "formula:other",
          token: "other",
          name: "Other",
          formulaIdentity: { name: "other", fullName: "other", tap: "homebrew/core", oldNames: [] }
        })
      ].slice(0, scenario === "single" ? 1 : 2);
      h.setState({ homebrewItems: items });
      h.stats.mockRejectedValueOnce(new Error("fixture history failure"));
      h.refresh.mockImplementation(async () => {
        expect(h.lock.activeCommandCount).toBe(1);
        expect(h.state.homebrewUpdatedPendingRefreshItemIDs).toEqual(items.map((item) => item.id));
        h.setState({
          homebrewItems: items.map((item) => ({
            ...item,
            installedVersion: version("2"),
            isOutdated: false
          })),
          homebrewUpdatedPendingRefreshItemIDs: [],
          lastRefreshNoticeMessage: "Inventory warning."
        });
      });
      try {
        if (scenario === "batch") await h.service.performHomebrewUpdateAll();
        else {
          h.lock.beginRefresh(71);
          const pending = Promise.allSettled(
            items.map((item) => h.service.performHomebrewUpdate(item.id))
          );
          h.lock.endRefresh(71);
          await h.service.processHomebrewUpdateQueue();
          expect((await pending).every((result) => result.status === "fulfilled")).toBe(true);
        }
        expect(h.refresh).toHaveBeenCalledOnce();
        expect(h.stats).toHaveBeenCalledOnce();
        expect(h.state.homebrewItems.map((item) => item.installedVersion.raw)).toEqual(
          items.map(() => "2")
        );
        expect(h.state.lastRefreshNoticeMessage).toMatch(
          /Inventory warning.*could not be saved to history/
        );
        expect(h.state.homebrewBatchFailedItemIDs).toEqual([]);
        expect(h.failure).not.toHaveBeenCalled();
        expect(h.failures).not.toHaveBeenCalled();
        expect(h.lock.activeCommandCount).toBe(0);
        expect(h.state.homebrewOperation).toBeUndefined();
        expect(h.state.homebrewUpdatingItemIDs).toEqual([]);
        const commands = h.runCommand.mock.calls.length;
        await h.service.performHomebrewUpdate(items[0]!.id);
        expect(h.runCommand).toHaveBeenCalledTimes(commands);
      } finally {
        h.service.dispose();
      }
    }
  );

  it.each(["batch", "queued"] as const)(
    "reconciles partial %s success after a later command failure and history save rejection",
    async (scenario) => {
      const h = harness(async (args) =>
        args.includes("--cask")
          ? { success: false, status: 1, output: "" }
          : { success: true, status: 0, output: "" }
      );
      const cask = formula({
        id: "cask:other",
        token: "other",
        fullToken: "other",
        kind: "cask",
        formulaIdentity: undefined,
        tap: "homebrew/cask"
      });
      h.setState({ homebrewItems: [formula(), cask] });
      h.stats.mockRejectedValueOnce(new Error("fixture history failure"));
      h.refresh.mockImplementation(async () => {
        expect(h.lock.activeCommandCount).toBe(1);
        expect(h.state.homebrewUpdatedPendingRefreshItemIDs).toEqual(["formula:example"]);
        h.setState({
          homebrewItems: [{ ...formula(), installedVersion: version("2"), isOutdated: false }, cask]
        });
      });
      try {
        if (scenario === "batch") await h.service.performHomebrewUpdateAll();
        else {
          h.lock.beginRefresh(72);
          const pending = Promise.allSettled(
            h.state.homebrewItems.map((item) => h.service.performHomebrewUpdate(item.id))
          );
          h.lock.endRefresh(72);
          await h.service.processHomebrewUpdateQueue();
          expect((await pending).every((result) => result.status === "fulfilled")).toBe(true);
        }
        expect(h.refresh).toHaveBeenCalledOnce();
        expect(h.stats).toHaveBeenCalledWith([
          expect.objectContaining({ targetID: "formula:example" })
        ]);
        expect(h.failures).toHaveBeenCalledWith(
          expect.arrayContaining([expect.objectContaining({ entityID: cask.id })])
        );
        expect(h.state.homebrewBatchFailedItemIDs).toEqual([cask.id]);
        expect(h.state.lastRefreshNoticeMessage).toContain("could not be saved to history");
        expect(h.state.homebrewItems[0]!.installedVersion.raw).toBe("2");
        expect(h.state.homebrewItems[1]!.isOutdated).toBe(true);
        expect(h.lock.activeCommandCount).toBe(0);
        expect(h.runCommand).toHaveBeenCalledTimes(scenario === "batch" ? 3 : 2);
      } finally {
        h.service.dispose();
      }
    }
  );

  it.each(["single", "queued", "batch"] as const)(
    "retains the history notice and releases the reservation when %s reconciliation also rejects",
    async (scenario) => {
      const h = harness();
      h.stats.mockRejectedValueOnce(new Error("fixture history failure"));
      h.refresh.mockRejectedValueOnce(new Error("fixture refresh failure"));
      if (scenario === "queued")
        h.setState({
          homebrewItems: [
            formula(),
            formula({
              id: "cask:other",
              token: "other",
              fullToken: "other",
              kind: "cask",
              formulaIdentity: undefined,
              tap: "homebrew/cask"
            })
          ]
        });
      try {
        if (scenario === "batch")
          await expect(h.service.performHomebrewUpdateAll()).rejects.toThrow(
            "fixture refresh failure"
          );
        else {
          h.lock.beginRefresh(73);
          const pending = Promise.allSettled(
            h.state.homebrewItems.map((item) => h.service.performHomebrewUpdate(item.id))
          );
          h.lock.endRefresh(73);
          await h.service.processHomebrewUpdateQueue();
          expect(await pending).toEqual(
            h.state.homebrewItems.map(() => ({
              status: "rejected",
              reason: expect.objectContaining({ message: "fixture refresh failure" })
            }))
          );
        }
        expect(h.refresh).toHaveBeenCalledOnce();
        expect(h.state.lastRefreshNoticeMessage).toContain("could not be saved to history");
        expect(h.state.homebrewUpdatedPendingRefreshItemIDs).toEqual(
          h.state.homebrewItems.map((item) => item.id)
        );
        expect(h.state.homebrewBatchFailedItemIDs).toEqual([]);
        expect(h.lock.activeCommandCount).toBe(0);
        expect(h.state.homebrewOperation).toBeUndefined();
      } finally {
        h.service.dispose();
      }
    }
  );

  it("keeps queued work reserved until reconciliation removes a stale target after history failure", async () => {
    const h = harness();
    const removed = formula({
      id: "formula:removed",
      token: "removed",
      name: "Removed",
      formulaIdentity: { name: "removed", fullName: "removed", tap: "homebrew/core", oldNames: [] }
    });
    h.setState({ homebrewItems: [formula(), removed] });
    h.stats.mockRejectedValueOnce(new Error("fixture history failure"));
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    h.refresh.mockImplementationOnce(async () => {
      await refreshGate;
      h.setState({
        homebrewItems: [{ ...formula(), installedVersion: version("2"), isOutdated: false }]
      });
    });
    const pending: Promise<unknown>[] = [h.service.performHomebrewUpdate("formula:example")];
    // Observe settlement independently from the gate so a timeout cannot release
    // work that resumes the assertions during teardown.
    const settled = Promise.allSettled(pending);
    try {
      await vi.waitFor(() => expect(h.refresh).toHaveBeenCalledOnce());
      pending.push(h.service.performHomebrewUpdate(removed.id));
      expect(h.state.homebrewQueuedItemIDs).toEqual([removed.id]);
      expect(h.lock.activeCommandCount).toBe(1);
      expect(h.runCommand).toHaveBeenCalledExactlyOnceWith(
        ["upgrade", "example"],
        expect.any(Function),
        expect.any(Object)
      );
      releaseRefresh();
      expect((await Promise.allSettled(pending)).map((result) => result.status)).toEqual([
        "fulfilled",
        "fulfilled"
      ]);
      expect(h.runCommand).toHaveBeenCalledOnce();
      expect(h.state.homebrewItems.map((item) => item.id)).toEqual(["formula:example"]);
      expect(h.state.homebrewQueuedItemIDs).toEqual([]);
      expect(h.lock.activeCommandCount).toBe(0);
      expect(h.state.lastRefreshNoticeMessage).toContain("could not be saved to history");
    } finally {
      releaseRefresh();
      await Promise.allSettled(pending);
      await settled;
      h.service.dispose();
    }
  });

  it.each([
    ["single", true, false, false],
    ["queued", true, false, false],
    ["single", false, false, false],
    ["queued", false, false, false],
    ["single", true, true, false],
    ["queued", true, true, false],
    ["single", true, true, true],
    ["queued", true, true, true]
  ] as const)(
    "preserves only confirmed same-version %s completion on cancellation (complete:%s, save rejection:%s, helper fault:%s)",
    async (scenario, completed, saveRejects, helperFault) => {
      const item = formula({
        id: "cask:example",
        kind: "cask",
        formulaIdentity: undefined,
        fullToken: "example",
        tap: "homebrew/cask",
        latestVersion: version("1.0")
      });
      const queuedEvent: ProfileStatsEvent = {
        id: "fixture-update-event",
        type: "appUpdate",
        targetID: "fixture-app",
        displayName: "Fixture",
        channel: "homebrew",
        occurredAt: "2026-10-16T12:00:00Z"
      };
      const h = harness(async (_args, onLine) => {
        onLine?.("Installing example");
        if (completed) {
          onLine?.("Cask example was successfully installed!");
          onLine?.("Cask example was successfully installed!");
        }
        return {
          success: false,
          status: 1,
          output: "",
          cancelled: true,
          failure: helperFault ? { kind: "admin-helper", message: "fixture" } : undefined
        };
      });
      h.setState({ homebrewItems: [item] });
      if (saveRejects) h.stats.mockRejectedValueOnce(new Error("fixture persistence failure"));
      h.refresh.mockImplementation(async () => {
        expect(h.lock.activeCommandCount).toBe(1);
        expect(h.state.homebrewOperation?.phase).toBe("reconciling");
        expect(h.state.homebrewUpdatingItemIDs).toEqual([]);
        expect(h.state.homebrewQueuedItemIDs).toEqual([]);
        expect(h.state.homebrewBatchProgressByItemID).toEqual({});
        expect(h.state.homebrewUpdatedPendingRefreshItemIDs).toEqual(completed ? [item.id] : []);
        expect(h.stats).toHaveBeenCalledTimes(completed ? 1 : 0);
      });
      if (scenario === "single") await h.service.performHomebrewUpdate(item.id);
      else {
        h.lock.beginRefresh(37);
        const pending = h.service.performHomebrewItemUpdate(item, {
          profileStatsEvent: queuedEvent
        });
        try {
          expect(h.runCommand).not.toHaveBeenCalled();
          h.lock.endRefresh(37);
          await h.service.processHomebrewUpdateQueue();
        } finally {
          await pending;
        }
      }
      if (completed)
        expect(h.stats).toHaveBeenCalledWith([
          scenario === "queued"
            ? queuedEvent
            : expect.objectContaining({ type: "homebrewUpdate", targetID: item.id })
        ]);
      expect(h.runCommand).toHaveBeenCalledOnce();
      expect(h.refresh).toHaveBeenCalledOnce();
      expect(h.failure).not.toHaveBeenCalled();
      expect(h.failures).not.toHaveBeenCalled();
      expect(h.state.homebrewBatchFailedItemIDs).toEqual([]);
      expect(h.state.homebrewOperation).toBeUndefined();
      expect(h.lock.activeCommandCount).toBe(0);
      if (saveRejects)
        expect(h.state.lastRefreshNoticeMessage).toContain("could not be saved to history");
      if (helperFault)
        expect(h.state.refreshErrorMessage).toContain("administrator password helper failed");
      else expect(h.state.refreshErrorMessage).toBeUndefined();
    }
  );

  it.each([
    ["batch", false],
    ["queued", false],
    ["batch", true],
    ["queued", true]
  ] as const)(
    "reconciles %s cancellation despite history persistence rejection (helper fault: %s)",
    async (scenario, helperFault) => {
      const h = harness(async (args) =>
        args.includes("--cask")
          ? {
              success: false,
              status: 1,
              output: "",
              cancelled: true,
              failure: helperFault ? { kind: "admin-helper", message: "fixture" } : undefined
            }
          : { success: true, status: 0, output: "" }
      );
      h.setState({
        homebrewItems: [
          formula(),
          formula({
            id: "cask:other",
            kind: "cask",
            token: "other",
            fullToken: "other",
            formulaIdentity: undefined,
            tap: "homebrew/cask"
          })
        ]
      });
      h.stats.mockRejectedValueOnce(new Error("fixture persistence failure"));
      h.refresh.mockImplementation(async () => {
        expect(h.lock.activeCommandCount).toBe(1);
        expect(h.state.isRunningHomebrewMaintenance).toBe(false);
        expect(h.state.homebrewUpdatingItemIDs).toEqual([]);
        expect(h.state.homebrewQueuedItemIDs).toEqual([]);
        expect(h.state.homebrewBatchProgressByItemID).toEqual({});
        expect(h.state.homebrewUpdatedPendingRefreshItemIDs).toEqual(["formula:example"]);
        expect(h.state.homebrewOperation?.phase).toBe("reconciling");
      });
      if (scenario === "batch") await h.service.performHomebrewUpdateAll();
      else {
        h.lock.beginRefresh(29);
        const pending = h.state.homebrewItems.map((item) =>
          h.service.performHomebrewUpdate(item.id)
        );
        try {
          h.lock.endRefresh(29);
          await h.service.processHomebrewUpdateQueue();
        } finally {
          await Promise.all(pending);
        }
      }
      expect(h.stats).toHaveBeenCalledOnce();
      expect(h.refresh).toHaveBeenCalledOnce();
      expect(h.state.lastRefreshNoticeMessage).toContain("could not be saved to history");
      if (helperFault)
        expect(h.state.refreshErrorMessage).toContain("administrator password helper failed");
      else expect(h.state.refreshErrorMessage).toBeUndefined();
      expect(h.failure).not.toHaveBeenCalled();
      expect(h.failures).not.toHaveBeenCalled();
      expect(h.state.homebrewBatchFailedItemIDs).toEqual([]);
      expect(h.state.homebrewOperation).toBeUndefined();
      expect(h.lock.activeCommandCount).toBe(0);
    }
  );

  it.each(["formula", "cask"] as const)(
    "limits %s waiting targets to the actual command kind when installed tokens collide",
    async (kind) => {
      const h = harness(async (_args, _line, options) => {
        options?.adminOperation?.onWaitingChanged("a".repeat(32));
        expect(h.state.homebrewOperation).toMatchObject({
          phase: "waiting",
          itemIDs: [`${kind}:example`],
          appIDs: kind === "cask" ? ["fixture-app"] : []
        });
        return { success: false, status: 1, output: "", cancelled: true };
      });
      h.setState({
        homebrewItems: [
          formula(),
          formula({
            id: "cask:example",
            kind: "cask",
            formulaIdentity: undefined,
            fullToken: "example",
            tap: "homebrew/cask",
            appID: "fixture-app"
          })
        ]
      });
      await h.service.performHomebrewUpdate(`${kind}:example`);
      expect(h.runCommand).toHaveBeenCalledOnce();
    }
  );

  it.each(["batch", "queued"] as const)(
    "preserves prior formula success and explicit cask completion when a later %s step is cancelled",
    async (scenario) => {
      const h = harness(async (args, onLine) => {
        if (args.includes("--cask")) {
          onLine?.("Cask completed was successfully installed!");
          onLine?.("Installing pending");
          return { success: false, status: 1, output: "", cancelled: true };
        }
        return { success: true, status: 0, output: "" };
      });
      const cask = (token: string) =>
        formula({
          id: `cask:${token}`,
          kind: "cask",
          token,
          fullToken: token,
          formulaIdentity: undefined,
          tap: "homebrew/cask"
        });
      h.setState({ homebrewItems: [formula(), cask("completed"), cask("pending")] });
      h.refresh.mockImplementation(async () => {
        expect(h.lock.activeCommandCount).toBe(1);
        expect(h.state.homebrewUpdatedPendingRefreshItemIDs).toEqual([
          "formula:example",
          "cask:completed"
        ]);
        expect(h.stats).toHaveBeenCalledOnce();
        expect(h.stats).toHaveBeenCalledWith([
          expect.objectContaining({ targetID: "formula:example" }),
          expect.objectContaining({ targetID: "cask:completed" })
        ]);
        expect(h.state.homebrewUpdatingItemIDs).toEqual([]);
        expect(h.state.homebrewBatchProgressByItemID).toEqual({});
      });
      if (scenario === "batch") await h.service.performHomebrewUpdateAll();
      else {
        h.lock.beginRefresh(19);
        const pending = h.state.homebrewItems.map((item) =>
          h.service.performHomebrewUpdate(item.id)
        );
        try {
          h.lock.endRefresh(19);
          await h.service.processHomebrewUpdateQueue();
        } finally {
          await Promise.all(pending);
        }
      }
      expect(h.refresh).toHaveBeenCalledOnce();
      expect(h.failure).not.toHaveBeenCalled();
      expect(h.failures).not.toHaveBeenCalled();
      expect(h.state.homebrewBatchFailedItemIDs).toEqual([]);
      expect(h.state.refreshErrorMessage).toBeUndefined();
      expect(h.state.homebrewOperation).toBeUndefined();
      expect(h.lock.activeCommandCount).toBe(0);
    }
  );

  it("retains an independent helper fault alongside reconciliation errors after cancellation", async () => {
    const h = harness(async () => ({
      success: false,
      cancelled: true,
      status: 1,
      output: "",
      failure: { kind: "admin-helper", message: "fixture helper failure" }
    }));
    h.refresh.mockImplementation(async () => {
      h.setState({ refreshErrorMessage: "Inventory unavailable." });
    });
    await h.service.performHomebrewUpdate("formula:example");
    expect(h.state.refreshErrorMessage).toContain("Inventory unavailable.");
    expect(h.state.refreshErrorMessage).toContain("administrator password helper failed");
    expect(h.failure).not.toHaveBeenCalled();
    expect(h.state.homebrewOperation).toBeUndefined();
    expect(h.lock.activeCommandCount).toBe(0);
  });

  it.each(["single", "batch", "queued", "install", "uninstall"] as const)(
    "reconciles cancelled %s without failure UI/history while holding the reservation",
    async (scenario) => {
      const cancelled = {
        success: false,
        status: 1,
        output: "sudo fixture rejected",
        cancelled: true
      };
      const h = harness(async (args) =>
        args[0] === "update" ? { success: true, status: 0, output: "" } : cancelled
      );
      const cask: HomebrewManagedItem = {
        id: "cask:fixture",
        kind: "cask",
        token: "fixture",
        fullToken: "fixture",
        tap: "homebrew/cask",
        name: "Fixture",
        installedVersion: version("1"),
        isOutdated: true
      };
      const other = { ...cask, id: "cask:other", token: "other", fullToken: "other" };
      h.setState({ homebrewItems: [cask, other] });
      h.refresh.mockImplementation(async () => {
        expect(h.lock.activeCommandCount).toBe(1);
        expect(h.state.homebrewOperation?.phase).toBe("reconciling");
      });
      if (scenario === "single") await h.service.performHomebrewUpdate(cask.id);
      if (scenario === "batch") await h.service.performHomebrewUpdateAll();
      if (scenario === "queued") {
        h.lock.beginRefresh(9);
        const pending = [
          h.service.performHomebrewUpdate(cask.id),
          h.service.performHomebrewUpdate(other.id)
        ];
        try {
          h.lock.endRefresh(9);
          await h.service.processHomebrewUpdateQueue();
        } finally {
          await Promise.all(pending);
        }
      }
      if (scenario === "install")
        await h.service.installHomebrewItem({
          id: "cask:fixture",
          kind: "cask",
          token: "fixture",
          displayName: "Fixture",
          version: version("2")
        });
      if (scenario === "uninstall") await h.service.uninstallHomebrewItem(cask.id);
      expect(h.failure).not.toHaveBeenCalled();
      expect(h.failures).not.toHaveBeenCalled();
      expect(h.stats).not.toHaveBeenCalled();
      expect(h.refresh).toHaveBeenCalledOnce();
      expect(h.state.refreshErrorMessage).toBeUndefined();
      expect(h.state.homebrewBatchFailedItemIDs).toEqual([]);
      expect(h.state.homebrewDiscoverFailedItemIDs).toEqual([]);
      expect(h.state.homebrewUpdatingItemIDs).toEqual([]);
      expect(h.state.homebrewDiscoverInstallingItemIDs).toEqual([]);
      expect(h.state.homebrewUninstallingItemIDs).toEqual([]);
      expect(h.state.homebrewOperation).toBeUndefined();
      expect(h.lock.activeCommandCount).toBe(0);
    }
  );

  it("publishes a recoverable waiting snapshot and ignores status after the command settles", async () => {
    let notify: ((id: string | undefined) => void) | undefined;
    const h = harness(async (_args, _line, options) => {
      notify = options?.adminOperation?.onWaitingChanged;
      notify?.("a".repeat(32));
      expect(h.state.homebrewOperation).toMatchObject({
        phase: "waiting",
        waitingPromptID: "a".repeat(32),
        itemIDs: ["formula:example"]
      });
      // getSnapshot uses a clone of this authoritative state; reopening does not
      // depend on having observed the notification that established the wait.
      expect(structuredClone(h.state).homebrewOperation?.waitingPromptID).toBe("a".repeat(32));
      return { success: false, status: 1, output: "", cancelled: true };
    });
    await h.service.performHomebrewUpdate("formula:example");
    notify?.("b".repeat(32));
    expect(h.state.homebrewOperation).toBeUndefined();
  });

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
    expect(h.runCommand).toHaveBeenCalledWith(
      ["upgrade", "example"],
      expect.any(Function),
      expect.objectContaining({ adminOperation: expect.any(Object) })
    );
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
