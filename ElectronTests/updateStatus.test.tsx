// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import { trayUpdateTitle } from "../src/main/trayStatus";
import { Dashboard } from "../src/renderer/components/Dashboard";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex
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

async function fixture(runBrewCommand: () => Promise<CommandResult>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-update-status-"));
  directories.push(directory);
  const inventory = vi.fn(async () => ({
    items: [],
    outdatedDetectionSucceeded: true,
    inventoryReadSucceededByKind: { formula: true, cask: true },
    outdatedDetectionSucceededByKind: { formula: true, cask: true }
  }));
  const store = new UpdateStore({
    persistence: new SnapshotPersistence(directory),
    persisted: defaultPersistedSnapshot(),
    runBrewCommand,
    runMasCommand: async () => missing,
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    },
    clients: {
      scanner: {
        scanApplications: async () => [
          {
            id: "app:fixture",
            bundlePath: "/Applications/Fixture.app",
            displayName: "Fixture",
            bundleIdentifier: "org.example.fixture",
            sourceHint: "appStore",
            localVersion: { raw: "1" }
          }
        ]
      },
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
  return { store, inventory };
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
      probeResult = available;
      await store.refreshToolStatus();
      expect(trayUpdateTitle(store.getSnapshot())).toBe("");
      await store.refresh(false);
      expect(inventory).toHaveBeenCalledTimes(2);
      expect(trayUpdateTitle(store.getSnapshot())).toBe("✓");
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
