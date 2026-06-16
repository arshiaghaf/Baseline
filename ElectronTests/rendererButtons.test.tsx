// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionConfirmationContext,
  App,
  AppRow,
  Dashboard,
  DiscoverRow,
  HomebrewRow,
  HomebrewSection,
  SettingsView
} from "../src/renderer/main";
import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  UpdateRecord
} from "../src/shared/domain";
import { defaultPersistedSnapshot, profileStatsSignatureVersion } from "../src/shared/domain";
import { version } from "../src/shared/version";

const app: AppRecord = {
  id: "app:example",
  bundlePath: "/Applications/Example.app",
  displayName: "Example",
  bundleIdentifier: "com.example.app",
  localVersion: version("1.0.0"),
  sourceHint: "unknown"
};

const cask: HomebrewManagedItem = {
  id: "cask:example",
  token: "example",
  name: "Example",
  kind: "cask",
  installedVersion: version("1.0.0"),
  latestVersion: version("2.0.0"),
  isOutdated: true
};

const update: UpdateRecord = {
  id: app.id,
  appID: app.id,
  source: "homebrew",
  supportLevel: "supported",
  localVersion: version("1.0.0"),
  remoteVersion: version("2.0.0"),
  homebrewToken: "example",
  checkedAt: "2026-04-30T12:00:00.000Z"
};

function snapshot(patch: Partial<BaselineSnapshot> = {}): BaselineSnapshot {
  return {
    ...defaultPersistedSnapshot(),
    apps: [app],
    updates: [update],
    homebrewItems: [cask],
    isMasInstalled: false,
    isHomebrewInstalled: true,
    isChecking: false,
    isRefreshing: false,
    searchText: "",
    isRunningHomebrewMaintenance: false,
    isHomebrewCommandLocked: false,
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
    defaultScanDirectories: ["/Applications", "/Users/test/Applications"],
    ...patch
  };
}

function installBaselineMock() {
  window.baseline = {
    getSnapshot: vi.fn(),
    getAppMetadata: vi.fn(() =>
      Promise.resolve({
        version: "0.1.0",
        buildNumber: "224",
        displayVersion: "0.1.0 (224)"
      })
    ),
    getDiagnostics: vi.fn(),
    getToolStatus: vi.fn(),
    refreshToolStatus: vi.fn(),
    refresh: vi.fn(),
    setSearchText: vi.fn(),
    setSelectedTab: vi.fn(),
    updatePreferences: vi.fn(),
    acknowledgeProfileStatsReset: vi.fn(),
    toggleIgnoredApp: vi.fn(),
    toggleIgnoredHomebrew: vi.fn(),
    performAppUpdate: vi.fn(),
    performHomebrewUpdate: vi.fn(),
    performHomebrewUpdateAll: vi.fn(),
    installHomebrewItem: vi.fn(),
    uninstallHomebrewItem: vi.fn(),
    openApp: vi.fn(),
    openExternal: vi.fn(),
    chooseDirectory: vi.fn(),
    removeDirectory: vi.fn(),
    copyDiagnostics: vi.fn(),
    showMainWindow: vi.fn(),
    showSettings: vi.fn(),
    onSnapshotChanged: vi.fn(() => () => undefined),
    onHomebrewCommandEvent: vi.fn(() => () => undefined)
  };
}

function toolbarButtonLabels(container: HTMLElement): Array<string | null> {
  return within(container.querySelector(".topbar-actions") as HTMLElement)
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? button.getAttribute("title"));
}

