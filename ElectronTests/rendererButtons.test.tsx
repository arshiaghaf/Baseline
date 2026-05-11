import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionConfirmationContext,
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
    refreshToolStatus: vi.fn(),
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

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Ignore" })).toBeEnabled();
    const updateGlyph = screen.getByRole("button", { name: "Updating" });
    fireEvent.click(updateGlyph);
    expect(window.baseline.performAppUpdate).not.toHaveBeenCalled();
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

  it("clears toolbar search from compact and main layouts", () => {
    const { rerender } = render(
      <Dashboard
        compact
        onOpenSettings={() => undefined}
        snapshot={snapshot({ searchText: "obsidian" })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear Search" }));
    expect(window.baseline.setSearchText).toHaveBeenCalledWith("");

    rerender(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({ searchText: "notion" })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear Search" }));
    expect(window.baseline.setSearchText).toHaveBeenCalledWith("");
  });

  it("opens toolbar search and collapses it on outside click without clearing text", async () => {
    render(
      <Dashboard
        compact={false}
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
        compact={false}
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
  });

  it("renders compact menu bar as all updates without tabs or recent sections", () => {
    render(
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

  it("clears compact menu bar initial focus without blocking keyboard focus", async () => {
    const focusTarget = document.createElement("button");
    document.body.append(focusTarget);
    focusTarget.focus();

    render(
      <Dashboard
        compact
        onOpenSettings={() => undefined}
        snapshot={snapshot()}
      />
    );

    await waitFor(() => expect(document.activeElement).toBe(document.body));
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("tabindex", "-1");

    screen.getByRole("button", { name: "Open app" }).focus();
    expect(screen.getByRole("button", { name: "Open app" })).toHaveFocus();

    focusTarget.remove();
  });

  it("unifies app and Homebrew recently updated rows in the All tab", () => {
    const currentCask: HomebrewManagedItem = {
      ...cask,
      latestVersion: version("2.0.0"),
      isOutdated: false
    };

    render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "all",
          updates: [],
          homebrewItems: [currentCask],
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
              id: "recent:cask",
              itemID: currentCask.id,
              token: currentCask.token,
              kind: currentCask.kind,
              displayName: currentCask.name,
              fromVersion: version("1.0.0"),
              toVersion: version("2.0.0"),
              updatedAt: "2026-04-30T12:00:00.000Z"
            }
          ]
        })}
      />
    );

    expect(screen.getByRole("button", { name: "Recently Updated" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Recently Updated Apps" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Recently Updated Homebrew" })
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Example")).toHaveLength(2);
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

    expect(screen.getByText("Notion Notes")).toBeInTheDocument();
    expect(screen.getByText("notion-cli")).toBeInTheDocument();
    expect(screen.getByText("Notion Calendar")).toBeInTheDocument();
    expect(screen.queryByText("All your apps are up to date.")).not.toBeInTheDocument();
    expect(screen.queryByText("All your Homebrew items are up to date.")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent("Discover");
  });

  it("search hides cask-backed apps from Installed Apps", () => {
    const caskBackedApp: AppRecord = {
      ...app,
      id: "app:notion",
      displayName: "Notion"
    };
    const nonCaskApp: AppRecord = {
      ...app,
      id: "app:notion-notes",
      displayName: "Notion Notes"
    };
    const installedCask: HomebrewManagedItem = {
      ...cask,
      id: "cask:notion",
      token: "notion",
      name: "Notion",
      latestVersion: version("1.0.0"),
      isOutdated: false
    };

    render(
      <Dashboard
        compact={false}
        onOpenSettings={() => undefined}
        snapshot={snapshot({
          selectedTab: "apps",
          searchText: "notion",
          apps: [caskBackedApp, nonCaskApp],
          updates: [],
          homebrewItems: [installedCask],
          homebrewDiscoverItems: []
        })}
      />
    );

    const installedApps = screen
      .getByRole("heading", { name: "Installed Apps" })
      .closest("section");
    const installedHomebrew = screen
      .getByRole("heading", { name: "Installed Homebrew" })
      .closest("section");
    expect(installedApps).not.toBeNull();
    expect(installedHomebrew).not.toBeNull();
    expect(within(installedApps as HTMLElement).queryByText("Notion")).not.toBeInTheDocument();
    expect(within(installedApps as HTMLElement).getByText("Notion Notes")).toBeInTheDocument();
    expect(within(installedHomebrew as HTMLElement).getByText("Notion")).toBeInTheDocument();
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

  it("rechecks tool readiness from settings without running a refresh", () => {
    render(<SettingsView snapshot={snapshot()} />);

    fireEvent.click(screen.getByRole("button", { name: "Check Again" }));

    expect(window.baseline.refreshToolStatus).toHaveBeenCalledTimes(1);
    expect(window.baseline.refresh).not.toHaveBeenCalled();
  });
});
