import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionConfirmationContext,
  AppRow,
  Dashboard,
  DiscoverRow,
  HomebrewRow,
  HomebrewSection
} from "../src/renderer/main";
import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  UpdateRecord
} from "../src/shared/domain";
import { defaultPersistedSnapshot } from "../src/shared/domain";
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
    appUpdatingIDs: [],
    appUpdatedPendingRefreshIDs: [],
    homebrewUpdatingItemIDs: [],
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
    ...patch
  };
}

function installBaselineMock() {
  window.baseline = {
    getSnapshot: vi.fn(),
    getDiagnostics: vi.fn(),
    getToolStatus: vi.fn(),
    refresh: vi.fn(),
    setSearchText: vi.fn(),
    setSelectedTab: vi.fn(),
    updatePreferences: vi.fn(),
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

describe("renderer button parity", () => {
  beforeEach(() => {
    installBaselineMock();
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

    expect(screen.getByRole("button", { name: "Ignore" })).toBeEnabled();
    const updateGlyph = screen.getByRole("button", { name: "Updating" });
    fireEvent.click(updateGlyph);
    expect(window.baseline.performAppUpdate).not.toHaveBeenCalled();
  });

  it("orders row actions as update, ignore, uninstall", () => {
    const { container, rerender } = render(
      <AppRow app={app} snapshot={snapshot()} recentlyUpdated={false} />
    );
    expect(
      within(container.querySelector(".row-actions") as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent)
    ).toEqual(["Update", "Ignore", `Uninstall ${app.displayName}`]);

    rerender(<HomebrewRow item={cask} snapshot={snapshot()} />);
    expect(
      within(container.querySelector(".row-actions") as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent)
    ).toEqual(["Update", "Ignore", `Uninstall ${cask.name}`]);
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

    const discoverHeading = screen.getByText("Discover");
    const homebrewHeading = screen.getByText("Homebrew Updates");
    expect(
      discoverHeading.compareDocumentPosition(homebrewHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.queryByTitle("Collapse Discover")).not.toBeInTheDocument();
    expect(screen.getByText("obsidian-cli")).toBeInTheDocument();
    expect(screen.getByText("Obsidian")).toBeInTheDocument();
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

    expect(screen.getByRole("button", { name: `Uninstall ${cask.name}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ignore" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Updating" }));
    expect(window.baseline.performHomebrewUpdate).not.toHaveBeenCalled();
  });

  it("disables Homebrew ignore/update while uninstalling", () => {
    render(
      <HomebrewRow item={cask} snapshot={snapshot({ homebrewUninstallingItemIDs: [cask.id] })} />
    );

    expect(screen.getByRole("button", { name: `Uninstall ${cask.name}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ignore" })).toBeDisabled();
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

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    const dialog = screen.getByRole("dialog", { name: "Install Raycast?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Install Raycast" }));
    expect(window.baseline.installHomebrewItem).toHaveBeenCalledWith(item);
  });

  it("shows Update All only for sections with more than one outdated item", () => {
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
    expect(screen.queryByRole("button", { name: "Update All" })).not.toBeInTheDocument();

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
    expect(screen.getByRole("button", { name: "Update All" })).toBeInTheDocument();
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
    const { rerender } = render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={{ ...installedSnapshot, selectedTab: "all" }}
      />
    );

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
});