describe("renderer button parity", () => {
  beforeEach(() => {
    installBaselineMock();
    window.location.hash = "";
  });

  it("shows app ignore/update actions and makes updating glyph non-clickable", () => {
    render(
      <AppRow
        app={app}
        snapshot={snapshot({
          appUpdatingIDs: [app.id],
          homebrewFallbackProgressByAppID: { [app.id]: 0.4 }
        })}
        recentlyUpdated={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Ignore" })).toBeEnabled();
    const updateGlyph = screen.getByRole("button", { name: "Updating" });
    fireEvent.click(updateGlyph);
    expect(window.baseline.performAppUpdate).not.toHaveBeenCalled();
  });

  it("shows Sparkle build-only update versions in app rows", () => {
    const buildOnlyApp = {
      ...app,
      bundleVersion: version("100")
    };
    render(
      <AppRow
        app={buildOnlyApp}
        snapshot={snapshot({
          apps: [buildOnlyApp],
          updates: [
            {
              id: buildOnlyApp.id,
              appID: buildOnlyApp.id,
              source: "sparkle",
              supportLevel: "limited",
              localVersion: version("1.0"),
              remoteVersion: version("1.0"),
              localBuildVersion: version("100"),
              remoteBuildVersion: version("101"),
              checkedAt: "2026-04-30T12:00:00.000Z"
            }
          ]
        })}
        recentlyUpdated={false}
      />
    );

    expect(screen.getByText("1.0 (100)")).toBeInTheDocument();
    expect(screen.getByText("1.0 (101)")).toBeInTheDocument();
  });

  it("shows matched Homebrew cask progress on app update buttons", () => {
    render(
      <AppRow
        app={app}
        snapshot={snapshot({
          homebrewUpdatingItemIDs: [cask.id],
          homebrewBatchProgressByItemID: { [cask.id]: 0.4 }
        })}
        recentlyUpdated={false}
      />
    );

    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Updating" })).toBeInTheDocument();
  });

  it("shows matched Homebrew cask queued state on app update buttons", () => {
    render(
      <AppRow
        app={app}
        snapshot={snapshot({
          homebrewUpdatingItemIDs: [cask.id],
          homebrewQueuedItemIDs: [cask.id],
          homebrewBatchProgressByItemID: { [cask.id]: 0 }
        })}
        recentlyUpdated={false}
      />
    );

    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Updating" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queued" })).toBeInTheDocument();
  });

  it("shows matched Homebrew cask success on app update buttons before refresh", () => {
    render(
      <AppRow
        app={app}
        snapshot={snapshot({
          homebrewUpdatingItemIDs: [cask.id],
          homebrewUpdatedPendingRefreshItemIDs: [cask.id],
          homebrewBatchProgressByItemID: { [cask.id]: 1 }
        })}
        recentlyUpdated={false}
      />
    );

    expect(screen.queryByRole("button", { name: "Updating" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Updated" })).toBeInTheDocument();
  });

  it("keeps Homebrew app updates clickable during active Homebrew commands", () => {
    const sparkleBackedApp: AppRecord = {
      ...app,
      id: "app:sparkle-homebrew-fallback",
      displayName: "Sparkle Homebrew Fallback",
      sourceHint: "sparkle"
    };
    const sparkleBackedUpdate: UpdateRecord = {
      ...update,
      id: sparkleBackedApp.id,
      appID: sparkleBackedApp.id,
      source: "homebrew",
      supportLevel: "limited",
      homebrewToken: "sparkle-homebrew-fallback"
    };

    render(
      <AppRow
        app={sparkleBackedApp}
        snapshot={snapshot({
          apps: [sparkleBackedApp],
          updates: [sparkleBackedUpdate],
          homebrewItems: [],
          isHomebrewCommandLocked: true
        })}
        recentlyUpdated={false}
      />
    );

    const updateButton = screen.getByRole("button", { name: "Update" });
    expect(updateButton).toBeEnabled();
    fireEvent.click(updateButton);
    expect(window.baseline.performAppUpdate).toHaveBeenCalledWith(sparkleBackedApp.id);
  });

  it("groups ignore and uninstall under row actions menu", () => {
    const { container, rerender } = render(
      <AppRow app={app} snapshot={snapshot()} recentlyUpdated={false} />
    );
    expect(
      within(container.querySelector(".row-actions") as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent)
    ).toEqual(["Update", "Actions"]);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Ignore" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Uninstall" })).toBeInTheDocument();

    rerender(<HomebrewRow item={cask} snapshot={snapshot()} />);
    expect(
      within(container.querySelector(".row-actions") as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent)
    ).toEqual(["Update", "Actions"]);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Ignore" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Uninstall" })).toBeInTheDocument();
  });

  it("shows global search results regardless of the selected tab", () => {
    const formula: HomebrewManagedItem = {
      id: "formula:obsidian-cli",
      token: "obsidian-cli",
      name: "obsidian-cli",
      kind: "formula",
      installedVersion: version("1.0.0"),
      latestVersion: version("1.1.0"),
      isOutdated: true
    };
    const discoverItem: HomebrewCaskDiscoveryItem = {
      id: "cask:obsidian",
      token: "obsidian",
      displayName: "Obsidian",
      kind: "cask",
      version: version("1.6.0")
    };

    render(
      <Dashboard
        compact={false}
        searchActive
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "apps",
          searchText: "obsidian",
          apps: [],
          updates: [],
          homebrewItems: [formula],
          homebrewDiscoverItems: [discoverItem],
          collapsedHomebrewSectionIDs: ["discover"]
        })}
      />
    );

    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    const discoverHeading = within(searchDialog).getByText("Discover");
    const homebrewHeading = within(searchDialog).getByText("Homebrew Updates");
    expect(
      discoverHeading.compareDocumentPosition(homebrewHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(within(searchDialog).queryByTitle("Collapse Discover")).not.toBeInTheDocument();
    expect(within(searchDialog).getByText("obsidian-cli")).toBeInTheDocument();
    expect(within(searchDialog).getByText("Obsidian")).toBeInTheDocument();
  });

  it("shows the main-window self-update shortcut only when self-update is available", () => {
    const { container, rerender } = render(
      <Dashboard compact={false} onOpenSettings={() => undefined} snapshot={snapshot()} />
    );

    expect(toolbarButtonLabels(container)).toEqual(["Refresh"]);

    rerender(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selfUpdate: {
            available: true,
            currentVersion: version("0.1.0"),
            latestVersion: version("0.2.0"),
            releaseURL: "https://github.com/arshiaghaf/Baseline/releases/latest",
            checkedAt: "2026-04-30T12:00:00.000Z"
          }
        })}
      />
    );

    expect(toolbarButtonLabels(container)).toEqual(["New Baseline Update Available", "Refresh"]);

    fireEvent.click(screen.getByRole("button", { name: "New Baseline Update Available" }));

    expect(window.baseline.openExternal).toHaveBeenCalledWith(
      "https://github.com/arshiaghaf/Baseline/releases/latest"
    );

    rerender(<Dashboard compact onOpenSettings={() => undefined} snapshot={snapshot()} />);

    expect(
      screen.queryByRole("button", { name: "New Baseline Update Available" })
    ).not.toBeInTheDocument();
  });

  it("opens the main-window search palette from keyboard shortcuts without selecting the query", async () => {
    render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "apps",
          searchText: "obsidian"
        })}
      />
    );

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();

    const appSurface = document.querySelector(".app-content-surface") as HTMLElement & {
      inert?: boolean;
    };
    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    refreshButton.focus();
    fireEvent.keyDown(document, { key: "k", metaKey: true });

    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    const searchField = within(searchDialog).getByDisplayValue("obsidian") as HTMLInputElement;
    expect(searchField).toHaveFocus();
    expect(searchField.selectionStart).toBe(searchField.value.length);
    expect(searchField.selectionEnd).toBe(searchField.value.length);
    expect(appSurface).toHaveAttribute("aria-hidden", "true");
    expect(appSurface.inert).toBe(true);
    expect(
      screen.getByRole("heading", { level: 1, name: "Apps", hidden: true })
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument()
    );
    await waitFor(() => expect(refreshButton).toHaveFocus());
    expect(appSurface).not.toHaveAttribute("aria-hidden");
    expect(appSurface.inert).toBe(false);
    expect(screen.getByRole("heading", { level: 1, name: "Apps" })).toBeInTheDocument();
  });

  it("skips non-tabbable status glyphs when trapping search palette focus", () => {
    const item: HomebrewCaskDiscoveryItem = {
      id: "formula:ray",
      token: "ray",
      displayName: "ray",
      kind: "formula",
      version: version("1.2.3")
    };

    render(
      <Dashboard
        compact={false}
        searchActive
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "homebrew",
          searchText: "ray",
          apps: [],
          updates: [],
          homebrewItems: [],
          homebrewDiscoverItems: [item],
          homebrewDiscoverInstallingItemIDs: [item.id]
        })}
      />
    );

    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    const searchField = within(searchDialog).getByPlaceholderText("Search");
    const clearButton = within(searchDialog).getByRole("button", { name: "Clear Search" });
    const statusGlyph = within(searchDialog).getByRole("button", { name: "Updating" });
    expect(statusGlyph).toHaveAttribute("tabindex", "-1");

    clearButton.focus();
    expect(clearButton).toHaveFocus();
    fireEvent.keyDown(searchDialog, { key: "Tab" });

    expect(searchField).toHaveFocus();
  });

  it("closes search palette row action menus on outside clicks inside the dialog", () => {
    render(
      <Dashboard
        compact={false}
        searchActive
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "apps",
          searchText: "example"
        })}
      />
    );

    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    fireEvent.click(within(searchDialog).getByRole("button", { name: "Actions" }));
    expect(within(searchDialog).getByRole("menu")).toHaveClass("row-action-menu-popover-fixed");
    expect(within(searchDialog).getByRole("menuitem", { name: "Ignore" })).toBeInTheDocument();

    fireEvent.mouseDown(within(searchDialog).getByPlaceholderText("Search"));

    expect(
      within(searchDialog).queryByRole("menuitem", { name: "Ignore" })
    ).not.toBeInTheDocument();
  });

  it("closes search mode on backdrop clicks without clearing the saved query", async () => {
    const formula: HomebrewManagedItem = {
      id: "formula:obsidian-cli",
      token: "obsidian-cli",
      name: "obsidian-cli",
      kind: "formula",
      installedVersion: version("1.0.0"),
      latestVersion: version("1.1.0"),
      isOutdated: true
    };
    const discoverItem: HomebrewCaskDiscoveryItem = {
      id: "cask:obsidian",
      token: "obsidian",
      displayName: "Obsidian",
      kind: "cask",
      version: version("1.6.0")
    };

    const { container } = render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "apps",
          searchText: "obsidian",
          apps: [app],
          updates: [update],
          homebrewItems: [formula],
          homebrewDiscoverItems: [discoverItem]
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    expect(within(searchDialog).getByText("Obsidian")).toBeInTheDocument();
    expect(within(searchDialog).getByText("obsidian-cli")).toBeInTheDocument();
    expect(within(searchDialog).queryByText("Example")).not.toBeInTheDocument();

    fireEvent.mouseDown(container.querySelector(".search-palette-backdrop") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Apps/ }));

    expect(window.baseline.setSelectedTab).toHaveBeenCalledWith("apps");
    expect(window.baseline.setSearchText).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Example")).toBeInTheDocument());
    expect(screen.queryByText("Obsidian")).not.toBeInTheDocument();
    expect(screen.queryByText("obsidian-cli")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    const reopenedSearchDialog = screen.getByRole("dialog", { name: "Search" });
    expect(within(reopenedSearchDialog).getByDisplayValue("obsidian")).toBeInTheDocument();
    expect(within(reopenedSearchDialog).getByText("Obsidian")).toBeInTheDocument();
    expect(within(reopenedSearchDialog).getByText("obsidian-cli")).toBeInTheDocument();

    fireEvent.mouseDown(container.querySelector(".search-palette-backdrop") as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();

    const searchButton = screen.getByRole("button", { name: "Search" });
    fireEvent.mouseDown(searchButton);
    fireEvent.click(searchButton);
    expect(screen.getByRole("dialog", { name: "Search" })).toBeInTheDocument();

    fireEvent.mouseDown(container.querySelector(".search-palette-backdrop") as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
  });

  it("does not show discovery results after dismissing search into the Homebrew tab", () => {
    const formula: HomebrewManagedItem = {
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula",
      installedVersion: version("1.0.0"),
      latestVersion: version("1.1.0"),
      isOutdated: true
    };
    const discoverItem: HomebrewCaskDiscoveryItem = {
      id: "cask:obsidian",
      token: "obsidian",
      displayName: "Obsidian",
      kind: "cask",
      version: version("1.6.0")
    };

    const searchSnapshot = snapshot({
      selectedTab: "apps",
      searchText: "obsidian",
      apps: [],
      updates: [],
      homebrewItems: [formula],
      homebrewDiscoverItems: [discoverItem]
    });
    const { rerender } = render(
      <Dashboard compact={false} onOpenSettings={() => undefined} snapshot={searchSnapshot} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    expect(within(searchDialog).getByText("Obsidian")).toBeInTheDocument();
    expect(within(searchDialog).queryByText("ripgrep")).not.toBeInTheDocument();

    fireEvent.mouseDown(document.querySelector(".search-palette-backdrop") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Homebrew/ }));

    expect(window.baseline.setSelectedTab).toHaveBeenCalledWith("homebrew");
    rerender(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={{ ...searchSnapshot, selectedTab: "homebrew" }}
      />
    );
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
    expect(screen.getByText("ripgrep")).toBeInTheDocument();
    expect(screen.queryByText("Obsidian")).not.toBeInTheDocument();
  });

  it("keeps a preserved query inactive after search is dismissed across remounts", () => {
    const discoverItem: HomebrewCaskDiscoveryItem = {
      id: "cask:obsidian",
      token: "obsidian",
      displayName: "Obsidian",
      kind: "cask",
      version: version("1.6.0")
    };
    const searchSnapshot = snapshot({
      selectedTab: "apps",
      searchText: "obsidian",
      apps: [app],
      updates: [update],
      homebrewItems: [],
      homebrewDiscoverItems: [discoverItem]
    });

    const { unmount } = render(
      <Dashboard compact={false} onOpenSettings={() => undefined} snapshot={searchSnapshot} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    expect(within(searchDialog).getByText("Obsidian")).toBeInTheDocument();
    fireEvent.mouseDown(document.querySelector(".search-palette-backdrop") as HTMLElement);

    unmount();
    render(
      <Dashboard compact={false} onOpenSettings={() => undefined} snapshot={searchSnapshot} />
    );

    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByText("Example")).toBeInTheDocument();
    expect(screen.queryByText("Obsidian")).not.toBeInTheDocument();
  });

  it("keeps sidebar update badges fixed while search filters the content", () => {
    const installedApp: AppRecord = {
      ...app,
      id: "app:stable",
      displayName: "Stable App",
      bundleIdentifier: "com.example.stable"
    };
    const formula: HomebrewManagedItem = {
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula",
      installedVersion: version("1.0.0"),
      latestVersion: version("1.1.0"),
      isOutdated: true
    };
    render(
      <Dashboard
        compact={false}
        searchActive
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          apps: [app, installedApp],
          homebrewItems: [formula],
          searchText: "stable"
        })}
      />
    );

    const allButton = screen.getByRole("button", { name: /All/, hidden: true });
    const appsButton = screen.getByRole("button", { name: /Apps/, hidden: true });
    const homebrewButton = screen.getByRole("button", { name: /Homebrew/, hidden: true });

    expect(within(allButton as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(within(appsButton as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(within(homebrewButton as HTMLElement).getByText("1")).toBeInTheDocument();
    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    expect(within(searchDialog).getByText("Stable App")).toBeInTheDocument();
    expect(within(searchDialog).queryByText("Example")).not.toBeInTheDocument();
    expect(within(searchDialog).queryByText("ripgrep")).not.toBeInTheDocument();
  });

  it("hides sidebar update badges when counts are zero", () => {
    render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({ apps: [], updates: [], homebrewItems: [] })}
      />
    );

    const allButton = screen.getByRole("button", { name: "All" });
    const appsButton = screen.getByRole("button", { name: "Apps" });
    const homebrewButton = screen.getByRole("button", { name: "Homebrew" });

    expect(within(allButton as HTMLElement).queryByText("0")).not.toBeInTheDocument();
    expect(within(appsButton as HTMLElement).queryByText("0")).not.toBeInTheDocument();
    expect(within(homebrewButton as HTMLElement).queryByText("0")).not.toBeInTheDocument();
  });

  it("keeps unowned Sparkle Homebrew fallback casks visible as Homebrew updates", () => {
    const sparkleApp: AppRecord = {
      ...app,
      sourceHint: "sparkle",
      sparkleFeedURL: "https://updates.example.com/appcast.xml"
    };
    const fallbackUpdate: UpdateRecord = {
      ...update,
      supportLevel: "limited",
      appID: sparkleApp.id,
      id: sparkleApp.id
    };
    const fallbackCask: HomebrewManagedItem = {
      ...cask,
      name: "example-cask",
      presentation: "app"
    };

    render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          apps: [sparkleApp],
          updates: [fallbackUpdate],
          homebrewItems: [fallbackCask]
        })}
      />
    );

    expect(screen.getByText("Example")).toBeInTheDocument();
    expect(screen.getByText("example-cask")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Open app" })).toHaveLength(1);
  });

  it("shows settings sections as sidebar tabs without search-filtered badges", () => {
    const installedApp: AppRecord = {
      ...app,
      id: "app:stable",
      displayName: "Stable App",
      bundleIdentifier: "com.example.stable"
    };
    const formula: HomebrewManagedItem = {
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula",
      installedVersion: version("1.0.0"),
      latestVersion: version("1.1.0"),
      isOutdated: true
    };
    const { container } = render(
      <SettingsView
        snapshot={snapshot({
          apps: [app, installedApp],
          homebrewItems: [formula],
          searchText: "stable"
        })}
      />
    );

    expect(within(container).getByRole("button", { name: "Back to app" })).toBeInTheDocument();
    for (const label of ["General", "Profile", "Appearance", "Diagnostics"]) {
      expect(within(container).getByRole("button", { name: label })).toBeInTheDocument();
    }
    const settingsNav = container.querySelector(".source-list");
    expect(settingsNav).not.toBeNull();
    expect(
      within(settingsNav as HTMLElement).queryByRole("button", { name: "Diagnostics" })
    ).not.toBeInTheDocument();
    expect(
      within(settingsNav as HTMLElement).queryByRole("button", { name: "About" })
    ).not.toBeInTheDocument();
    expect(
      within(settingsNav as HTMLElement).queryByRole("button", { name: "Update Tools" })
    ).not.toBeInTheDocument();
    expect(
      within(settingsNav as HTMLElement).queryByRole("button", { name: "Refresh" })
    ).not.toBeInTheDocument();
    expect(
      within(settingsNav as HTMLElement).queryByRole("button", { name: "Scan Directories" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All" })).not.toBeInTheDocument();
    expect(screen.queryByText("Stable App")).not.toBeInTheDocument();
    expect(screen.queryByText("ripgrep")).not.toBeInTheDocument();
  });

  it("shows local profile stats in a settings tab below general", () => {
    render(
      <SettingsView
        snapshot={snapshot({
          apps: [
            {
              ...app,
              iconDataURL: "data:image/png;base64,example-icon"
            },
            {
              ...app,
              id: "app:stable",
              displayName: "Stable App",
              bundleIdentifier: "com.example.stable",
              iconDataURL: "data:image/png;base64,stable-icon"
            },
            {
              ...app,
              id: "app:third",
              displayName: "Third App",
              bundleIdentifier: "com.example.third"
            },
            {
              ...app,
              id: "app:fourth",
              displayName: "Fourth App",
              bundleIdentifier: "com.example.fourth"
            }
          ],
          updates: [],
          homebrewItems: [
            {
              id: "formula:ripgrep",
              token: "ripgrep",
              name: "ripgrep",
              kind: "formula",
              installedVersion: version("1.0.0"),
              isOutdated: false
            },
            {
              id: "cask:aws-vault",
              token: "aws-vault",
              name: "aws-vault",
              kind: "cask",
              presentation: "cli",
              installedVersion: version("1.0.0"),
              isOutdated: false
            },
            {
              id: "cask:orion",
              token: "orion",
              name: "Orion",
              kind: "cask",
              presentation: "app",
              installedVersion: version("1.0.0"),
              isOutdated: false
            }
          ],
          profileStats: {
            createdAt: "2026-06-01T12:00:00.000Z",
            startedUsingAt: "2026-05-15T12:00:00.000Z",
            signatureVersion: profileStatsSignatureVersion,
            integrityStatus: "verified",
            signature: "signed",
            events: [
              {
                id: "appUpdate:example:1:2::",
                type: "appUpdate",
                targetID: app.id,
                displayName: "Example",
                channel: "sparkle",
                occurredAt: "2026-06-02T12:00:00.000Z"
              },
              {
                id: "appUpdate:example:2:3::",
                type: "appUpdate",
                targetID: app.id,
                displayName: "Example",
                channel: "sparkle",
                occurredAt: "2026-06-03T12:00:00.000Z"
              },
              {
                id: "appUpdate:stable:1:2::",
                type: "appUpdate",
                targetID: "app:stable",
                displayName: "Stable App",
                channel: "appStore",
                occurredAt: "2026-06-04T12:00:00.000Z"
              },
              {
                id: "appUpdate:stable:2:3::",
                type: "appUpdate",
                targetID: "app:stable",
                displayName: "Stable App",
                channel: "appStore",
                occurredAt: "2026-06-05T12:00:00.000Z"
              },
              {
                id: "appUpdate:third:1:2::",
                type: "appUpdate",
                targetID: "app:third",
                displayName: "Third App",
                channel: "sparkle",
                occurredAt: "2026-06-06T12:00:00.000Z"
              },
              {
                id: "appUpdate:third:2:3::",
                type: "appUpdate",
                targetID: "app:third",
                displayName: "Third App",
                channel: "sparkle",
                occurredAt: "2026-06-06T13:00:00.000Z"
              },
              {
                id: "appUpdate:fourth:1:2::",
                type: "appUpdate",
                targetID: "app:fourth",
                displayName: "Fourth App",
                channel: "sparkle",
                occurredAt: "2026-06-07T12:00:00.000Z"
              },
              {
                id: "homebrewUpdate:formula:ripgrep:1:2",
                type: "homebrewUpdate",
                targetID: "formula:ripgrep",
                displayName: "ripgrep",
                channel: "homebrew",
                occurredAt: "2026-06-03T12:00:00.000Z"
              },
              {
                id: "homebrewUpdate:cask:aws-vault:1:2",
                type: "homebrewUpdate",
                targetID: "cask:aws-vault",
                displayName: "aws-vault",
                channel: "homebrew",
                occurredAt: "2026-06-04T12:00:00.000Z"
              },
              {
                id: "homebrewUpdate:cask:orion:1:2",
                type: "homebrewUpdate",
                targetID: "cask:orion",
                displayName: "Orion",
                channel: "homebrew",
                occurredAt: "2026-06-04T13:00:00.000Z"
              },
              {
                id: "homebrewInstall:cask:orion:1.0:2026-06-08T12:00:00.000Z",
                type: "homebrewInstall",
                targetID: "cask:orion",
                displayName: "Orion",
                channel: "homebrew",
                occurredAt: "2026-06-08T12:00:00.000Z"
              }
            ]
          }
        })}
      />
    );

    const sourceNav = document.querySelector(".source-list");
    expect(sourceNav).not.toBeNull();
    const buttons = within(sourceNav as HTMLElement).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "General",
      "Profile",
      "Appearance"
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Profile" }));

    expect(screen.getAllByRole("heading", { name: "Profile" })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Time with Baseline" })).not.toBeInTheDocument();
    expect(screen.getByText("with Baseline")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Stats" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Privacy" })).not.toBeInTheDocument();
    expect(screen.getByText("Total updates")).toBeInTheDocument();
    expect(screen.getByText("Unique apps")).toBeInTheDocument();
    expect(screen.getByText("Installs")).toBeInTheDocument();
    expect(screen.getByText(/Since .*2026/)).toBeInTheDocument();
    expect(
      [...document.querySelectorAll(".profile-metric > span")].map((metric) => metric.textContent)
    ).toEqual(["Total updates", "Unique apps", "Installs", "Favorite source"]);
    expect(
      [...document.querySelectorAll(".profile-metric strong")].map((metric) => metric.textContent)
    ).toEqual(["10", "4", "1", "Sparkle"]);
    expect(screen.queryByText("Favorite channel")).not.toBeInTheDocument();
    expect(screen.getByText("Favorite source")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Source mix" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Most updated apps" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Most updated tools" })).toBeInTheDocument();
    expect(
      screen.queryByText("Update or install something with Baseline to build a source history.")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Apps you update with Baseline will appear here.")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Tools you update with Baseline will appear here.")
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Sparkle 45%")).toHaveLength(1);
    expect(screen.getAllByText("Sparkle").length).toBeGreaterThan(0);
    expect(document.querySelector(".profile-start-panel-box")?.hasAttribute("title")).toBe(false);
    const sourceSegment = document.querySelector(".profile-source-segment") as HTMLElement;
    expect(sourceSegment).not.toBeNull();
    fireEvent.pointerMove(sourceSegment, { clientX: 45 });
    expect(sourceSegment.style.getPropertyValue("--profile-source-tooltip-x")).toBe("");
    const topAppRow = screen.getByText("Example").closest("li");
    expect(topAppRow).not.toBeNull();
    expect(topAppRow?.querySelector(".profile-top-app-icon img")).toHaveAttribute(
      "src",
      "data:image/png;base64,example-icon"
    );
    const topAppTiles = document.querySelectorAll(
      ".profile-top-app-list:not(.profile-top-tool-list) li"
    );
    expect(topAppTiles).toHaveLength(3);
    expect([...topAppTiles].every((tile) => !tile.hasAttribute("title"))).toBe(true);
    expect(
      [
        ...document.querySelectorAll(
          ".profile-top-app-list:not(.profile-top-tool-list) .profile-top-app-rank"
        )
      ].map((rank) => rank.className)
    ).toEqual([
      "profile-top-app-rank profile-top-app-rank-1",
      "profile-top-app-rank profile-top-app-rank-2",
      "profile-top-app-rank profile-top-app-rank-3"
    ]);
    expect(screen.getByText("Stable App")).toBeInTheDocument();
    expect(screen.getByText("Third App")).toBeInTheDocument();
    expect([...topAppTiles].some((tile) => tile.textContent?.includes("Fourth App"))).toBe(false);
    const topToolTiles = document.querySelectorAll(".profile-top-tool-list li");
    expect(topToolTiles).toHaveLength(2);
    expect([...topToolTiles].every((tile) => !tile.hasAttribute("title"))).toBe(true);
    expect(screen.getByText("aws-vault")).toBeInTheDocument();
    expect(screen.getByText("1 update · CLI Cask")).toBeInTheDocument();
    expect(screen.getByText("ripgrep")).toBeInTheDocument();
    expect(screen.getByText("1 update · Formula")).toBeInTheDocument();
    expect([...topToolTiles].some((tile) => tile.textContent?.includes("Orion"))).toBe(false);
    expect(
      screen.getByText(
        "Only updates and installs completed with Baseline are counted. Stats stay private on this Mac."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Private stats")).not.toBeInTheDocument();
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Stats were reset")).not.toBeInTheDocument();
  });

  it("shows intentional empty states for first-run profile stats", () => {
    render(
      <SettingsView
        snapshot={snapshot({
          apps: [app],
          updates: [],
          homebrewItems: [],
          profileStats: {
            ...snapshot().profileStats,
            events: []
          }
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Profile" }));

    expect(screen.getByText("No history")).toBeInTheDocument();
    expect(
      screen.getByText("Update or install something with Baseline to build a source history.")
    ).toBeInTheDocument();
    expect(screen.getByText("Apps you update with Baseline will appear here.")).toBeInTheDocument();
    expect(
      screen.getByText("Tools you update with Baseline will appear here.")
    ).toBeInTheDocument();
    expect(document.querySelectorAll(".profile-source-chip")).toHaveLength(0);
    expect(document.querySelectorAll(".profile-top-app-list li")).toHaveLength(0);
  });

  it("shows a profile stats warning only when local history was reset after tampering", () => {
    const resetNotice = {
      id: "tamper:2026-06-05T12:00:00.000Z",
      occurredAt: "2026-06-05T12:00:00.000Z",
      reason: "tamper" as const
    };
    render(
      <SettingsView
        snapshot={snapshot({
          profileStats: {
            ...snapshot().profileStats,
            resetNotice,
            integrityStatus: "resetAfterTamper"
          }
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Profile" }));

    expect(screen.getByText("Stats were reset")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Baseline could not verify the local stats history, so it started a fresh one on this Mac."
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss stats reset warning" }));
    expect(window.baseline.acknowledgeProfileStatsReset).toHaveBeenCalledTimes(1);
  });

  it("hides the profile stats reset warning after acknowledgement", () => {
    const resetNotice = {
      id: "tamper:2026-06-05T12:00:00.000Z",
      occurredAt: "2026-06-05T12:00:00.000Z",
      reason: "tamper" as const
    };
    render(
      <SettingsView
        snapshot={snapshot({
          profileStatsResetAcknowledgedID: resetNotice.id,
          profileStats: {
            ...snapshot().profileStats,
            resetNotice,
            integrityStatus: "resetAfterTamper"
          }
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Profile" }));

    expect(screen.queryByText("Stats were reset")).not.toBeInTheDocument();
  });

  it("returns from settings through the main window bridge", () => {
    render(<SettingsView snapshot={snapshot()} />);

    fireEvent.click(screen.getByRole("button", { name: "Back to app" }));

    expect(window.baseline.showMainWindow).toHaveBeenCalledTimes(1);
  });

  it("opens diagnostics from the settings sidebar footer", async () => {
    render(<SettingsView snapshot={snapshot()} />);

    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));

    expect(screen.getAllByRole("heading", { name: "Diagnostics" })).toHaveLength(2);
    expect(await screen.findByText("0.1.0")).toBeInTheDocument();
    expect(screen.queryByText("0.1.0 (224)")).not.toBeInTheDocument();
  });

  it("uses the same short search placeholder on every tab", () => {
    const { rerender } = render(
      <Dashboard compact onOpenSettings={() => undefined} snapshot={snapshot()} />
    );

    expect(screen.getByPlaceholderText("Search")).toBeInTheDocument();

    rerender(
      <Dashboard
        compact
        onOpenSettings={() => undefined}
        snapshot={snapshot({ selectedTab: "apps" })}
      />
    );
    expect(screen.getByPlaceholderText("Search")).toBeInTheDocument();

    rerender(
      <Dashboard
        compact
        onOpenSettings={() => undefined}
        snapshot={snapshot({ selectedTab: "homebrew" })}
      />
    );
    expect(screen.getByPlaceholderText("Search")).toBeInTheDocument();
  });

  it("clears compact toolbar search and full-window sidebar search", () => {
    const { unmount } = render(
      <Dashboard
        compact
        onOpenSettings={() => undefined}
        snapshot={snapshot({ searchText: "obsidian" })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear Search" }));
    expect(window.baseline.setSearchText).toHaveBeenCalledWith("");

    unmount();
    render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({ searchText: "notion" })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear Search" }));
    expect(window.baseline.setSearchText).toHaveBeenCalledWith("");
  });

  it("opens compact toolbar search and collapses it on outside click without clearing text", async () => {
    render(
      <Dashboard
        compact
        onOpenSettings={() => undefined}
        snapshot={snapshot({ searchText: "obsidian" })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Search" }));
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("button", { name: "Close Search" })).toBeInTheDocument();

    fireEvent.click(document.body);

    await waitFor(() => expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument());
    expect(window.baseline.setSearchText).not.toHaveBeenCalled();
  });

  it("keeps toolbar search open for clicks inside the search controls", () => {
    render(
      <Dashboard
        compact
        onOpenSettings={() => undefined}
        snapshot={snapshot({ searchText: "raycast" })}
      />
    );

    fireEvent.click(screen.getByPlaceholderText("Search"));
    expect(screen.getByRole("button", { name: "Close Search" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear Search" }));

    expect(window.baseline.setSearchText).toHaveBeenCalledWith("");
    expect(screen.getByRole("button", { name: "Close Search" })).toBeInTheDocument();
  });

  it("runs adjacent toolbar actions before collapsing open search", async () => {
    render(
      <Dashboard
        compact
        onOpenSettings={() => undefined}
        snapshot={snapshot({ searchText: "raycast" })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(window.baseline.refresh).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument());
  });

  it("does not render an app open action button when no update exists", () => {
    render(
      <AppRow
        app={app}
        snapshot={snapshot({ updates: [], homebrewItems: [] })}
        recentlyUpdated={false}
      />
    );

    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    const openButton = screen.getByRole("button", { name: "Open app" });
    expect(openButton).toHaveClass("clickable-app-icon");
    fireEvent.click(openButton);
    expect(window.baseline.openApp).toHaveBeenCalledWith(app.id);
  });

  it("shows relative timestamps for recently updated rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    try {
      render(
        <>
          <AppRow
            app={app}
            snapshot={snapshot({
              updates: [],
              recentlyUpdated: [
                {
                  id: "recent:app",
                  appID: app.id,
                  displayName: app.displayName,
                  fromVersion: version("1.0.0"),
                  toVersion: version("2.0.0"),
                  updatedAt: "2026-04-29T12:00:00.000Z"
                }
              ]
            })}
            recentlyUpdated
          />
          <HomebrewRow
            item={cask}
            snapshot={snapshot({
              homebrewRecentlyUpdated: [
                {
                  id: "recent:cask",
                  itemID: cask.id,
                  token: cask.token,
                  kind: cask.kind,
                  displayName: cask.name,
                  fromVersion: version("1.0.0"),
                  toVersion: version("2.0.0"),
                  updatedAt: "2026-04-30T12:00:00.000Z"
                }
              ]
            })}
            recentlyUpdated
          />
        </>
      );

      expect(screen.getByText("Updated 2 days ago")).toBeInTheDocument();
      expect(screen.getByText("Updated 1 day ago")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes matching cask icons open apps but leaves formula icons static", () => {
    const formula: HomebrewManagedItem = {
      id: "formula:example",
      token: "example",
      name: "Example",
      kind: "formula",
      installedVersion: version("1.0.0"),
      latestVersion: version("2.0.0"),
      isOutdated: true
    };
    const { rerender } = render(<HomebrewRow item={cask} snapshot={snapshot()} />);

    const caskOpenButton = screen.getByRole("button", { name: "Open app" });
    expect(caskOpenButton).toHaveClass("clickable-app-icon");
    fireEvent.click(caskOpenButton);
    expect(window.baseline.openApp).toHaveBeenCalledWith(app.id);

    rerender(<HomebrewRow item={formula} snapshot={snapshot()} />);
    expect(screen.queryByRole("button", { name: "Open app" })).not.toBeInTheDocument();
  });

  it("shows presentation labels for Homebrew items without changing their install kind", () => {
    const formula: HomebrewManagedItem = {
      id: "formula:example-cli",
      token: "example-cli",
      name: "example-cli",
      kind: "formula",
      presentation: "formula",
      installedVersion: version("1.0.0"),
      isOutdated: false
    };
    const cliCask: HomebrewManagedItem = {
      id: "cask:example-cli-cask",
      token: "example-cli-cask",
      name: "example-cli-cask",
      kind: "cask",
      presentation: "cli",
      installedVersion: version("1.0.0"),
      isOutdated: false
    };
    const packageCask: HomebrewManagedItem = {
      id: "cask:example-package",
      token: "example-package",
      name: "example-package",
      kind: "cask",
      presentation: "package",
      installedVersion: version("1.0.0"),
      isOutdated: false
    };
    const appCask: HomebrewManagedItem = {
      ...cask,
      presentation: "app"
    };
    const discoverItem: HomebrewCaskDiscoveryItem = {
      id: "cask:discover-cli",
      token: "discover-cli",
      displayName: "Discover CLI",
      kind: "cask",
      presentation: "cli",
      version: version("1.0.0")
    };

    render(
      <>
        <HomebrewRow item={formula} snapshot={snapshot({ homebrewItems: [formula] })} />
        <HomebrewRow item={cliCask} snapshot={snapshot({ homebrewItems: [cliCask] })} />
        <HomebrewRow item={packageCask} snapshot={snapshot({ homebrewItems: [packageCask] })} />
        <HomebrewRow item={appCask} snapshot={snapshot({ homebrewItems: [appCask] })} />
        <DiscoverRow
          item={discoverItem}
          snapshot={snapshot({ homebrewDiscoverItems: [discoverItem] })}
        />
      </>
    );

    expect(screen.getByText("Formula")).toBeInTheDocument();
    expect(screen.getAllByText("CLI Cask")).toHaveLength(2);
    expect(screen.getByText("Package Cask")).toBeInTheDocument();
    expect(screen.getByText("App Cask")).toBeInTheDocument();
    expect(
      screen.getByText("example-cli").closest("article")?.querySelector(".app-icon.brew.tool")
    ).not.toBeNull();
    expect(
      screen.getByText("example-cli-cask").closest("article")?.querySelector(".app-icon.brew.tool")
    ).not.toBeNull();
    expect(
      screen.getByText("Discover CLI").closest("article")?.querySelector(".app-icon.brew.tool")
    ).not.toBeNull();
    expect(
      screen.getByText("example-package").closest("article")?.querySelector(".app-icon.brew.tool")
    ).toBeNull();
    expect(
      screen.getByText("example-package").closest("article")?.querySelector(".app-icon.brew.cask")
    ).not.toBeNull();
  });

  it("keeps ignore enabled while a Homebrew cask is updating and disables uninstall", () => {
    render(
      <HomebrewRow
        item={cask}
        snapshot={snapshot({
          homebrewUpdatingItemIDs: [cask.id],
          homebrewBatchProgressByItemID: { [cask.id]: 0.55 }
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Uninstall" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Ignore" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Updating" }));
    expect(window.baseline.performHomebrewUpdate).not.toHaveBeenCalled();
  });

  it("uses a queued state for queued Homebrew row updates", () => {
    render(
      <HomebrewRow
        item={cask}
        snapshot={snapshot({
          homebrewUpdatingItemIDs: [cask.id],
          homebrewQueuedItemIDs: [cask.id],
          homebrewBatchProgressByItemID: { [cask.id]: 0 }
        })}
      />
    );

    expect(screen.queryByRole("button", { name: "Updating" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("button", { name: "Queued" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Queued" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Uninstall" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Ignore" })).toBeEnabled();
  });

  it("disables Homebrew ignore/update while uninstalling", () => {
    render(
      <HomebrewRow item={cask} snapshot={snapshot({ homebrewUninstallingItemIDs: [cask.id] })} />
    );

    expect(screen.getByRole("button", { name: "Actions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
  });

  it("renders failed and done states as non-clickable glyph buttons", () => {
    const { rerender } = render(
      <HomebrewRow item={cask} snapshot={snapshot({ homebrewBatchFailedItemIDs: [cask.id] })} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Update failed" }));
    expect(window.baseline.performHomebrewUpdate).not.toHaveBeenCalled();

    rerender(
      <HomebrewRow
        item={cask}
        snapshot={snapshot({ homebrewUpdatedPendingRefreshItemIDs: [cask.id] })}
      />
    );
    expect(screen.getByRole("button", { name: "Updated" })).toBeInTheDocument();
  });

  it("routes discover install through confirmation before calling the bridge", () => {
    const requestConfirmation = vi.fn();
    const item: HomebrewCaskDiscoveryItem = {
      id: "cask:raycast",
      token: "raycast",
      displayName: "Raycast",
      kind: "cask",
      version: version("1.2.3")
    };

    render(
      <ActionConfirmationContext.Provider value={requestConfirmation}>
        <DiscoverRow item={item} snapshot={snapshot({ homebrewDiscoverItems: [item] })} />
      </ActionConfirmationContext.Provider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(requestConfirmation).toHaveBeenCalledWith({ type: "install", item });
    expect(window.baseline.installHomebrewItem).not.toHaveBeenCalled();
  });

  it("disables discover installs when Homebrew is unavailable", () => {
    const requestConfirmation = vi.fn();
    const item: HomebrewCaskDiscoveryItem = {
      id: "cask:raycast",
      token: "raycast",
      displayName: "Raycast",
      kind: "cask",
      version: version("1.2.3")
    };

    render(
      <ActionConfirmationContext.Provider value={requestConfirmation}>
        <DiscoverRow
          item={item}
          snapshot={snapshot({
            isHomebrewInstalled: false,
            homebrewDiscoverItems: [item]
          })}
        />
      </ActionConfirmationContext.Provider>
    );

    const installButton = screen.getByRole("button", { name: "Needs Homebrew" });
    expect(installButton).toBeDisabled();
    expect(
      screen.getByText("Homebrew is not installed. Install Homebrew to enable this source.")
    ).toBeInTheDocument();
    fireEvent.click(installButton);
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(window.baseline.installHomebrewItem).not.toHaveBeenCalled();
  });

  it("disables discover installs while Homebrew maintenance is active", () => {
    const requestConfirmation = vi.fn();
    const item: HomebrewCaskDiscoveryItem = {
      id: "cask:raycast",
      token: "raycast",
      displayName: "Raycast",
      kind: "cask",
      version: version("1.2.3")
    };

    render(
      <ActionConfirmationContext.Provider value={requestConfirmation}>
        <DiscoverRow
          item={item}
          snapshot={snapshot({
            isRunningHomebrewMaintenance: true,
            homebrewDiscoverItems: [item]
          })}
        />
      </ActionConfirmationContext.Provider>
    );

    const busyButton = screen.getByRole("button", { name: "Busy" });
    expect(busyButton).toBeDisabled();
    fireEvent.click(busyButton);
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(window.baseline.installHomebrewItem).not.toHaveBeenCalled();
  });

  it("disables other discover installs while a Homebrew command lock is active", () => {
    const requestConfirmation = vi.fn();
    const doneItem: HomebrewCaskDiscoveryItem = {
      id: "formula:fd",
      token: "fd",
      displayName: "fd",
      kind: "formula",
      version: version("10.0.0")
    };
    const otherItem: HomebrewCaskDiscoveryItem = {
      id: "formula:ripgrep",
      token: "ripgrep",
      displayName: "ripgrep",
      kind: "formula",
      version: version("14.1.0")
    };

    render(
      <ActionConfirmationContext.Provider value={requestConfirmation}>
        <DiscoverRow
          item={otherItem}
          snapshot={snapshot({
            isHomebrewCommandLocked: true,
            homebrewDiscoverItems: [doneItem, otherItem],
            homebrewDiscoverInstalledPendingRefreshItemIDs: [doneItem.id]
          })}
        />
      </ActionConfirmationContext.Provider>
    );

    const busyButton = screen.getByRole("button", { name: "Busy" });
    expect(busyButton).toBeDisabled();
    fireEvent.click(busyButton);
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(window.baseline.installHomebrewItem).not.toHaveBeenCalled();
  });

  it("orders discover actions as install then open page", () => {
    const item: HomebrewCaskDiscoveryItem = {
      id: "cask:raycast",
      token: "raycast",
      displayName: "Raycast",
      kind: "cask",
      version: version("1.2.3"),
      homepageURL: "https://www.raycast.com"
    };
    const { container } = render(
      <DiscoverRow item={item} snapshot={snapshot({ homebrewDiscoverItems: [item] })} />
    );

    expect(
      within(container.querySelector(".row-actions") as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent)
    ).toEqual(["Install", "Open Homebrew page"]);
  });

  it("confirms install in the dashboard overlay before invoking install", () => {
    const item: HomebrewCaskDiscoveryItem = {
      id: "cask:raycast",
      token: "raycast",
      displayName: "Raycast",
      kind: "cask",
      version: version("1.2.3")
    };

    render(
      <Dashboard
        compact={false}
        searchActive
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "homebrew",
          searchText: "ray",
          homebrewDiscoverItems: [item],
          updates: [],
          homebrewItems: []
        })}
      />
    );

    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    fireEvent.click(within(searchDialog).getByRole("button", { name: "Install" }));
    const dialog = screen.getByRole("dialog", { name: "Install Raycast?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Install Raycast" }));
    expect(window.baseline.installHomebrewItem).toHaveBeenCalledWith(item);
  });

  it("shows Update Brews only for sections with more than one outdated item", () => {
    const second: HomebrewManagedItem = {
      ...cask,
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula"
    };
    const { rerender } = render(
      <HomebrewSection
        sectionID="outdated"
        title="Outdated"
        items={[cask]}
        snapshot={snapshot()}
        empty="No updates."
        showUpdateAll
      />
    );
    expect(screen.queryByRole("button", { name: "Update Brews" })).not.toBeInTheDocument();

    rerender(
      <HomebrewSection
        sectionID="outdated"
        title="Outdated"
        items={[cask, second]}
        snapshot={snapshot({ homebrewItems: [cask, second] })}
        empty="No updates."
        showUpdateAll
      />
    );
    expect(screen.getByRole("button", { name: "Update Brews" })).toBeInTheDocument();
  });

  it("keeps individual Homebrew update actions clickable while a Discover install is active", () => {
    const second: HomebrewManagedItem = {
      ...cask,
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula"
    };

    render(
      <HomebrewSection
        sectionID="outdated"
        title="Outdated"
        items={[cask, second]}
        snapshot={snapshot({
          homebrewItems: [cask, second],
          homebrewDiscoverInstallingItemIDs: ["formula:fd"]
        })}
        empty="No updates."
        showUpdateAll
      />
    );

    const batchButton = screen.getByRole("button", { name: "Updating" });
    expect(batchButton).toBeDisabled();
    fireEvent.click(batchButton);
    expect(window.baseline.performHomebrewUpdateAll).not.toHaveBeenCalled();

    for (const updateButton of screen.getAllByRole("button", { name: "Update" })) {
      expect(updateButton).toBeEnabled();
      fireEvent.click(updateButton);
    }
    expect(window.baseline.performHomebrewUpdate).toHaveBeenCalledTimes(2);
  });

  it("renders full-window update sections as card grids with inline update actions", () => {
    const formula: HomebrewManagedItem = {
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula",
      installedVersion: version("14.0.0"),
      latestVersion: version("14.1.0"),
      isOutdated: true
    };
    const secondFormula: HomebrewManagedItem = {
      id: "formula:fd",
      token: "fd",
      name: "fd",
      kind: "formula",
      installedVersion: version("9.0.0"),
      latestVersion: version("10.0.0"),
      isOutdated: true
    };
    const { container } = render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({ homebrewItems: [cask, formula, secondFormula] })}
      />
    );

    expect(screen.getByRole("heading", { name: "Updates" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "App Updates" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Homebrew Updates" })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".update-grid")).toHaveLength(1);
    expect(container.querySelectorAll(".update-card")).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Update" })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Update Brews" })).toBeInTheDocument();
    expect(
      Array.from(container.querySelectorAll(".update-card")).map((card) => card.textContent)
    ).toEqual(expect.arrayContaining([expect.stringContaining("Homebrew")]));
    expect(
      Array.from(container.querySelectorAll(".update-card")).map((card) => card.textContent)
    ).toEqual(expect.arrayContaining([expect.stringContaining("Formula")]));
    expect(screen.getByText("1.0.0")).toBeInTheDocument();
    expect(screen.getByText("2.0.0")).toBeInTheDocument();
    expect(screen.getByText("14.0.0")).toBeInTheDocument();
    expect(screen.getByText("14.1.0")).toBeInTheDocument();
    expect(screen.getByText("9.0.0")).toBeInTheDocument();
    expect(screen.getByText("10.0.0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update Brews" }));
    expect(window.baseline.performHomebrewUpdateAll).toHaveBeenCalledWith([
      "formula:fd",
      "formula:ripgrep"
    ]);
  });

  it("renders the Homebrew tab outdated section as a card grid", () => {
    const formula: HomebrewManagedItem = {
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula",
      installedVersion: version("14.0.0"),
      latestVersion: version("14.1.0"),
      isOutdated: true
    };
    const { container } = render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({ selectedTab: "homebrew", homebrewItems: [cask, formula] })}
      />
    );

    expect(container.querySelector(".update-grid")).toBeInTheDocument();
    expect(container.querySelector(".update-card")).toBeInTheDocument();
    expect(container.querySelectorAll(".update-card")).toHaveLength(1);
    expect(container.querySelector(".rows .update-card")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
    expect(screen.getByText("Formula")).toBeInTheDocument();
    expect(screen.getByText("14.0.0")).toBeInTheDocument();
    expect(screen.getByText("14.1.0")).toBeInTheDocument();
    expect(screen.queryByText("Cask")).not.toBeInTheDocument();
    expect(screen.queryByText("1.0.0")).not.toBeInTheDocument();
    expect(screen.queryByText("2.0.0")).not.toBeInTheDocument();
  });

  it("hides app-backed Homebrew casks from the Homebrew tab when the matching app is ignored", () => {
    const formula: HomebrewManagedItem = {
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula",
      installedVersion: version("14.0.0"),
      latestVersion: version("14.1.0"),
      isOutdated: true
    };
    const { container } = render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "homebrew",
          ignoredIDs: [app.id],
          homebrewItems: [cask, formula]
        })}
      />
    );

    expect(container.querySelectorAll(".update-card")).toHaveLength(1);
    expect(screen.getByText("Formula")).toBeInTheDocument();
    expect(screen.getByText("14.0.0")).toBeInTheDocument();
    expect(screen.getByText("14.1.0")).toBeInTheDocument();
    expect(screen.queryByText("Cask")).not.toBeInTheDocument();
    expect(screen.queryByText("1.0.0")).not.toBeInTheDocument();
    expect(screen.queryByText("2.0.0")).not.toBeInTheDocument();
  });

  it("updates the Homebrew rows currently visible in search results", () => {
    const searchCask: HomebrewManagedItem = {
      ...cask,
      id: "cask:example-cli",
      token: "example-cli",
      name: "Example CLI"
    };
    const formula: HomebrewManagedItem = {
      id: "formula:ripgrep-cli",
      token: "ripgrep-cli",
      name: "ripgrep-cli",
      kind: "formula",
      installedVersion: version("14.0.0"),
      latestVersion: version("14.1.0"),
      isOutdated: true
    };
    render(
      <Dashboard
        compact={false}
        searchActive
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          searchText: "cli",
          updates: [{ ...update, homebrewToken: searchCask.token }],
          homebrewItems: [searchCask, formula]
        })}
      />
    );

    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    expect(within(searchDialog).getByText("Example CLI")).toBeInTheDocument();
    expect(within(searchDialog).queryByText("App Updates")).not.toBeInTheDocument();

    const formulaRow = within(searchDialog).getByText("ripgrep-cli").closest("article");
    expect(formulaRow).not.toBeNull();
    fireEvent.click(within(formulaRow as HTMLElement).getByRole("button", { name: "Update" }));

    expect(window.baseline.performHomebrewUpdate).toHaveBeenCalledWith(formula.id);
    expect(window.baseline.performHomebrewUpdateAll).not.toHaveBeenCalled();
  });

  it("hides ignored app-backed Homebrew casks from search results", () => {
    const searchCask: HomebrewManagedItem = {
      ...cask,
      id: "cask:example-cli",
      token: "example-cli",
      name: "Example CLI"
    };
    const formula: HomebrewManagedItem = {
      id: "formula:ripgrep-cli",
      token: "ripgrep-cli",
      name: "ripgrep-cli",
      kind: "formula",
      installedVersion: version("14.0.0"),
      latestVersion: version("14.1.0"),
      isOutdated: true
    };
    render(
      <Dashboard
        compact={false}
        searchActive
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          searchText: "cli",
          ignoredIDs: [app.id],
          updates: [{ ...update, homebrewToken: searchCask.token }],
          homebrewItems: [searchCask, formula]
        })}
      />
    );

    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    expect(within(searchDialog).queryByText("Example CLI")).not.toBeInTheDocument();
    expect(within(searchDialog).getByText("ripgrep-cli")).toBeInTheDocument();
  });

  it("moves installed apps and Homebrew into the Installed sidebar item", () => {
    const installedApp: AppRecord = {
      ...app,
      id: "app:stable",
      displayName: "Stable App"
    };
    const installedFormula: HomebrewManagedItem = {
      ...cask,
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula",
      latestVersion: version("1.0.0"),
      isOutdated: false
    };
    const installedSnapshot = snapshot({
      apps: [installedApp],
      updates: [],
      homebrewItems: [installedFormula]
    });
    const { container, rerender } = render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={{ ...installedSnapshot, selectedTab: "all" }}
      />
    );

    expect(screen.getByRole("button", { name: "Installed" })).toBeInTheDocument();
    expect(screen.queryByText("Stable App")).not.toBeInTheDocument();
    expect(screen.queryByText("ripgrep")).not.toBeInTheDocument();

    rerender(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={{ ...installedSnapshot, selectedTab: "apps" }}
      />
    );
    expect(screen.queryByText("Stable App")).not.toBeInTheDocument();

    rerender(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={{ ...installedSnapshot, selectedTab: "homebrew" }}
      />
    );
    expect(screen.queryByText("ripgrep")).not.toBeInTheDocument();

    rerender(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={{ ...installedSnapshot, selectedTab: "installed" }}
      />
    );
    expect(screen.getByText("Stable App")).toBeInTheDocument();
    expect(screen.getByText("ripgrep")).toBeInTheDocument();
    expect(container.querySelectorAll(".update-card")).toHaveLength(2);
    expect(container.querySelector(".rows .update-card")).not.toBeInTheDocument();
  });

  it("adds a combined Ignored sidebar item for ignored apps and Homebrew items", () => {
    const ignoredFormula: HomebrewManagedItem = {
      ...cask,
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula"
    };
    const { container, rerender } = render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "all",
          ignoredIDs: [app.id],
          ignoredHomebrewItemIDs: [ignoredFormula.id],
          homebrewItems: [ignoredFormula]
        })}
      />
    );

    const sourceLists = Array.from(container.querySelectorAll(".source-list"));
    expect(
      within(sourceLists[2] as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.textContent?.trim())
    ).toEqual(["Installed", "Ignored"]);
    fireEvent.click(screen.getByRole("button", { name: /Ignored/ }));
    expect(window.baseline.setSelectedTab).toHaveBeenCalledWith("ignored");

    rerender(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "ignored",
          ignoredIDs: [app.id],
          ignoredHomebrewItemIDs: [ignoredFormula.id],
          homebrewItems: [ignoredFormula]
        })}
      />
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Ignored", hidden: true })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /Ignored Apps and Homebrew/ })
    ).toBeInTheDocument();
    expect(screen.getByText("Example")).toBeInTheDocument();
    expect(screen.getByText("ripgrep")).toBeInTheDocument();
    expect(screen.getByText("Formula")).toBeInTheDocument();
    expect(container.querySelectorAll(".ignored-card")).toHaveLength(2);

    rerender(
      <Dashboard
        compact={false}
        searchActive
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "ignored",
          searchText: "rip",
          ignoredIDs: [app.id],
          ignoredHomebrewItemIDs: [ignoredFormula.id],
          homebrewItems: [ignoredFormula]
        })}
      />
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Ignored", hidden: true })
    ).toBeInTheDocument();
    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    expect(
      within(searchDialog).getByRole("heading", { level: 2, name: "Ignored Homebrew" })
    ).toBeInTheDocument();
    expect(within(searchDialog).getByText("ripgrep")).toBeInTheDocument();
    expect(within(searchDialog).queryByText("Example")).not.toBeInTheDocument();
    expect(within(searchDialog).queryByText("No matches found.")).not.toBeInTheDocument();
  });

  it("keeps app sections visible without Settings section controls", () => {
    const ignoredFormula: HomebrewManagedItem = {
      ...cask,
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula"
    };
    const fixedSectionsSnapshot = snapshot({
      selectedTab: "apps",
      ignoredIDs: [app.id],
      ignoredHomebrewItemIDs: [ignoredFormula.id],
      homebrewItems: [ignoredFormula]
    });
    const { rerender } = render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={fixedSectionsSnapshot}
      />
    );

    expect(screen.getByTitle("Collapse Ignored")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Example")).toBeInTheDocument();

    rerender(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={{ ...fixedSectionsSnapshot, selectedTab: "homebrew" }}
      />
    );

    expect(screen.getByTitle("Collapse Ignored")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("ripgrep")).toBeInTheDocument();

    rerender(<SettingsView snapshot={fixedSectionsSnapshot} />);

    expect(screen.queryByRole("heading", { name: "Sections" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Installed apps")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Recently updated apps")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Ignored apps")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Recently updated Homebrew")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Installed Homebrew")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Ignored Homebrew")).not.toBeInTheDocument();
  });

  it("renders compact menu bar as all updates without tabs or recent sections", () => {
    const { container } = render(
      <Dashboard
        compact
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "homebrew",
          recentlyUpdated: [
            {
              id: "recent:example",
              appID: app.id,
              displayName: app.displayName,
              fromVersion: version("0.9.0"),
              toVersion: version("1.0.0"),
              updatedAt: "2026-04-30T12:00:00.000Z"
            }
          ],
          homebrewRecentlyUpdated: [
            {
              id: "recent:cask:example",
              itemID: cask.id,
              token: cask.token,
              kind: cask.kind,
              displayName: cask.name,
              fromVersion: version("0.9.0"),
              toVersion: version("1.0.0"),
              updatedAt: "2026-04-30T12:00:00.000Z"
            }
          ]
        })}
      />
    );

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(container.querySelector(".update-grid")).not.toBeInTheDocument();
    expect(screen.queryByText("2 available")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveClass("toolbar-button");
    expect(screen.getByRole("button", { name: "Settings" })).toHaveClass("toolbar-button");
    expect(screen.getByRole("heading", { name: "App Updates" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Homebrew Updates" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Recently Updated Apps" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Recently Updated Homebrew" })
    ).not.toBeInTheDocument();
  });

  it("clears compact menu bar control focus", async () => {
    render(<Dashboard compact onOpenSettings={() => undefined} snapshot={snapshot()} />);

    await waitFor(() => expect(document.activeElement).toBe(document.body));
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("tabindex", "-1");

    screen.getByRole("button", { name: "Open app" }).focus();
    await waitFor(() => expect(document.activeElement).toBe(document.body));
  });

  it("keeps compact menu bar row actions clickable while clearing focus", async () => {
    render(<Dashboard compact onOpenSettings={() => undefined} snapshot={snapshot()} />);

    fireEvent.mouseDown(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));

    expect(screen.getByRole("menuitem", { name: "Ignore" })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(document.body));
  });

  it("keeps compact menu bar search input focused when search is already open", async () => {
    render(
      <Dashboard
        compact
        onOpenSettings={() => undefined}
        snapshot={snapshot({ searchText: "raycast" })}
      />
    );

    await waitFor(() => expect(screen.getByPlaceholderText("Search")).toHaveFocus());
  });

  it("opens compact menu bar search when the production app loads a saved query", async () => {
    vi.mocked(window.baseline.getSnapshot).mockResolvedValue(
      snapshot({
        searchText: "example"
      })
    );
    window.location.hash = "/menubar";

    render(<App />);

    await waitFor(() => expect(screen.getByPlaceholderText("Search")).toHaveFocus());
    expect(screen.getByRole("button", { name: "Close Search" })).toBeInTheDocument();
    expect(screen.getByText("Example")).toBeInTheDocument();
  });

  it("unifies app and Homebrew recently updated cards in the All tab without duplicating cask-backed apps", () => {
    const currentCask: HomebrewManagedItem = {
      ...cask,
      latestVersion: version("2.0.0"),
      isOutdated: false,
      appID: app.id
    };
    const standaloneCask: HomebrewManagedItem = {
      ...cask,
      id: "cask:standalone",
      token: "standalone",
      name: "Standalone",
      presentation: "app",
      latestVersion: version("2.0.0"),
      isOutdated: false
    };
    const formula: HomebrewManagedItem = {
      ...cask,
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula",
      latestVersion: version("2.0.0"),
      isOutdated: false
    };

    const { container } = render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "all",
          updates: [],
          homebrewItems: [currentCask, standaloneCask, formula],
          recentlyUpdated: [
            {
              id: "recent:app",
              appID: app.id,
              displayName: app.displayName,
              fromVersion: version("1.0.0"),
              toVersion: version("2.0.0"),
              updatedAt: "2026-04-29T12:00:00.000Z"
            }
          ],
          homebrewRecentlyUpdated: [
            {
              id: "recent:cask:example",
              itemID: currentCask.id,
              token: currentCask.token,
              kind: currentCask.kind,
              displayName: currentCask.name,
              fromVersion: version("1.0.0"),
              toVersion: version("2.0.0"),
              updatedAt: "2026-04-30T12:00:00.000Z"
            },
            {
              id: "recent:cask:standalone",
              itemID: standaloneCask.id,
              token: standaloneCask.token,
              kind: standaloneCask.kind,
              displayName: standaloneCask.name,
              fromVersion: version("1.0.0"),
              toVersion: version("2.0.0"),
              updatedAt: "2026-04-30T12:00:00.000Z"
            },
            {
              id: "recent:formula:ripgrep",
              itemID: formula.id,
              token: formula.token,
              kind: formula.kind,
              displayName: formula.name,
              fromVersion: version("1.0.0"),
              toVersion: version("2.0.0"),
              updatedAt: "2026-04-30T12:00:00.000Z"
            }
          ]
        })}
      />
    );

    expect(screen.getByRole("button", { name: "Recently Updated" })).toBeInTheDocument();
    const recentGrid = container.querySelector(".recent-grid");
    expect(recentGrid).toBeInTheDocument();
    expect(recentGrid?.querySelectorAll(".recent-card")).toHaveLength(3);
    expect(
      screen.queryByRole("heading", { name: "Recently Updated Apps" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Recently Updated Homebrew" })
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Example")).toHaveLength(1);
    expect(screen.getByText("Standalone")).toBeInTheDocument();
    expect(screen.getByText("ripgrep")).toBeInTheDocument();
    const standaloneCard = [...(recentGrid?.querySelectorAll(".recent-card") ?? [])].find((card) =>
      card.textContent?.includes("Standalone")
    );
    expect(standaloneCard).toBeDefined();
    expect(within(standaloneCard as HTMLElement).getByText("Homebrew")).toBeInTheDocument();
  });

  it("renders app and Homebrew recently updated sections as card grids outside compact mode", () => {
    const recentApp = {
      id: "recent:app",
      appID: app.id,
      displayName: app.displayName,
      fromVersion: version("1.0.0"),
      toVersion: version("2.0.0"),
      updatedAt: "2026-04-29T12:00:00.000Z"
    };
    const recentCask = {
      id: "recent:cask",
      itemID: cask.id,
      token: cask.token,
      kind: cask.kind,
      displayName: cask.name,
      fromVersion: version("1.0.0"),
      toVersion: version("2.0.0"),
      updatedAt: "2026-04-30T12:00:00.000Z"
    };

    const { container, rerender } = render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "apps",
          updates: [],
          recentlyUpdated: [recentApp]
        })}
      />
    );

    expect(container.querySelector(".recent-grid")).toBeInTheDocument();
    expect(container.querySelector(".recent-card")).toBeInTheDocument();
    expect(container.querySelector(".rows .recent-card")).not.toBeInTheDocument();

    rerender(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "homebrew",
          homebrewItems: [{ ...cask, isOutdated: false }],
          updates: [],
          homebrewRecentlyUpdated: [recentCask]
        })}
      />
    );

    expect(container.querySelector(".recent-grid")).toBeInTheDocument();
    expect(container.querySelector(".recent-card")).toBeInTheDocument();
  });

  it("shows source labels on recently updated app cards without active updates", () => {
    const appBackedItem: HomebrewManagedItem = {
      ...cask,
      appID: app.id,
      isOutdated: false,
      presentation: "app"
    };

    const { container, rerender } = render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "apps",
          updates: [],
          homebrewItems: [],
          recentlyUpdated: [
            {
              id: "recent:app",
              appID: app.id,
              displayName: app.displayName,
              source: "sparkle",
              fromVersion: version("1.0.0"),
              toVersion: version("2.0.0"),
              updatedAt: "2026-04-29T12:00:00.000Z"
            }
          ]
        })}
      />
    );

    expect(
      within(container.querySelector(".recent-card") as HTMLElement).getByText("Sparkle")
    ).toBeInTheDocument();

    rerender(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "apps",
          updates: [],
          homebrewItems: [appBackedItem],
          recentlyUpdated: [
            {
              id: "recent:app",
              appID: app.id,
              displayName: app.displayName,
              fromVersion: version("1.0.0"),
              toVersion: version("2.0.0"),
              updatedAt: "2026-04-29T12:00:00.000Z"
            }
          ]
        })}
      />
    );

    expect(
      within(container.querySelector(".recent-card") as HTMLElement).getByText("Homebrew")
    ).toBeInTheDocument();
  });

  it("renders ignored app and Homebrew sections as card grids with existing update details", () => {
    const { container, rerender } = render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "apps",
          ignoredIDs: [app.id]
        })}
      />
    );

    expect(container.querySelector(".ignored-grid")).toBeInTheDocument();
    expect(container.querySelector(".ignored-card")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    expect(screen.getByText("1.0.0")).toBeInTheDocument();
    expect(screen.getByText("2.0.0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Update",
      "Unignore",
      "Uninstall"
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Update" }));
    expect(window.baseline.performAppUpdate).toHaveBeenCalledWith(app.id);

    rerender(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "homebrew",
          ignoredHomebrewItemIDs: [cask.id]
        })}
      />
    );

    expect(container.querySelector(".ignored-grid")).toBeInTheDocument();
    expect(container.querySelector(".ignored-card")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    expect(screen.getByText("Cask")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Update",
      "Unignore",
      "Uninstall"
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Update" }));
    expect(window.baseline.performHomebrewUpdate).toHaveBeenCalledWith(cask.id);
  });

  it("search includes installed items and hides empty result sections", () => {
    const installedApp: AppRecord = {
      ...app,
      id: "app:notion-notes",
      displayName: "Notion Notes"
    };
    const installedFormula: HomebrewManagedItem = {
      ...cask,
      id: "formula:notion-cli",
      token: "notion-cli",
      name: "notion-cli",
      kind: "formula",
      latestVersion: version("1.0.0"),
      isOutdated: false
    };
    const discoverItem: HomebrewCaskDiscoveryItem = {
      id: "cask:notion-calendar",
      token: "notion-calendar",
      displayName: "Notion Calendar",
      kind: "cask",
      version: version("1.0.0")
    };

    render(
      <Dashboard
        compact={false}
        searchActive
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "apps",
          searchText: "notion",
          apps: [installedApp],
          updates: [],
          homebrewItems: [installedFormula],
          homebrewDiscoverItems: [discoverItem]
        })}
      />
    );

    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    expect(within(searchDialog).getByText("Notion Notes")).toBeInTheDocument();
    expect(within(searchDialog).getByText("notion-cli")).toBeInTheDocument();
    expect(within(searchDialog).getByText("Notion Calendar")).toBeInTheDocument();
    expect(
      within(searchDialog).queryByText("All your apps are up to date.")
    ).not.toBeInTheDocument();
    expect(
      within(searchDialog).queryByText("All your Homebrew items are up to date.")
    ).not.toBeInTheDocument();
    expect(within(searchDialog).getAllByRole("heading", { level: 2 })[0]).toHaveTextContent(
      "Discover"
    );

    const sections = Array.from(searchDialog.querySelectorAll(".search-palette-section"));
    const discoverSection = sections.find((section) =>
      within(section as HTMLElement).queryByRole("heading", { name: "Discover" })
    ) as HTMLElement | undefined;
    const installedAppsSection = sections.find((section) =>
      within(section as HTMLElement).queryByRole("heading", { name: "Installed Apps" })
    ) as HTMLElement | undefined;
    const installedHomebrewSection = sections.find((section) =>
      within(section as HTMLElement).queryByRole("heading", { name: "Installed Homebrew" })
    ) as HTMLElement | undefined;

    expect(discoverSection).toBeDefined();
    expect(installedAppsSection).toBeDefined();
    expect(installedHomebrewSection).toBeDefined();
    expect(discoverSection!.querySelector(".rows .row")).not.toBeNull();
    expect(discoverSection!.querySelector(".item-card")).toBeNull();
    expect(installedAppsSection!.querySelector(".rows .row")).not.toBeNull();
    expect(installedAppsSection!.querySelector(".item-card")).toBeNull();
    expect(installedHomebrewSection!.querySelector(".rows .row")).not.toBeNull();
    expect(installedHomebrewSection!.querySelector(".item-card")).toBeNull();
  });

  it("shows app-backed Homebrew updates in search when the app result does not match", () => {
    const shortNamedApp: AppRecord = {
      ...app,
      id: "app:short-name",
      bundlePath: "/Applications/Short Name.app",
      displayName: "Short Name",
      bundleIdentifier: "com.example.shortname"
    };
    const matchingUpdate: UpdateRecord = {
      ...update,
      id: shortNamedApp.id,
      appID: shortNamedApp.id,
      homebrewToken: "long-token-name"
    };
    const matchingCask: HomebrewManagedItem = {
      ...cask,
      id: "cask:long-token-name",
      token: "long-token-name",
      name: "Long Token Name"
    };

    render(
      <Dashboard
        compact={false}
        searchActive
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          searchText: "long-token-name",
          apps: [shortNamedApp],
          updates: [matchingUpdate],
          homebrewItems: [matchingCask]
        })}
      />
    );

    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    expect(
      within(searchDialog).queryByRole("heading", { name: "App Updates" })
    ).not.toBeInTheDocument();
    expect(
      within(searchDialog).getByRole("heading", { name: "Homebrew Updates" })
    ).toBeInTheDocument();
    expect(within(searchDialog).getByText("Long Token Name")).toBeInTheDocument();
  });

  it("search hides cask-backed apps from Installed Apps", () => {
    const caskBackedApp: AppRecord = {
      ...app,
      id: "app:managed",
      bundlePath: "/Applications/Managed.app",
      displayName: "Managed"
    };
    const nonCaskApp: AppRecord = {
      ...app,
      id: "app:managed-helper",
      bundlePath: "/Applications/Managed Helper.app",
      displayName: "Managed Helper"
    };
    const installedCask: HomebrewManagedItem = {
      ...cask,
      id: "cask:managed",
      token: "managed",
      name: "Managed",
      latestVersion: version("1.0.0"),
      isOutdated: false,
      appID: caskBackedApp.id
    };

    render(
      <Dashboard
        compact={false}
        searchActive
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "apps",
          searchText: "managed",
          apps: [caskBackedApp, nonCaskApp],
          updates: [],
          homebrewItems: [installedCask],
          homebrewDiscoverItems: []
        })}
      />
    );

    const searchDialog = screen.getByRole("dialog", { name: "Search" });
    const installedApps = within(searchDialog)
      .getByRole("heading", { name: "Installed Apps" })
      .closest("section");
    const installedHomebrew = within(searchDialog)
      .getByRole("heading", { name: "Installed Homebrew" })
      .closest("section");
    expect(installedApps).not.toBeNull();
    expect(installedHomebrew).not.toBeNull();
    expect(within(installedApps as HTMLElement).queryByText("Managed")).not.toBeInTheDocument();
    expect(within(installedApps as HTMLElement).getByText("Managed Helper")).toBeInTheDocument();
    expect(within(installedHomebrew as HTMLElement).getByText("Managed")).toBeInTheDocument();
  });

  it("does not show a Homebrew-backed app twice when another installed variant shares its display name", () => {
    const managedApp: AppRecord = {
      ...app,
      id: "app:managed",
      bundlePath: "/Applications/Managed.app",
      displayName: "Managed",
      bundleIdentifier: "com.example.managed"
    };
    const unmanagedVariant: AppRecord = {
      ...app,
      id: "app:managed-variant",
      bundlePath: "/Applications/Managed Variant.app",
      displayName: "Managed",
      bundleIdentifier: "com.example.managed.variant"
    };
    const installedCask: HomebrewManagedItem = {
      ...cask,
      id: "cask:managed",
      token: "managed",
      name: "Managed",
      latestVersion: version("1.0.0"),
      isOutdated: false,
      appID: managedApp.id
    };

    render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "installed",
          apps: [managedApp, unmanagedVariant],
          updates: [],
          homebrewItems: [installedCask],
          homebrewDiscoverItems: []
        })}
      />
    );

    const installedApps = screen.getByRole("button", { name: "Installed Apps" }).closest("section");
    const installedHomebrew = screen
      .getByRole("button", { name: "Installed Homebrew" })
      .closest("section");
    expect(installedApps).not.toBeNull();
    expect(installedHomebrew).not.toBeNull();
    expect(within(installedApps as HTMLElement).getAllByText("Managed")).toHaveLength(1);
    expect(within(installedHomebrew as HTMLElement).getByText("Managed")).toBeInTheDocument();
  });

  it("does not treat a non-app cask token as proof that an installed app is cask-backed", () => {
    const installedApp: AppRecord = {
      ...app,
      id: "app:managed",
      bundlePath: "/Applications/Managed.app",
      displayName: "Managed",
      bundleIdentifier: "com.example.managed"
    };
    const nonAppCask: HomebrewManagedItem = {
      ...cask,
      id: "cask:managed",
      token: "managed",
      name: "managed",
      latestVersion: version("1.0.0"),
      isOutdated: false,
      iconDataURL: undefined
    };

    render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "installed",
          apps: [installedApp],
          updates: [],
          homebrewItems: [nonAppCask],
          homebrewDiscoverItems: []
        })}
      />
    );

    const installedApps = screen.getByRole("button", { name: "Installed Apps" }).closest("section");
    const installedHomebrew = screen
      .getByRole("button", { name: "Installed Homebrew" })
      .closest("section");
    expect(installedApps).not.toBeNull();
    expect(installedHomebrew).not.toBeNull();
    expect(within(installedApps as HTMLElement).getByText("Managed")).toBeInTheDocument();
    expect(within(installedHomebrew as HTMLElement).getByText("managed")).toBeInTheDocument();
  });

  it("collapses persisted secondary sections and toggles them through preferences", () => {
    render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "installed",
          updates: [],
          homebrewItems: [],
          collapsedAppSectionIDs: ["installed"]
        })}
      />
    );

    const installedToggle = screen.getByRole("button", { name: "Installed Apps" });
    expect(installedToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("1.0.0 installed")).not.toBeInTheDocument();

    fireEvent.click(installedToggle);
    expect(window.baseline.updatePreferences).toHaveBeenCalledWith({
      collapsedAppSectionIDs: []
    });
  });

  it("rechecks update tools from settings without running a refresh", () => {
    const { rerender } = render(<SettingsView snapshot={snapshot()} />);

    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByText("Not detected")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Use the App Store helper when it is available. The mas helper is not detected on this Mac. Without mas, Baseline opens App Store links instead of installing App Store updates directly."
      )
    ).toBeInTheDocument();

    rerender(
      <SettingsView
        snapshot={snapshot({
          isMasInstalled: true,
          useMasForAppStoreUpdates: false
        })}
      />
    );
    expect(screen.getByText("Not used")).toBeInTheDocument();
    expect(screen.getByText("Use the App Store helper when it is available.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(window.baseline.refreshToolStatus).toHaveBeenCalledTimes(1);
    expect(window.baseline.refresh).not.toHaveBeenCalled();
  });

  it("keeps the mas preference checked but disabled until mas is detected", () => {
    const { rerender } = render(
      <SettingsView
        snapshot={snapshot({
          isMasInstalled: false,
          useMasForAppStoreUpdates: true
        })}
      />
    );

    const unavailableMasSwitch = screen.getByRole("switch", {
      name: "Use mas for App Store updates"
    });
    expect(unavailableMasSwitch).toBeChecked();
    expect(unavailableMasSwitch).toBeDisabled();

    fireEvent.click(unavailableMasSwitch);
    expect(window.baseline.updatePreferences).not.toHaveBeenCalled();

    rerender(
      <SettingsView
        snapshot={snapshot({
          isMasInstalled: true,
          useMasForAppStoreUpdates: true
        })}
      />
    );

    const availableMasSwitch = screen.getByRole("switch", {
      name: "Use mas for App Store updates"
    });
    expect(availableMasSwitch).toBeChecked();
    expect(availableMasSwitch).toBeEnabled();

    fireEvent.click(availableMasSwitch);
    expect(window.baseline.updatePreferences).toHaveBeenCalledWith({
      useMasForAppStoreUpdates: false
    });
  });

  it("edits refresh interval only when auto refresh is enabled", () => {
    const { rerender } = render(
      <SettingsView snapshot={snapshot({ autoRefreshEnabled: false })} />
    );

    const disabledInterval = screen.getByRole("textbox", { name: "Interval minutes" });
    expect(disabledInterval).toHaveAttribute("type", "text");
    expect(disabledInterval).toBeDisabled();

    rerender(<SettingsView snapshot={snapshot({ autoRefreshEnabled: true })} />);

    const enabledInterval = screen.getByRole("textbox", { name: "Interval minutes" });
    fireEvent.change(enabledInterval, { target: { value: "30" } });
    expect(window.baseline.updatePreferences).not.toHaveBeenCalledWith({
      refreshIntervalMinutes: 30
    });
    fireEvent.blur(enabledInterval);

    expect(window.baseline.updatePreferences).toHaveBeenCalledWith({
      refreshIntervalMinutes: 30
    });
  });

  it("lets refresh interval edits build multi-digit values before committing", () => {
    const { rerender } = render(
      <SettingsView snapshot={snapshot({ refreshIntervalMinutes: 60 })} />
    );

    const interval = screen.getByRole("textbox", { name: "Interval minutes" });
    fireEvent.change(interval, { target: { value: "" } });
    fireEvent.change(interval, { target: { value: "1" } });
    fireEvent.change(interval, { target: { value: "15" } });

    expect(interval).toHaveValue("15");
    expect(window.baseline.updatePreferences).not.toHaveBeenCalledWith({
      refreshIntervalMinutes: 5
    });
    expect(window.baseline.updatePreferences).not.toHaveBeenCalledWith({
      refreshIntervalMinutes: 15
    });

    fireEvent.keyDown(interval, { key: "Enter" });

    expect(window.baseline.updatePreferences).toHaveBeenCalledWith({
      refreshIntervalMinutes: 15
    });
    rerender(<SettingsView snapshot={snapshot({ refreshIntervalMinutes: 15 })} />);
    fireEvent.blur(interval);
    expect(window.baseline.updatePreferences).toHaveBeenCalledTimes(1);
  });

  it("shows default scan directories when custom directories are present", () => {
    const { rerender } = render(<SettingsView snapshot={snapshot()} />);

    expect(screen.getByText("Default Applications folders")).toBeInTheDocument();
    expect(
      screen.getByText("Baseline scans the system and user Applications folders automatically.")
    ).toBeInTheDocument();
    expect(screen.queryByText("/Applications")).not.toBeInTheDocument();

    rerender(
      <SettingsView
        snapshot={snapshot({
          additionalDirectories: ["/Users/test/Extra Apps"]
        })}
      />
    );

    expect(screen.getByText("System Applications")).toBeInTheDocument();
    expect(screen.getByText("User Applications")).toBeInTheDocument();
    expect(screen.getByText("/Applications")).toBeInTheDocument();
    expect(screen.getByText("/Users/test/Applications")).toBeInTheDocument();
    expect(screen.getByText("Custom folder")).toBeInTheDocument();
    expect(screen.getByText("/Users/test/Extra Apps")).toBeInTheDocument();
    expect(screen.getAllByTitle("Remove")).toHaveLength(1);
  });

  it("shows app version and build number in settings", async () => {
    render(<SettingsView snapshot={snapshot()} />);

    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(screen.getByText("Current version")).toBeInTheDocument();
    expect(await screen.findByText("0.1.0")).toBeInTheDocument();
    expect(screen.queryByText("0.1.0 (224)")).not.toBeInTheDocument();
    expect(screen.queryByText("Build number")).not.toBeInTheDocument();
    expect(screen.queryByText("224")).not.toBeInTheDocument();
    expect(screen.getByText("Diagnostic report")).toBeInTheDocument();
  });

  it("updates the appearance preference from settings", () => {
    render(<SettingsView snapshot={snapshot({ appearancePreference: "light" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(window.baseline.updatePreferences).toHaveBeenCalledWith({
      appearancePreference: "dark"
    });
  });

  it("updates the menu bar icon preference from settings", () => {
    render(<SettingsView snapshot={snapshot()} />);

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));

    const menuBarSwitch = screen.getByRole("switch", { name: "Show menu bar icon" });
    expect(menuBarSwitch).toHaveAttribute("type", "checkbox");

    fireEvent.click(menuBarSwitch);

    expect(window.baseline.updatePreferences).toHaveBeenCalledWith({
      showMenuBarIcon: false
    });
  });
});
