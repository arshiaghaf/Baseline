// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import { trayUpdateTitle } from "../src/main/trayStatus";
import { Dashboard } from "../src/renderer/components/Dashboard";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type AppRecord,
  type BaselineSnapshot,
  type PersistedSnapshot
} from "../src/shared/domain";
import type { CommandResult } from "../src/main/commandRunner";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const available: CommandResult = { success: true, status: 0, output: "" };
const missing: CommandResult = {
  success: false,
  status: null,
  output: "",
  failure: { kind: "spawn", code: "ENOENT", message: "Fixture helper missing" }
};

async function fixture(
  runBrewCommand: NonNullable<ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"]>,
  persisted: PersistedSnapshot = defaultPersistedSnapshot()
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-update-status-"));
  directories.push(directory);
  const inventory = vi.fn(async () => ({
    items: [],
    outdatedDetectionSucceeded: true,
    inventoryReadSucceededByKind: { formula: true, cask: true },
    outdatedDetectionSucceededByKind: { formula: true, cask: true }
  }));
  const persistence = new SnapshotPersistence(directory);
  const scan = vi.fn(async (): Promise<AppRecord[]> => [
    {
      id: "app:fixture",
      bundlePath: "/Applications/Fixture.app",
      displayName: "Fixture",
      bundleIdentifier: "org.example.fixture",
      sourceHint: "appStore",
      localVersion: { raw: "1" }
    }
  ]);
  const store = new UpdateStore({
    persistence,
    persisted,
    runBrewCommand,
    runMasCommand: async () => missing,
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    },
    clients: {
      scanner: { scanApplications: scan },
      appStore: { lookupOutcome: async () => ({ type: "completed", providerFound: true }) },
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
      homebrewInventory: { fetchInventory: inventory },
      selfUpdate: {
        lookup: async (currentVersion, checkedAt) => ({
          available: false,
          currentVersion,
          checkedAt
        })
      }
    }
  });
  return { store, inventory, persistence, scan };
}

const failures: Array<[string, CommandResult]> = [
  [
    "timeout",
    {
      success: false,
      status: null,
      output: "",
      failure: { kind: "timeout", message: "Fixture deadline" }
    }
  ],
  [
    "callback",
    {
      success: false,
      status: null,
      output: "",
      failure: { kind: "callback", message: "Fixture callback failure" }
    }
  ],
  [
    "permission",
    {
      success: false,
      status: null,
      output: "",
      failure: { kind: "spawn", code: "EACCES", message: "Fixture permission failure" }
    }
  ],
  ["unclassified", { success: false, status: 1, output: "" }]
];

