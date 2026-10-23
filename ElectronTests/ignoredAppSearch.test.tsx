// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../src/renderer/components/Dashboard";
import { deriveSections } from "../src/renderer/helpers/sections";
import { defaultPersistedSnapshot, type BaselineSnapshot } from "../src/shared/domain";
import { version } from "../src/shared/version";

function fixture(): BaselineSnapshot {
  return {
    ...defaultPersistedSnapshot(),
    apps: [
      {
        id: "app:example",
        bundlePath: "/Applications/Example.app",
        displayName: "Example Desktop",
        bundleIdentifier: "org.example.desktop",
        localVersion: version("1.0"),
        sourceHint: "homebrew"
      }
    ],
    homebrewItems: [
      {
        id: "cask:alternate-token",
        kind: "cask",
        token: "alternate-token",
        name: "Alternate Package",
        appID: "app:example",
        installedVersion: version("1.0"),
        latestVersion: version("2.0"),
        isOutdated: true
      }
    ],
    updates: [
      {
        id: "app:example",
        appID: "app:example",
        source: "homebrew",
        supportLevel: "supported",
        homebrewToken: "alternate-token",
        localVersion: version("1.0"),
        remoteVersion: version("2.0"),
        checkedAt: "2026-10-23T12:00:00Z"
      }
    ],
    ignoredIDs: ["app:example"],
    searchText: "alternate-token",
    isMasInstalled: false,
    isHomebrewInstalled: true,
    isChecking: false,
    isRefreshing: false,
    isRunningHomebrewMaintenance: false,
    isHomebrewCommandLocked: false,
    isHomebrewCleanupLocked: false,
    isCleaningUpHomebrew: false,
    laggingHomebrewCaskTokens: [],
    defaultScanDirectories: [],
    homebrewDiscoverItems: [],
    homebrewDiscoverInstallingItemIDs: [],
    homebrewDiscoverInstalledPendingRefreshItemIDs: [],
    homebrewDiscoverFailedItemIDs: [],
    homebrewDiscoverProgressByItemID: {},
    appUpdatingIDs: [],
    appUpdatedPendingRefreshIDs: [],
    homebrewUpdatingItemIDs: [],
    homebrewQueuedItemIDs: [],
    homebrewUpdatedPendingRefreshItemIDs: [],
    homebrewUninstallingItemIDs: [],
    homebrewBatchFailedItemIDs: [],
    homebrewBatchProgressByItemID: {},
    homebrewFallbackFailedAppIDs: [],
    homebrewFallbackProgressByAppID: {},
    operationFailures: []
  };
}

afterEach(cleanup);

describe("ignored app search", () => {
  it.each([
    "Example Desktop",
    "org.example.desktop",
    "alternate-token",
    "Alternate Package",
    "1.0",
    "2.0"
  ])("finds the ignored app for %s without offering its update", (query) => {
    const state = fixture();
    state.searchText = query;
    const sections = deriveSections(state);
    expect(sections.ignoredApps.map((app) => app.id)).toEqual(["app:example"]);
    expect(sections.availableApps).toEqual([]);
    expect(sections.allHomebrewOutdated).toEqual([]);
  });

  it("preserves ignored-update suppression without search and rejects unrelated token matches", () => {
    const state = fixture();
    expect(deriveSections({ ...state, searchText: "" }).allHomebrewOutdated).toEqual([]);
    expect(deriveSections({ ...state, searchText: "unrelated" }).ignoredApps).toEqual([]);
    state.homebrewItems[0]!.appID = undefined;
    expect(deriveSections(state).ignoredApps).toEqual([]);
    expect(deriveSections(state).allHomebrewOutdated.map((item) => item.id)).toEqual([
      "cask:alternate-token"
    ]);
  });

  it("keeps independently ignored casks ignored and does not require an active app update", () => {
    const state = fixture();
    state.updates = [];
    state.ignoredHomebrewItemIDs = [state.homebrewItems[0]!.id];
    const sections = deriveSections(state);
    expect(sections.ignoredApps.map((app) => app.id)).toEqual(["app:example"]);
    expect(sections.homebrewIgnored.map((item) => item.id)).toEqual(["cask:alternate-token"]);
    expect(sections.allHomebrewOutdated).toEqual([]);
  });

  it.each([false, true])(
    "renders the ignored result and its unignore action (compact=%s)",
    (compact) => {
      const toggleIgnoredApp = vi.fn();
      window.baseline = { toggleIgnoredApp } as unknown as typeof window.baseline;
      render(
        <Dashboard
          compact={compact}
          searchActive
          onOpenSettings={() => undefined}
          snapshot={fixture()}
        />
      );
      const results = compact ? screen : within(screen.getByRole("dialog", { name: "Search" }));
      expect(results.getByText("Example Desktop")).toBeInTheDocument();
      expect(results.getByText(compact ? "Ignored" : "Ignored Apps")).toBeInTheDocument();
      expect(results.queryByText("No matches found.")).not.toBeInTheDocument();
      expect(results.queryByText("Homebrew Updates")).not.toBeInTheDocument();
      fireEvent.click(results.getByRole("button", { name: "Actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Unignore" }));
      expect(toggleIgnoredApp).toHaveBeenCalledWith("app:example");
    }
  );
});