describe("Homebrew availability success evidence", () => {
  it.each(
    failures.flatMap(([name, result]) =>
      [false, true].map((compact) => ({ name, result, compact }))
    )
  )(
    "keeps $name availability inconclusive through the store, tray and dashboard (compact=$compact), then recovers",
    async ({ result, compact }) => {
      let probeResult = result;
      const { store, inventory } = await fixture(async () => probeResult);
      await store.refreshToolStatus();
      await store.refresh(false);
      const failed = store.getSnapshot();
      expect(inventory).not.toHaveBeenCalled();
      expect(failed.homebrewCheckStatus).toBe("incomplete");
      expect(failed.lastRefreshNoticeMessage).toContain(
        "Homebrew availability could not be confirmed"
      );
      expect(failed.appProviderChecks?.["app:fixture"]?.status).toBe("checked");
      expect(trayUpdateTitle(failed)).toBe("");
      const dashboard = () => (
        <Dashboard
          snapshot={{ ...store.getSnapshot(), selectedTab: "homebrew" }}
          compact={compact}
          onOpenSettings={() => undefined}
        />
      );
      const { rerender } = render(dashboard());
      expect(
        screen.getByText("Some Homebrew updates could not be checked. Refresh to retry.")
      ).toBeVisible();
      expect(screen.queryByText("All your Homebrew items are up to date.")).not.toBeInTheDocument();
      probeResult = available;
      await store.refresh(false);
      expect(inventory).toHaveBeenCalledOnce();
      expect(store.getSnapshot()).toMatchObject({
        isHomebrewInstalled: true,
        homebrewCheckStatus: "complete",
        lastRefreshNoticeMessage: undefined
      });
      expect(trayUpdateTitle(store.getSnapshot())).toBe("✓");
      rerender(dashboard());
      expect(screen.getByText("All your Homebrew items are up to date.")).toBeVisible();
    }
  );

  it.each(failures)(
    "revokes earlier inventory success as soon as a later %s probe fails",
    async (_name, failed) => {
      let probeResult = available;
      const { store, inventory } = await fixture(async () => probeResult);
      await store.refreshToolStatus();
      await store.refresh(false);
      expect(trayUpdateTitle(store.getSnapshot())).toBe("✓");
      probeResult = failed;
      await store.refreshToolStatus();
      expect(store.getSnapshot().homebrewCheckStatus).toBe("incomplete");
      expect(trayUpdateTitle(store.getSnapshot())).toBe("");
      const view = () => (
        <Dashboard
          snapshot={{ ...store.getSnapshot(), selectedTab: "all" }}
          compact={false}
          onOpenSettings={() => undefined}
        />
      );
      const { rerender } = render(view());
      expect(screen.getByText("Some updates could not be checked.")).toBeVisible();
      expect(
        screen.queryByText("No updates found in the checked sources.")
      ).not.toBeInTheDocument();
      probeResult = available;
      await store.refreshToolStatus();
      expect(trayUpdateTitle(store.getSnapshot())).toBe("");
      await store.refresh(false);
      expect(inventory).toHaveBeenCalledTimes(2);
      expect(trayUpdateTitle(store.getSnapshot())).toBe("✓");
      rerender(view());
      expect(screen.getByText("No updates found in the checked sources.")).toBeVisible();
    }
  );

  it("revokes success if the readiness callback rejects, then recovers with real inventory evidence", async () => {
    let rejectProbe = false;
    const { store } = await fixture(async () => {
      if (rejectProbe) throw new Error("Fixture callback rejection");
      return available;
    });
    await store.refreshToolStatus();
    await store.refresh(false);
    expect(trayUpdateTitle(store.getSnapshot())).toBe("✓");
    rejectProbe = true;
    await expect(store.refreshToolStatus()).rejects.toThrow("Fixture callback rejection");
    expect(store.getSnapshot()).toMatchObject({
      homebrewCheckStatus: "incomplete",
      isChecking: false
    });
    expect(trayUpdateTitle(store.getSnapshot())).toBe("");
    rejectProbe = false;
    await store.refresh(false);
    expect(trayUpdateTitle(store.getSnapshot())).toBe("✓");
  });

  it("accepts confirmed absence without inventory but rechecks inventory when Homebrew appears", async () => {
    let probeResult = missing;
    const { store, inventory } = await fixture(async () => probeResult);
    await store.refreshToolStatus();
    await store.refresh(false);
    expect(inventory).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({
      isHomebrewInstalled: false,
      homebrewCheckStatus: "complete",
      masAvailability: "missing",
      lastRefreshNoticeMessage: undefined
    });
    expect(trayUpdateTitle(store.getSnapshot())).toBe("✓");
    await store.refreshToolStatus();
    expect(trayUpdateTitle(store.getSnapshot())).toBe("✓");
    probeResult = available;
    await store.refreshToolStatus();
    expect(trayUpdateTitle(store.getSnapshot())).toBe("");
    await store.refresh(false);
    expect(inventory).toHaveBeenCalledOnce();
    expect(store.getSnapshot().isHomebrewInstalled).toBe(true);
    expect(trayUpdateTitle(store.getSnapshot())).toBe("✓");
  });
});

it.each([false, true])(
  "requires a current Homebrew check after real persisted state is reloaded (compact=%s)",
  async (compact) => {
    const initial = await fixture(async () => available);
    await initial.store.refresh(false);
    const persisted = await initial.persistence.load();
    expect(persisted.lastRefreshDate).toBeTruthy();
    expect(persisted.appProviderChecks?.["app:fixture"]?.status).toBe("checked");
    expect(persisted).not.toHaveProperty("homebrewCheckStatus");
    expect(persisted).not.toHaveProperty("refreshCheckFailed");
    const restored = await fixture(async () => available, persisted);
    const view = () => (
      <Dashboard
        compact={compact}
        snapshot={{ ...restored.store.getSnapshot(), selectedTab: "all" }}
        onOpenSettings={() => undefined}
      />
    );
    const { rerender } = render(view());
    expect(trayUpdateTitle(restored.store.getSnapshot())).toBe("");
    expect(
      screen.getByText(
        compact ? "Refresh to check Homebrew updates." : "Refresh to check for updates."
      )
    ).toBeVisible();
    expect(screen.queryByText("No updates found in the checked sources.")).not.toBeInTheDocument();
    await restored.store.refresh(false);
    rerender(view());
    expect(
      screen.getByText(
        compact
          ? "All your Homebrew items are up to date."
          : "No updates found in the checked sources."
      )
    ).toBeVisible();
  }
);

it.each([false, true])(
  "keeps an actual invalid-link operation error separate from healthy checks (compact=%s)",
  async (compact) => {
    const { store } = await fixture(async () => available);
    await store.refresh(false);
    expect(await store.openExternal("http://example.com/update")).toBe(false);
    expect(store.getSnapshot().refreshCheckFailed).toBe(false);
    const view = (selectedTab: "all" | "homebrew") => (
      <Dashboard
        compact={compact}
        snapshot={{ ...store.getSnapshot(), selectedTab }}
        onOpenSettings={() => undefined}
      />
    );
    const { rerender } = render(view("homebrew"));
    expect(screen.getByText("Blocked an unsafe external link.")).toBeVisible();
    expect(screen.getByText("All your Homebrew items are up to date.")).toBeVisible();
    expect(screen.queryByText(/The refresh did not complete/)).not.toBeInTheDocument();
    if (!compact) {
      rerender(view("all"));
      expect(screen.getByText("No updates found in the checked sources.")).toBeVisible();
      expect(screen.getByText("Blocked an unsafe external link.")).toBeVisible();
    }
  }
);

it("retains real refresh-failure evidence through an operation error until healthy recovery", async () => {
  const { store, scan } = await fixture(async () => available);
  await store.refresh(false);
  scan.mockRejectedValueOnce(new Error("Fixture scan unavailable"));
  await store.refresh(false);
  expect(store.getSnapshot()).toMatchObject({
    refreshCheckFailed: true,
    homebrewCheckStatus: "complete"
  });
  await store.openExternal("http://example.com/update");
  const view = (selectedTab: "all" | "homebrew") => (
    <Dashboard
      compact={false}
      snapshot={{ ...store.getSnapshot(), selectedTab }}
      onOpenSettings={() => undefined}
    />
  );
  const { rerender } = render(view("all"));
  expect(screen.getByText("Some updates could not be checked.")).toBeVisible();
  rerender(view("homebrew"));
  expect(screen.getByText("All your Homebrew items are up to date.")).toBeVisible();
  await store.refresh(false);
  expect(store.getSnapshot().refreshCheckFailed).toBe(false);
  rerender(view("all"));
  expect(screen.getByText("No updates found in the checked sources.")).toBeVisible();
});

it.each([true, false])(
  "keeps tray success withheld when a Discover success clears an earlier scan error during the default hold (empty provider map=%s)",
  async (emptyProviderMap) => {
    const runBrewCommand = vi.fn<
      NonNullable<ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"]>
    >(async () => available);
    const { store, scan } = await fixture(runBrewCommand);
    if (emptyProviderMap) scan.mockResolvedValueOnce([]);
    await store.refreshToolStatus();
    await store.refresh(false);
    expect(Object.keys(store.getSnapshot().appProviderChecks ?? {})).toHaveLength(
      emptyProviderMap ? 0 : 1
    );
    expect(trayUpdateTitle(store.getSnapshot())).toBe("✓");
    // Both the earlier scan and the install's automatic follow-up fail. Command
    // success alone cannot repair the missing check in between those scans.
    scan.mockRejectedValueOnce(new Error("Fixture scan unavailable"));
    scan.mockRejectedValueOnce(new Error("Fixture follow-up scan unavailable"));
    await store.refresh(false);
    expect(store.getSnapshot().refreshCheckFailed).toBe(true);
    expect(trayUpdateTitle(store.getSnapshot())).toBe("");
    const item = {
      id: "formula:fixture-tool",
      token: "fixture-tool",
      displayName: "Fixture Tool",
      kind: "formula" as const,
      version: { raw: "1" }
    };
    const heldSnapshots: BaselineSnapshot[] = [];
    const listener = (state: BaselineSnapshot) => {
      if (
        state.refreshCheckFailed &&
        !state.refreshErrorMessage &&
        !state.isRefreshing &&
        state.homebrewDiscoverInstalledPendingRefreshItemIDs.includes(item.id)
      )
        heldSnapshots.push(state);
    };
    store.on("snapshot", listener);
    const install = store.installHomebrewItem(item);
    try {
      await waitFor(() => expect(heldSnapshots.length).toBeGreaterThan(0), { timeout: 5_000 });
      expect(
        runBrewCommand.mock.calls.some(([args]) => args[0] === "install" && args[1] === item.token)
      ).toBe(true);
      for (const held of heldSnapshots) {
        expect(held).toMatchObject({
          refreshCheckFailed: true,
          homebrewCheckStatus: "complete",
          refreshErrorMessage: undefined,
          lastRefreshNoticeMessage: undefined,
          isChecking: false,
          isRefreshing: false
        });
        expect(trayUpdateTitle(held)).toBe("");
      }
      render(
        <Dashboard
          compact={false}
          snapshot={{ ...heldSnapshots[0]!, selectedTab: "all" }}
          onOpenSettings={() => undefined}
        />
      );
      expect(screen.getByText("Some updates could not be checked.")).toBeVisible();
    } finally {
      try {
        await install;
      } finally {
        store.off("snapshot", listener);
      }
    }
    expect(store.getSnapshot().refreshCheckFailed).toBe(true);
    expect(trayUpdateTitle(store.getSnapshot())).toBe("");
    if (emptyProviderMap) scan.mockResolvedValueOnce([]);
    await store.refresh(false);
    expect(store.getSnapshot().refreshCheckFailed).toBe(false);
    expect(trayUpdateTitle(store.getSnapshot())).toBe("✓");
  },
  10_000
);
