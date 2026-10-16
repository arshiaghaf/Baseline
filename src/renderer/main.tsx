// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  AppWindowMac,
  ArrowLeft,
  Beer,
  CheckCircle2,
  Download,
  EyeOff,
  FolderPlus,
  Info,
  LockKeyhole,
  RefreshCcw,
  Search,
  Server,
  Settings,
  ShieldCogCorner,
  Terminal,
  X,
  XCircle
} from "lucide-react";
import type { AppMetadata } from "../shared/appMetadata";
import type {
  AppRecord,
  AppearancePreference,
  BaselineSnapshot,
  HomebrewManagedItem,
  MenuTab
} from "../shared/domain";
import { defaultPersistedSnapshot, applySnapshotProgress } from "../shared/domain";
import { homebrewItemMatchesApp } from "../shared/homebrewAppLinking";
import { operationFailureDescription, type OperationFailure } from "../shared/operationFailures";
import { operationIssueReport } from "../shared/operationReport";
import "./styles.css";
import type { Route, ActionConfirmation, SettingsSectionID, TogglePatch } from "./types";
import {
  deriveSections,
  type DerivedSections,
  combinedAvailableCount,
  uninstallableHomebrewItemForApp,
  compareRecentRows
} from "./helpers/sections";
import {
  clearCompactPopoverControlFocus,
  setElementInert,
  suppressCompactPopoverControlFocus,
  hasOpenNestedMenu,
  trapFocusWithin
} from "./helpers/focus";
import {
  toolbarIconStrokeWidth,
  sidebarIconStrokeWidth,
  settingsSidebarItems,
  primarySettingsSidebarItems,
  appearanceOptions
} from "./constants";
import {
  selectedTabTitle,
  homebrewReadyDetail,
  defaultScanDirectoryLabel,
  clampRefreshIntervalMinutes
} from "./helpers/labels";
import {
  ActionConfirmationContext,
  ActionConfirmationOverlay
} from "./components/ActionConfirmation";
import {
  DiscoverRow,
  AppRow,
  HomebrewRow,
  IgnoredAppCard,
  IgnoredHomebrewCard,
  AppUpdateCard,
  HomebrewUpdateCard,
  RecentAppCard,
  RecentHomebrewCard
} from "./components/ItemViews";
import { Empty, PanelTitle, UpdateActionButton } from "./components/CommonControls";
import { homebrewBatchActionState } from "./helpers/actionState";
import { performHomebrewUpdateAllForItems, toggleCollapsedSection } from "./helpers/actions";
import {
  buildProfileSummary,
  profileSourceShareLabel,
  profileSourceClass,
  profileSourceCountLabel,
  profileSourcePercentLabel
} from "./helpers/profile";

const initialSnapshot: BaselineSnapshot = {
  ...defaultPersistedSnapshot(),
  isMasInstalled: false,
  isHomebrewInstalled: false,
  isChecking: true,
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
  defaultScanDirectories: []
};

export function App() {
  const [snapshot, setSnapshot] = useState<BaselineSnapshot>(initialSnapshot);
  const [route, setRoute] = useState<Route>(currentRoute());
  const [searchActive, setSearchActive] = useState(false);
  const previousSearchTextRef = useRef(initialSnapshot.searchText);

  useEffect(() => {
    let current = initialSnapshot;
    let disposed = false;
    let resyncing = false;
    let resyncNeeded = false;
    const receiveSnapshot = (next: BaselineSnapshot) => {
      if (
        disposed ||
        (next.snapshotRevision !== undefined &&
          current.snapshotRevision !== undefined &&
          next.snapshotRevision < current.snapshotRevision)
      )
        return;
      current = next;
      setSnapshot(next);
    };
    const resync = () => {
      if (resyncing) {
        resyncNeeded = true;
        return;
      }
      resyncing = true;
      void window.baseline
        .getSnapshot()
        .then(receiveSnapshot)
        .catch(() => undefined)
        .finally(() => {
          resyncing = false;
          if (resyncNeeded && !disposed) {
            resyncNeeded = false;
            resync();
          }
        });
    };
    const unsubscribeSnapshot = window.baseline.onSnapshotChanged(receiveSnapshot);
    const unsubscribeProgress = window.baseline.onSnapshotProgress((event) => {
      const result = applySnapshotProgress(current, event);
      if (result.needsResync) {
        resync();
        return;
      }
      receiveSnapshot(result.snapshot);
    });
    resync();
    return () => {
      disposed = true;
      unsubscribeSnapshot();
      unsubscribeProgress();
    };
  }, []);

  useEffect(() => {
    const previousSearchText = previousSearchTextRef.current;
    previousSearchTextRef.current = snapshot.searchText;
    if (route === "menubar" && !previousSearchText.trim() && snapshot.searchText.trim()) {
      setSearchActive(true);
    }
  }, [route, snapshot.searchText]);

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (route === "settings") {
    return <SettingsView snapshot={snapshot} />;
  }

  return (
    <Dashboard
      snapshot={snapshot}
      compact={route === "menubar"}
      searchActive={searchActive}
      onSearchActiveChange={setSearchActive}
      onOpenSettings={() => {
        setSearchActive(false);
        void window.baseline.showSettings();
      }}
    />
  );
}

export function Dashboard({
  snapshot,
  compact,
  searchActive: controlledSearchActive,
  onSearchActiveChange,
  onOpenSettings
}: {
  snapshot: BaselineSnapshot;
  compact: boolean;
  searchActive?: boolean;
  onSearchActiveChange?: (active: boolean) => void;
  onOpenSettings: () => void;
}) {
  const selectedTab = snapshot.selectedTab;
  const [uncontrolledSearchActive, setUncontrolledSearchActive] = useState(
    compact && Boolean(snapshot.searchText)
  );
  const searchActive = controlledSearchActive ?? uncontrolledSearchActive;
  const setSearchActive = (active: boolean) => {
    if (onSearchActiveChange) {
      onSearchActiveChange(active);
      return;
    }
    setUncontrolledSearchActive(active);
  };
  const previousSearchTextRef = useRef(snapshot.searchText);
  const sectionInputs = useMemo(
    () => ({
      apps: snapshot.apps,
      updates: snapshot.updates,
      ignoredIDs: snapshot.ignoredIDs,
      recentlyUpdated: snapshot.recentlyUpdated,
      homebrewItems: snapshot.homebrewItems,
      ignoredHomebrewItemIDs: snapshot.ignoredHomebrewItemIDs,
      homebrewRecentlyUpdated: snapshot.homebrewRecentlyUpdated
    }),
    [
      snapshot.apps,
      snapshot.updates,
      snapshot.ignoredIDs,
      snapshot.recentlyUpdated,
      snapshot.homebrewItems,
      snapshot.ignoredHomebrewItemIDs,
      snapshot.homebrewRecentlyUpdated
    ]
  );
  const sidebarDerived = useMemo(
    () => deriveSections({ ...sectionInputs, searchText: "" }),
    [sectionInputs]
  );
  const searchDerived = useMemo(
    () =>
      searchActive && snapshot.searchText.trim()
        ? deriveSections({ ...sectionInputs, searchText: snapshot.searchText })
        : sidebarDerived,
    [sectionInputs, snapshot.searchText, searchActive, sidebarDerived]
  );
  const derived = compact && searchActive ? searchDerived : sidebarDerived;
  const [actionConfirmation, setActionConfirmation] = useState<ActionConfirmation>();
  const compactShellRef = useRef<HTMLElement>(null);
  const appContentRef = useRef<HTMLDivElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchPaletteReturnFocusRef = useRef<HTMLElement | null>(null);
  const shouldRestoreSearchPaletteFocusRef = useRef(false);

  const openSearchPalette = () => {
    const activeElement = document.activeElement;
    searchPaletteReturnFocusRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : searchButtonRef.current;
    setSearchActive(true);
  };
  const closeSearchPalette = () => {
    shouldRestoreSearchPaletteFocusRef.current = true;
    setSearchActive(false);
  };
  const toggleSearchPalette = () => {
    if (searchActive) {
      closeSearchPalette();
      return;
    }
    openSearchPalette();
  };

  useEffect(() => {
    if (!compact || controlledSearchActive !== undefined) {
      return;
    }
    const previousSearchText = previousSearchTextRef.current;
    previousSearchTextRef.current = snapshot.searchText;
    if (!previousSearchText.trim() && snapshot.searchText.trim()) {
      setSearchActive(true);
    }
  }, [compact, controlledSearchActive, snapshot.searchText]);

  useEffect(() => {
    if (!compact || searchActive) {
      return;
    }

    clearCompactPopoverControlFocus(document.activeElement, compactShellRef.current);
  }, [compact, searchActive]);

  useEffect(() => {
    if (compact) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (event.metaKey && (key === "f" || key === "k")) {
        event.preventDefault();
        if (!searchActive) {
          const activeElement = document.activeElement;
          searchPaletteReturnFocusRef.current =
            activeElement instanceof HTMLElement && activeElement !== document.body
              ? activeElement
              : searchButtonRef.current;
        }
        setSearchActive(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [compact, searchActive]);

  useEffect(() => {
    const appContent = appContentRef.current;
    if (!appContent || compact) {
      return undefined;
    }

    setElementInert(appContent, searchActive);
    return () => setElementInert(appContent, false);
  }, [compact, searchActive]);

  useEffect(() => {
    if (compact || searchActive || !shouldRestoreSearchPaletteFocusRef.current) {
      return;
    }

    shouldRestoreSearchPaletteFocusRef.current = false;
    const focusTarget = searchPaletteReturnFocusRef.current ?? searchButtonRef.current;
    searchPaletteReturnFocusRef.current = null;
    if (focusTarget?.isConnected) {
      focusTarget.focus();
    }
  }, [compact, searchActive]);

  const confirmAction = () => {
    if (!actionConfirmation) {
      return;
    }
    const confirmation = actionConfirmation;
    setActionConfirmation(undefined);
    if (confirmation.type === "install") {
      void window.baseline.installHomebrewItem(confirmation.item);
      return;
    }
    void window.baseline.uninstallHomebrewItem(confirmation.item.id);
  };
  const requestActionConfirmation = (confirmation: ActionConfirmation) => {
    setSearchActive(false);
    setActionConfirmation(confirmation);
  };

  let shell: React.ReactNode;
  if (compact) {
    shell = (
      <main
        ref={compactShellRef}
        className="app-shell compact"
        onFocusCapture={(event) =>
          clearCompactPopoverControlFocus(event.target, compactShellRef.current)
        }
        onMouseDownCapture={(event) =>
          suppressCompactPopoverControlFocus(event.target, compactShellRef.current, event)
        }
      >
        <header className="popover-titlebar">
          <div className="popover-title">
            <h1>Baseline</h1>
          </div>
          <div className="topbar-actions">
            <ToolbarSearch
              open={searchActive}
              snapshot={snapshot}
              onToggle={() => setSearchActive(!searchActive)}
              onClose={() => setSearchActive(false)}
              toolbarButtonTabIndex={-1}
            />
            <button
              className="toolbar-button refresh-button"
              onClick={() => void window.baseline.refresh(false)}
              title="Refresh"
              tabIndex={-1}
            >
              <RefreshCcw
                className={snapshot.isRefreshing ? "spin" : undefined}
                size={16}
                strokeWidth={toolbarIconStrokeWidth}
              />
            </button>
            <button
              className="toolbar-button"
              onClick={onOpenSettings}
              title="Settings"
              tabIndex={-1}
            >
              <Settings size={16} />
            </button>
          </div>
        </header>
        <OperationFailures snapshot={snapshot} />
        <section className="content single">
          <SelectedTabContent
            snapshot={snapshot}
            derived={derived}
            compact={compact}
            searchActive={searchActive}
          />
        </section>
      </main>
    );
  } else {
    const title = selectedTabTitle(selectedTab);
    shell = (
      <main className="app-shell">
        <Sidebar
          snapshot={snapshot}
          derived={sidebarDerived}
          route="main"
          searchButtonRef={searchButtonRef}
          onSelectSearch={() => {
            window.location.hash = "/main";
            toggleSearchPalette();
          }}
          onDismissSearch={() => setSearchActive(false)}
          onNavigate={() => setSearchActive(false)}
        />
        <section className="workspace">
          <header className="topbar">
            <div>
              <h1>{title}</h1>
            </div>
            <div className="topbar-actions">
              {snapshot.selfUpdate?.available && snapshot.selfUpdate.releaseURL ? (
                <SelfUpdateToolbarButton releaseURL={snapshot.selfUpdate.releaseURL} />
              ) : null}
              <button
                className="toolbar-button refresh-button"
                onClick={() => void window.baseline.refresh(false)}
                title="Refresh"
              >
                <RefreshCcw
                  className={snapshot.isRefreshing ? "spin" : undefined}
                  size={16}
                  strokeWidth={toolbarIconStrokeWidth}
                />
              </button>
            </div>
          </header>

          {snapshot.refreshErrorMessage && (
            <div className="notice danger">
              <AlertTriangle size={15} />
              <span>{snapshot.refreshErrorMessage}</span>
            </div>
          )}
          {snapshot.lastRefreshNoticeMessage && !snapshot.refreshErrorMessage && (
            <div className="notice">
              <AlertTriangle size={15} />
              <span>{snapshot.lastRefreshNoticeMessage}</span>
            </div>
          )}

          <section className="content">
            <OperationFailures snapshot={snapshot} />
            <SelectedTabContent
              snapshot={snapshot}
              derived={derived}
              compact={compact}
              searchActive={searchActive}
            />
          </section>
        </section>
      </main>
    );
  }

  return (
    <ActionConfirmationContext.Provider value={requestActionConfirmation}>
      <div
        className={actionConfirmation ? "action-surface action-surface-disabled" : "action-surface"}
        aria-hidden={actionConfirmation ? true : undefined}
      >
        <div
          ref={appContentRef}
          className="app-content-surface"
          aria-hidden={!compact && searchActive ? true : undefined}
        >
          {shell}
        </div>
        {!compact && searchActive && !actionConfirmation && (
          <SearchPalette snapshot={snapshot} derived={searchDerived} onClose={closeSearchPalette} />
        )}
      </div>
      {actionConfirmation && (
        <ActionConfirmationOverlay
          confirmation={actionConfirmation}
          onCancel={() => setActionConfirmation(undefined)}
          onConfirm={confirmAction}
        />
      )}
    </ActionConfirmationContext.Provider>
  );
}

function Sidebar({
  snapshot,
  derived,
  route,
  searchButtonRef,
  onSelectSearch,
  onDismissSearch,
  onNavigate
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
  route: "main" | "settings";
  searchButtonRef?: React.RefObject<HTMLButtonElement | null>;
  onSelectSearch?: () => void;
  onDismissSearch?: () => void;
  onNavigate?: () => void;
}) {
  const selectTab = (tab: MenuTab) => {
    onNavigate?.();
    window.location.hash = "/main";
    void window.baseline.setSelectedTab(tab);
  };
  const dismissSearchFromSidebarMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-search-toggle='true']")) {
      return;
    }
    onDismissSearch?.();
  };

  return (
    <aside className="sidebar" onMouseDownCapture={dismissSearchFromSidebarMouseDown}>
      <nav className="source-list">
        <button data-search-toggle="true" onClick={onSelectSearch} ref={searchButtonRef}>
          <Search size={16} strokeWidth={sidebarIconStrokeWidth} />
          <span>Search</span>
        </button>
      </nav>
      <nav className="source-list">
        <button
          className={route === "main" && snapshot.selectedTab === "all" ? "selected" : ""}
          onClick={() => selectTab("all")}
        >
          <Server size={16} strokeWidth={sidebarIconStrokeWidth} />
          <span>All</span>
          <SidebarBadge count={combinedAvailableCount(derived)} />
        </button>
        <button
          className={route === "main" && snapshot.selectedTab === "apps" ? "selected" : ""}
          onClick={() => selectTab("apps")}
        >
          <AppWindowMac size={16} strokeWidth={sidebarIconStrokeWidth} />
          <span>Apps</span>
          <SidebarBadge count={derived.availableApps.length} />
        </button>
        <button
          className={route === "main" && snapshot.selectedTab === "homebrew" ? "selected" : ""}
          onClick={() => selectTab("homebrew")}
        >
          <Beer size={16} strokeWidth={sidebarIconStrokeWidth} />
          <span>Homebrew</span>
          <SidebarBadge count={derived.allHomebrewOutdated.length} />
        </button>
      </nav>
      <nav className="source-list">
        <button
          className={route === "main" && snapshot.selectedTab === "installed" ? "selected" : ""}
          onClick={() => selectTab("installed")}
        >
          <CheckCircle2 size={16} strokeWidth={sidebarIconStrokeWidth} />
          <span>Installed</span>
        </button>
        <button
          className={route === "main" && snapshot.selectedTab === "ignored" ? "selected" : ""}
          onClick={() => selectTab("ignored")}
        >
          <EyeOff size={16} strokeWidth={sidebarIconStrokeWidth} />
          <span>Ignored</span>
        </button>
      </nav>
      <div className="sidebar-footer">
        <button
          className={route === "settings" ? "selected" : ""}
          onClick={() => {
            onNavigate?.();
            void window.baseline.showSettings();
          }}
        >
          <Settings size={16} strokeWidth={sidebarIconStrokeWidth} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

function SidebarBadge({ count }: { count: number }) {
  return count > 0 ? <strong>{count}</strong> : null;
}

function SelfUpdateToolbarButton({ releaseURL }: { releaseURL: string }) {
  return (
    <button
      className="toolbar-button self-update-toolbar-button"
      onClick={() => void window.baseline.openExternal(releaseURL)}
      title="New Baseline Update Available"
      aria-label="New Baseline Update Available"
    >
      <Download size={16} strokeWidth={2} />
    </button>
  );
}

function ToolbarSearch({
  open,
  snapshot,
  onToggle,
  onClose,
  toolbarButtonTabIndex
}: {
  open: boolean;
  snapshot: BaselineSnapshot;
  onToggle: () => void;
  onClose: () => void;
  toolbarButtonTabIndex?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        window.setTimeout(onClose, 0);
      }
    };

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [onClose, open]);

  const clearSearch = () => {
    void window.baseline.setSearchText("");
    inputRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={open ? "toolbar-search open" : "toolbar-search"}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="toolbar-search-field">
        <input
          ref={inputRef}
          value={snapshot.searchText}
          onChange={(event) => void window.baseline.setSearchText(event.currentTarget.value)}
          placeholder="Search"
          tabIndex={open ? 0 : -1}
          aria-hidden={!open}
        />
        {snapshot.searchText ? (
          <button
            className="search-clear-button"
            onClick={clearSearch}
            onMouseDown={(event) => event.preventDefault()}
            title="Clear Search"
            aria-label="Clear Search"
            tabIndex={open ? 0 : -1}
          >
            <X size={12} />
          </button>
        ) : null}
      </div>
      <button
        className="toolbar-button"
        onClick={onToggle}
        title={open ? "Close Search" : "Search"}
        tabIndex={toolbarButtonTabIndex}
      >
        <Search size={16} strokeWidth={toolbarIconStrokeWidth} />
      </button>
    </div>
  );
}

function SelectedTabContent({
  snapshot,
  derived,
  compact,
  searchActive
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
  compact: boolean;
  searchActive: boolean;
}) {
  if (compact && searchActive && snapshot.searchText.trim()) {
    return <SearchResults snapshot={snapshot} derived={derived} />;
  }
  if (!compact && snapshot.selectedTab === "ignored") {
    return <IgnoredTab snapshot={snapshot} derived={derived} compact={compact} />;
  }
  if (compact) {
    return <AllTab snapshot={snapshot} derived={derived} compact />;
  }
  if (snapshot.selectedTab === "all") {
    return <AllTab snapshot={snapshot} derived={derived} />;
  }
  if (snapshot.selectedTab === "apps") {
    return <AppsTab snapshot={snapshot} derived={derived} />;
  }
  if (snapshot.selectedTab === "homebrew") {
    return <HomebrewTab snapshot={snapshot} derived={derived} />;
  }
  return <InstalledTab snapshot={snapshot} derived={derived} compact={compact} />;
}

function SearchPalette({
  snapshot,
  derived,
  onClose
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const handleDialogKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      if (hasOpenNestedMenu(dialogRef.current)) {
        return;
      }
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      trapFocusWithin(event.nativeEvent, dialogRef.current);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (hasOpenNestedMenu(dialogRef.current)) {
          return;
        }
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        trapFocusWithin(event, dialogRef.current);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  return (
    <div className="search-palette-layer">
      <div className="search-palette-backdrop" aria-hidden="true" onMouseDown={() => onClose()} />
      <div
        className="search-palette-workspace"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            onClose();
          }
        }}
      >
        <section
          ref={dialogRef}
          className="search-palette"
          role="dialog"
          aria-modal="true"
          aria-label="Search"
          tabIndex={-1}
          onKeyDownCapture={handleDialogKeyDown}
        >
          <SearchField snapshot={snapshot} autoFocus />
          {snapshot.searchText.trim() ? (
            <SearchPaletteResults snapshot={snapshot} derived={derived} />
          ) : (
            <p className="search-palette-empty">Search Homebrew for apps, packages, and tools.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function SearchField({
  snapshot,
  autoFocus = false
}: {
  snapshot: BaselineSnapshot;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!autoFocus) {
      return;
    }
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    const caretPosition = input.value.length;
    input.setSelectionRange(caretPosition, caretPosition);
  }, [autoFocus]);

  const clearSearch = () => {
    void window.baseline.setSearchText("");
    inputRef.current?.focus();
  };

  return (
    <div className="search-box search-palette-field">
      <Search size={15} strokeWidth={toolbarIconStrokeWidth} />
      <input
        ref={inputRef}
        value={snapshot.searchText}
        onChange={(event) => void window.baseline.setSearchText(event.currentTarget.value)}
        placeholder="Search"
      />
      {snapshot.searchText ? (
        <button
          className="search-clear-button"
          onClick={clearSearch}
          onMouseDown={(event) => event.preventDefault()}
          title="Clear Search"
          aria-label="Clear Search"
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

function SearchPaletteResults({
  snapshot,
  derived
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
}) {
  const searchInstalledApps = derived.installedApps.filter(
    (app) => !uninstallableHomebrewItemForApp(app, snapshot)
  );
  const hasResults =
    snapshot.homebrewDiscoverItems.length > 0 ||
    derived.availableApps.length > 0 ||
    derived.allHomebrewOutdated.length > 0 ||
    searchInstalledApps.length > 0 ||
    derived.homebrewInstalled.length > 0 ||
    derived.ignoredApps.length > 0 ||
    derived.homebrewIgnored.length > 0;

  if (!hasResults) {
    return <p className="search-palette-empty">No matches found.</p>;
  }

  return (
    <div className="search-palette-results">
      {snapshot.homebrewDiscoverItems.length > 0 && (
        <SearchPaletteSection title="Discover">
          {snapshot.homebrewDiscoverItems.map((item) => (
            <DiscoverRow key={item.id} item={item} snapshot={snapshot} />
          ))}
        </SearchPaletteSection>
      )}
      {derived.availableApps.length > 0 && (
        <SearchPaletteSection title="App Updates">
          {derived.availableApps.map((app) => (
            <AppRow key={app.id} app={app} snapshot={snapshot} recentlyUpdated={false} />
          ))}
        </SearchPaletteSection>
      )}
      {derived.allHomebrewOutdated.length > 0 && (
        <SearchPaletteSection title="Homebrew Updates">
          {derived.allHomebrewOutdated.map((item) => (
            <HomebrewRow key={item.id} item={item} snapshot={snapshot} />
          ))}
        </SearchPaletteSection>
      )}
      {searchInstalledApps.length > 0 && (
        <SearchPaletteSection title="Installed Apps">
          {searchInstalledApps.map((app) => (
            <AppRow key={app.id} app={app} snapshot={snapshot} recentlyUpdated={false} />
          ))}
        </SearchPaletteSection>
      )}
      {derived.homebrewInstalled.length > 0 && (
        <SearchPaletteSection title="Installed Homebrew">
          {derived.homebrewInstalled.map((item) => (
            <HomebrewRow key={item.id} item={item} snapshot={snapshot} />
          ))}
        </SearchPaletteSection>
      )}
      {derived.ignoredApps.length > 0 && (
        <SearchPaletteSection title="Ignored Apps">
          {derived.ignoredApps.map((app) => (
            <AppRow key={app.id} app={app} snapshot={snapshot} recentlyUpdated={false} />
          ))}
        </SearchPaletteSection>
      )}
      {derived.homebrewIgnored.length > 0 && (
        <SearchPaletteSection title="Ignored Homebrew">
          {derived.homebrewIgnored.map((item) => (
            <HomebrewRow key={item.id} item={item} snapshot={snapshot} />
          ))}
        </SearchPaletteSection>
      )}
    </div>
  );
}

function SearchPaletteSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="search-palette-section">
      <h2>{title}</h2>
      <div className="rows">{children}</div>
    </section>
  );
}

function SearchResults({
  snapshot,
  derived
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
}) {
  const searchInstalledApps = derived.installedApps.filter(
    (app) => !uninstallableHomebrewItemForApp(app, snapshot)
  );
  const hasResults =
    snapshot.homebrewDiscoverItems.length > 0 ||
    derived.availableApps.length > 0 ||
    derived.allHomebrewOutdated.length > 0 ||
    searchInstalledApps.length > 0 ||
    derived.homebrewInstalled.length > 0 ||
    derived.ignoredApps.length > 0 ||
    derived.homebrewIgnored.length > 0;

  return (
    <div className="stack">
      {snapshot.homebrewDiscoverItems.length > 0 && <DiscoverSection snapshot={snapshot} />}
      {derived.availableApps.length > 0 && (
        <AppSection
          sectionID="available"
          title="App Updates"
          apps={derived.availableApps}
          snapshot={snapshot}
          empty="All your apps are up to date."
          cardLayout
        />
      )}
      {derived.allHomebrewOutdated.length > 0 && (
        <HomebrewSection
          sectionID="outdated"
          title="Homebrew Updates"
          items={derived.allHomebrewOutdated}
          snapshot={snapshot}
          empty="All your Homebrew items are up to date."
          showUpdateAll
          cardLayout
        />
      )}
      {searchInstalledApps.length > 0 && (
        <AppSection
          sectionID="installed"
          title="Installed Apps"
          apps={searchInstalledApps}
          snapshot={snapshot}
          empty="No installed apps found."
          cardLayout
        />
      )}
      {derived.homebrewInstalled.length > 0 && (
        <HomebrewSection
          sectionID="installed"
          title="Installed Homebrew"
          items={derived.homebrewInstalled}
          snapshot={snapshot}
          empty="No installed Homebrew items found."
          cardLayout
        />
      )}
      {(derived.ignoredApps.length > 0 || derived.homebrewIgnored.length > 0) && (
        <SearchIgnoredSection snapshot={snapshot} derived={derived} />
      )}
      {!hasResults && <Empty text="No matches found." />}
    </div>
  );
}

function SearchIgnoredSection({
  snapshot,
  derived
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
}) {
  const items: IgnoredGridItem[] = [
    ...derived.ignoredApps.map((app) => ({
      type: "app" as const,
      id: app.id,
      item: app
    })),
    ...derived.homebrewIgnored.map((item) => ({
      type: "homebrew" as const,
      id: item.id,
      item
    }))
  ];

  return (
    <section className="panel">
      <PanelTitle title="Ignored" />
      <CardGrid sectionClassName="ignored-grid">
        {items.map((item) =>
          item.type === "app" ? (
            <IgnoredAppCard key={`app:${item.id}`} app={item.item} snapshot={snapshot} />
          ) : (
            <IgnoredHomebrewCard key={`homebrew:${item.id}`} item={item.item} snapshot={snapshot} />
          )
        )}
      </CardGrid>
    </section>
  );
}

function AllTab({
  snapshot,
  derived,
  compact = false
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="stack">
        <AppSection
          sectionID="available"
          title={`App Updates (${derived.availableApps.length})`}
          apps={derived.availableApps}
          snapshot={snapshot}
          empty="All your apps are up to date."
        />
        <HomebrewSection
          sectionID="outdated"
          title={`Homebrew Updates (${derived.allHomebrewOutdated.length})`}
          items={derived.allHomebrewOutdated}
          snapshot={snapshot}
          empty="All your Homebrew items are up to date."
          showUpdateAll
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <AllUpdatesSection snapshot={snapshot} derived={derived} />
      <AllRecentlyUpdatedSection snapshot={snapshot} derived={derived} />
    </div>
  );
}

function AllUpdatesSection({
  snapshot,
  derived
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
}) {
  const items: RecentGridItem[] = [
    ...derived.availableApps.map((app) => ({
      type: "app" as const,
      id: app.id,
      updatedAt: "",
      item: app
    })),
    ...derived.allHomebrewOutdated.map((item) => ({
      type: "homebrew" as const,
      id: item.id,
      updatedAt: "",
      item
    }))
  ];

  return (
    <section className="panel">
      <PanelTitle
        title={`Updates (${combinedAvailableCount(derived)})`}
        action={
          derived.allHomebrewOutdated.length > 1 ? (
            <UpdateActionButton
              state={homebrewBatchActionState(derived.allHomebrewOutdated, snapshot)}
              readyLabel="Update Brews"
              readyVariant="outline"
              onAction={() => performHomebrewUpdateAllForItems(derived.allHomebrewOutdated)}
            />
          ) : undefined
        }
      />
      {items.length === 0 ? (
        <Empty text="All your apps and Homebrew items are up to date." />
      ) : (
        <CardGrid sectionClassName="update-grid">
          {items.map((item) =>
            item.type === "app" ? (
              <AppUpdateCard key={`app:${item.id}`} app={item.item} snapshot={snapshot} />
            ) : (
              <HomebrewUpdateCard
                key={`homebrew:${item.id}`}
                item={item.item}
                snapshot={snapshot}
              />
            )
          )}
        </CardGrid>
      )}
    </section>
  );
}

function AllRecentlyUpdatedSection({
  snapshot,
  derived
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
}) {
  const appUpdatedAt = new Map(
    snapshot.recentlyUpdated.map((record) => [record.appID, record.updatedAt])
  );
  const homebrewUpdatedAt = new Map(
    snapshot.homebrewRecentlyUpdated.map((record) => [record.itemID, record.updatedAt])
  );
  const recentlyUpdatedApps = derived.recentlyUpdatedApps;
  const homebrewRecentlyUpdated = derived.homebrewRecentlyUpdated.filter(
    (item) => !homebrewItemMatchesApp(item, recentlyUpdatedApps)
  );
  const rows: RecentGridItem[] = [
    ...recentlyUpdatedApps.map((app) => ({
      type: "app" as const,
      id: app.id,
      updatedAt: appUpdatedAt.get(app.id) ?? "",
      item: app
    })),
    ...homebrewRecentlyUpdated.map((item) => ({
      type: "homebrew" as const,
      id: item.id,
      updatedAt: homebrewUpdatedAt.get(item.id) ?? "",
      item
    }))
  ].sort((lhs, rhs) => compareRecentRows(lhs, rhs));

  const collapsed = snapshot.collapsedAppSectionIDs.includes("recentlyUpdated");

  return (
    <section className="panel">
      <PanelTitle
        title="Recently Updated"
        collapsed={collapsed}
        canCollapse
        onToggleCollapse={() => toggleCollapsedSection("app", "recentlyUpdated", snapshot)}
      />
      {!collapsed &&
        (rows.length === 0 ? (
          <Empty text="No recently updated items yet." />
        ) : (
          <RecentGrid items={rows} snapshot={snapshot} homebrewAppCaskLabel="Homebrew" />
        ))}
    </section>
  );
}

function AppsTab({ snapshot, derived }: { snapshot: BaselineSnapshot; derived: DerivedSections }) {
  return (
    <div className="stack">
      <AppSection
        sectionID="available"
        title={`Available (${derived.availableApps.length})`}
        apps={derived.availableApps}
        snapshot={snapshot}
        empty="All your apps are up to date."
        cardLayout
      />
      <RecentlyUpdatedAppSection
        sectionID="recentlyUpdated"
        title="Recently Updated"
        apps={derived.recentlyUpdatedApps}
        snapshot={snapshot}
        empty="No recently updated apps yet."
      />
      <IgnoredAppSection
        sectionID="ignored"
        title={`Ignored (${derived.ignoredApps.length})`}
        apps={derived.ignoredApps}
        snapshot={snapshot}
        empty="No ignored apps."
      />
    </div>
  );
}

function AppSection({
  sectionID,
  title,
  apps,
  snapshot,
  empty,
  recentlyUpdated = false,
  collapsible = false,
  cardLayout = false
}: {
  sectionID: string;
  title: string;
  apps: AppRecord[];
  snapshot: BaselineSnapshot;
  empty: string;
  recentlyUpdated?: boolean;
  collapsible?: boolean;
  cardLayout?: boolean;
}) {
  const collapsed = collapsible && snapshot.collapsedAppSectionIDs.includes(sectionID);
  return (
    <section className="panel">
      <PanelTitle
        title={title}
        collapsed={collapsed}
        canCollapse={collapsible}
        onToggleCollapse={() => toggleCollapsedSection("app", sectionID, snapshot)}
      />
      {!collapsed &&
        (apps.length === 0 ? (
          <Empty text={empty} />
        ) : cardLayout ? (
          <CardGrid sectionClassName="update-grid">
            {apps.map((app) => (
              <AppUpdateCard key={app.id} app={app} snapshot={snapshot} />
            ))}
          </CardGrid>
        ) : (
          <div className="rows">
            {apps.map((app) => (
              <AppRow
                key={app.id}
                app={app}
                snapshot={snapshot}
                recentlyUpdated={recentlyUpdated}
              />
            ))}
          </div>
        ))}
    </section>
  );
}

function RecentlyUpdatedAppSection({
  sectionID,
  title,
  apps,
  snapshot,
  empty
}: {
  sectionID: string;
  title: string;
  apps: AppRecord[];
  snapshot: BaselineSnapshot;
  empty: string;
}) {
  const collapsed = snapshot.collapsedAppSectionIDs.includes(sectionID);
  const items: RecentGridItem[] = apps.map((app) => ({
    type: "app",
    id: app.id,
    updatedAt: snapshot.recentlyUpdated.find((record) => record.appID === app.id)?.updatedAt ?? "",
    item: app
  }));

  return (
    <section className="panel">
      <PanelTitle
        title={title}
        collapsed={collapsed}
        canCollapse
        onToggleCollapse={() => toggleCollapsedSection("app", sectionID, snapshot)}
      />
      {!collapsed &&
        (items.length === 0 ? (
          <Empty text={empty} />
        ) : (
          <RecentGrid items={items} snapshot={snapshot} />
        ))}
    </section>
  );
}

function IgnoredAppSection({
  sectionID,
  title,
  apps,
  snapshot,
  empty
}: {
  sectionID: string;
  title: string;
  apps: AppRecord[];
  snapshot: BaselineSnapshot;
  empty: string;
}) {
  const collapsed = snapshot.collapsedAppSectionIDs.includes(sectionID);

  return (
    <section className="panel">
      <PanelTitle
        title={title}
        collapsed={collapsed}
        canCollapse
        onToggleCollapse={() => toggleCollapsedSection("app", sectionID, snapshot)}
      />
      {!collapsed &&
        (apps.length === 0 ? (
          <Empty text={empty} />
        ) : (
          <CardGrid sectionClassName="ignored-grid">
            {apps.map((app) => (
              <IgnoredAppCard key={app.id} app={app} snapshot={snapshot} />
            ))}
          </CardGrid>
        ))}
    </section>
  );
}

type RecentGridItem =
  | {
      type: "app";
      id: string;
      updatedAt: string;
      item: AppRecord;
    }
  | {
      type: "homebrew";
      id: string;
      updatedAt: string;
      item: HomebrewManagedItem;
    };

type IgnoredGridItem =
  | {
      type: "app";
      id: string;
      item: AppRecord;
    }
  | {
      type: "homebrew";
      id: string;
      item: HomebrewManagedItem;
    };

function RecentGrid({
  items,
  snapshot,
  homebrewAppCaskLabel
}: {
  items: RecentGridItem[];
  snapshot: BaselineSnapshot;
  homebrewAppCaskLabel?: string;
}) {
  return (
    <CardGrid sectionClassName="recent-grid">
      {items.map((item) =>
        item.type === "app" ? (
          <RecentAppCard key={`app:${item.id}`} app={item.item} snapshot={snapshot} />
        ) : (
          <RecentHomebrewCard
            key={`homebrew:${item.id}`}
            item={item.item}
            snapshot={snapshot}
            appCaskLabel={homebrewAppCaskLabel}
          />
        )
      )}
    </CardGrid>
  );
}

function CardGrid({
  children,
  sectionClassName
}: {
  children: React.ReactNode;
  sectionClassName: string;
}) {
  return <div className={`card-grid ${sectionClassName}`}>{children}</div>;
}

export function OperationFailures({ snapshot }: { snapshot: BaselineSnapshot }) {
  if (!snapshot.operationFailures?.length) return null;
  return (
    <section className="operation-failures" aria-label="Operation failures">
      {snapshot.operationFailures.map((failure) => {
        const name =
          snapshot.apps.find((app) => app.id === failure.entityID)?.displayName ??
          snapshot.homebrewItems.find((item) => item.id === failure.entityID)?.name ??
          snapshot.homebrewDiscoverItems.find((item) => item.id === failure.entityID)
            ?.displayName ??
          (failure.entityID === "homebrew:maintenance" ? "Homebrew maintenance" : "This item");
        const details = snapshot.operationFailureDetails?.[failure.id];
        return (
          <OperationFailureRow
            key={`${failure.id}:${details?.attemptID ?? failure.occurredAt}`}
            failure={failure}
            name={name}
            attemptID={details?.attemptID ?? failure.occurredAt}
            outputTail={details?.outputTail}
          />
        );
      })}
    </section>
  );
}

function OperationFailureRow({
  failure,
  name,
  attemptID,
  outputTail
}: {
  failure: OperationFailure;
  name: string;
  attemptID: string;
  outputTail?: string;
}) {
  const [report, setReport] = useState<ReturnType<typeof operationIssueReport>>();
  const [copyMessage, setCopyMessage] = useState("");
  return (
    <details className="operation-failure">
      <summary>
        {name}: {failure.operation} did not complete{" "}
        <span className="failure-disclosure-label">Show details</span>
      </summary>
      <div className="operation-failure-content">
        <p>{operationFailureDescription(failure)}</p>
        <time dateTime={failure.occurredAt}>{new Date(failure.occurredAt).toLocaleString()}</time>
        <pre className="operation-output" tabIndex={0} aria-label="Command output">
          {outputTail || "No command output is available for this attempt."}
        </pre>
        <p>
          Output is shortened and redacted on a best-effort basis. Check for private information
          before sharing.
        </p>
        <div className="operation-failure-actions">
          <button
            type="button"
            onClick={() => {
              void window.baseline.copyOperationFailure(failure.id, attemptID).then(
                (copied) => setCopyMessage(copied ? "Copied" : "Details are no longer available"),
                () => setCopyMessage("Could not copy details")
              );
            }}
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => setReport(operationIssueReport(failure, outputTail))}
          >
            Report issue
          </button>
          <button
            type="button"
            onClick={() => void window.baseline.dismissOperationFailure(failure.id)}
            aria-label={`Dismiss failure for ${name}`}
          >
            Dismiss
          </button>
          <span role="status">{copyMessage}</span>
        </div>
      </div>
      {report && <OperationReportPreview report={report} onClose={() => setReport(undefined)} />}
    </details>
  );
}

function OperationReportPreview({
  report,
  onClose
}: {
  report: ReturnType<typeof operationIssueReport>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [openError, setOpenError] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === "Tab") trapFocusWithin(event, dialogRef.current);
    };
    window.addEventListener("keydown", handleKey, true);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div
      className="confirmation-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="confirmation-card operation-report-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operation-report-title"
        aria-describedby="operation-report-warning"
      >
        <h2 id="operation-report-title">Report issue</h2>
        <p id="operation-report-warning">
          Check this text for private information. Redaction is best effort. Nothing is sent until
          you choose Open on GitHub. GitHub opens a bug report form for you to review and submit.
        </p>
        <pre className="operation-output" tabIndex={0} aria-label="Report text">
          {report.text}
        </pre>
        {openError && (
          <p role="alert">Could not open GitHub. You can cancel and copy the details instead.</p>
        )}
        <div className="confirmation-actions">
          <button type="button" className="ghost-button" ref={cancelRef} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              void window.baseline.openExternal(report.url).then(
                (opened) => {
                  if (opened) onClose();
                  else setOpenError(true);
                },
                () => setOpenError(true)
              );
            }}
          >
            Open on GitHub
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

function HomebrewTab({
  snapshot,
  derived
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
}) {
  return (
    <div className="stack">
      <HomebrewSection
        sectionID="outdated"
        title={`Outdated (${derived.allHomebrewOutdated.length})`}
        items={derived.allHomebrewOutdated}
        snapshot={snapshot}
        empty="All your Homebrew items are up to date."
        showUpdateAll
        cardLayout
      />
      <RecentlyUpdatedHomebrewSection
        sectionID="recentlyUpdated"
        title="Recently Updated"
        items={derived.homebrewRecentlyUpdated}
        snapshot={snapshot}
        empty="No recently updated Homebrew items yet."
      />
      <IgnoredHomebrewSection
        sectionID="ignored"
        title={`Ignored (${derived.homebrewIgnored.length})`}
        items={derived.homebrewIgnored}
        snapshot={snapshot}
        empty="No ignored Homebrew items."
      />
    </div>
  );
}

function InstalledTab({
  snapshot,
  derived,
  compact
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
  compact: boolean;
}) {
  return (
    <div className="stack">
      {!compact && (
        <AppSection
          sectionID="installed"
          collapsible
          title="Installed Apps"
          apps={derived.installedApps}
          snapshot={snapshot}
          empty="No installed apps found."
          cardLayout
        />
      )}
      {!compact && (
        <HomebrewSection
          sectionID="installed"
          collapsible
          title="Installed Homebrew"
          items={derived.homebrewInstalled}
          snapshot={snapshot}
          empty="No installed Homebrew items found."
          cardLayout
        />
      )}
      {compact && <Empty text="Open Baseline to view installed items." />}
    </div>
  );
}

function IgnoredTab({
  snapshot,
  derived,
  compact
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
  compact: boolean;
}) {
  if (compact) {
    return <Empty text="Open Baseline to view ignored items." />;
  }

  const items: IgnoredGridItem[] = [
    ...derived.ignoredApps.map((app) => ({
      type: "app" as const,
      id: app.id,
      item: app
    })),
    ...derived.homebrewIgnored.map((item) => ({
      type: "homebrew" as const,
      id: item.id,
      item
    }))
  ];

  return (
    <section className="panel">
      <PanelTitle title={`Ignored Apps and Homebrew (${items.length})`} />
      {items.length === 0 ? (
        <Empty text="No ignored apps or Homebrew items." />
      ) : (
        <CardGrid sectionClassName="ignored-grid">
          {items.map((item) =>
            item.type === "app" ? (
              <IgnoredAppCard key={`app:${item.id}`} app={item.item} snapshot={snapshot} />
            ) : (
              <IgnoredHomebrewCard
                key={`homebrew:${item.id}`}
                item={item.item}
                snapshot={snapshot}
              />
            )
          )}
        </CardGrid>
      )}
    </section>
  );
}

function DiscoverSection({ snapshot }: { snapshot: BaselineSnapshot }) {
  return (
    <section className="panel">
      <PanelTitle title={`Discover (${snapshot.homebrewDiscoverItems.length})`} />
      {snapshot.homebrewDiscoverItems.length === 0 ? (
        <Empty text="No installable Homebrew matches found." />
      ) : (
        <div className="rows">
          {snapshot.homebrewDiscoverItems.map((item) => (
            <DiscoverRow key={item.id} item={item} snapshot={snapshot} />
          ))}
        </div>
      )}
    </section>
  );
}

export function HomebrewSection({
  sectionID,
  title,
  items,
  snapshot,
  empty,
  showUpdateAll = false,
  collapsible = false,
  recentlyUpdated = false,
  cardLayout = false
}: {
  sectionID: string;
  title: string;
  items: HomebrewManagedItem[];
  snapshot: BaselineSnapshot;
  empty: string;
  showUpdateAll?: boolean;
  collapsible?: boolean;
  recentlyUpdated?: boolean;
  cardLayout?: boolean;
}) {
  const collapsed = collapsible && snapshot.collapsedHomebrewSectionIDs.includes(sectionID);
  return (
    <section className="panel">
      <PanelTitle
        title={title}
        collapsed={collapsed}
        canCollapse={collapsible}
        onToggleCollapse={() => toggleCollapsedSection("homebrew", sectionID, snapshot)}
        action={
          showUpdateAll && items.length > 1 ? (
            <UpdateActionButton
              state={homebrewBatchActionState(items, snapshot)}
              readyLabel="Update Brews"
              readyVariant="outline"
              onAction={() => performHomebrewUpdateAllForItems(items)}
            />
          ) : undefined
        }
      />
      {!collapsed &&
        (items.length === 0 ? (
          <Empty text={empty} />
        ) : cardLayout ? (
          <CardGrid sectionClassName="update-grid">
            {items.map((item) => (
              <HomebrewUpdateCard key={item.id} item={item} snapshot={snapshot} />
            ))}
          </CardGrid>
        ) : (
          <div className="rows">
            {items.map((item) => (
              <HomebrewRow
                key={item.id}
                item={item}
                snapshot={snapshot}
                recentlyUpdated={recentlyUpdated}
              />
            ))}
          </div>
        ))}
    </section>
  );
}

function RecentlyUpdatedHomebrewSection({
  sectionID,
  title,
  items,
  snapshot,
  empty
}: {
  sectionID: string;
  title: string;
  items: HomebrewManagedItem[];
  snapshot: BaselineSnapshot;
  empty: string;
}) {
  const collapsed = snapshot.collapsedHomebrewSectionIDs.includes(sectionID);
  const gridItems: RecentGridItem[] = items.map((item) => ({
    type: "homebrew",
    id: item.id,
    updatedAt:
      snapshot.homebrewRecentlyUpdated.find((record) => record.itemID === item.id)?.updatedAt ?? "",
    item
  }));

  return (
    <section className="panel">
      <PanelTitle
        title={title}
        collapsed={collapsed}
        canCollapse
        onToggleCollapse={() => toggleCollapsedSection("homebrew", sectionID, snapshot)}
      />
      {!collapsed &&
        (gridItems.length === 0 ? (
          <Empty text={empty} />
        ) : (
          <RecentGrid items={gridItems} snapshot={snapshot} />
        ))}
    </section>
  );
}

function IgnoredHomebrewSection({
  sectionID,
  title,
  items,
  snapshot,
  empty
}: {
  sectionID: string;
  title: string;
  items: HomebrewManagedItem[];
  snapshot: BaselineSnapshot;
  empty: string;
}) {
  const collapsed = snapshot.collapsedHomebrewSectionIDs.includes(sectionID);

  return (
    <section className="panel">
      <PanelTitle
        title={title}
        collapsed={collapsed}
        canCollapse
        onToggleCollapse={() => toggleCollapsedSection("homebrew", sectionID, snapshot)}
      />
      {!collapsed &&
        (items.length === 0 ? (
          <Empty text={empty} />
        ) : (
          <CardGrid sectionClassName="ignored-grid">
            {items.map((item) => (
              <IgnoredHomebrewCard key={item.id} item={item} snapshot={snapshot} />
            ))}
          </CardGrid>
        ))}
    </section>
  );
}

export function SettingsView({ snapshot }: { snapshot: BaselineSnapshot }) {
  const [selectedSection, setSelectedSection] = useState<SettingsSectionID>("general");
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [appMetadata, setAppMetadata] = useState<AppMetadata>();
  const selectedItem = settingsSidebarItems.find((item) => item.id === selectedSection);

  useEffect(() => {
    void window.baseline.getAppMetadata().then(setAppMetadata);
  }, []);

  return (
    <main className="app-shell settings-shell">
      <SettingsSidebar selectedSection={selectedSection} onSelectSection={setSelectedSection} />
      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{selectedItem?.label ?? "Settings"}</h1>
          </div>
          {selectedSection === "profile" && <ProfileTopbarIndicators />}
        </header>

        <section className="content settings-content">
          <section className="stack">
            <SettingsPane
              appMetadata={appMetadata}
              diagnosticsCopied={diagnosticsCopied}
              onDiagnosticsCopiedChange={setDiagnosticsCopied}
              section={selectedSection}
              snapshot={snapshot}
            />
          </section>
        </section>
      </section>
    </main>
  );
}

function ProfileTopbarIndicators() {
  return (
    <div className="topbar-actions profile-topbar-indicators" aria-label="Profile privacy details">
      <span
        className="toolbar-button refresh-button profile-topbar-indicator private"
        tabIndex={0}
        aria-label="Private profile. Your profile is only visible to you and stays private on this Mac."
      >
        <LockKeyhole size={13} strokeWidth={toolbarIconStrokeWidth} />
        <span className="profile-topbar-indicator-label">Private</span>
        <span className="profile-topbar-tooltip" role="tooltip">
          Your profile is only visible to you and stays private on this Mac.
        </span>
      </span>
      <span
        className="toolbar-button refresh-button profile-topbar-indicator icon-only"
        tabIndex={0}
        aria-label="Only updates and installs completed with Baseline are counted."
      >
        <Info size={15} strokeWidth={toolbarIconStrokeWidth} />
        <span className="profile-topbar-tooltip" role="tooltip">
          Only updates and installs completed with Baseline are counted.
        </span>
      </span>
    </div>
  );
}

function SettingsSidebar({
  selectedSection,
  onSelectSection
}: {
  selectedSection: SettingsSectionID;
  onSelectSection: (section: SettingsSectionID) => void;
}) {
  return (
    <aside className="sidebar settings-sidebar">
      <div className="settings-sidebar-header">
        <button
          className="back-to-app-button"
          onClick={() => void window.baseline.showMainWindow()}
        >
          <ArrowLeft size={15} strokeWidth={sidebarIconStrokeWidth} />
          <span>Back to app</span>
        </button>
      </div>
      <nav className="source-list">
        {primarySettingsSidebarItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={selectedSection === item.id ? "selected" : ""}
              key={item.id}
              onClick={() => onSelectSection(item.id)}
            >
              <Icon size={16} strokeWidth={sidebarIconStrokeWidth} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <button
          className={selectedSection === "diagnostics" ? "selected" : ""}
          onClick={() => onSelectSection("diagnostics")}
        >
          <ShieldCogCorner size={16} strokeWidth={sidebarIconStrokeWidth} />
          <span>Diagnostics</span>
        </button>
      </div>
    </aside>
  );
}

function SettingsPane({
  appMetadata,
  diagnosticsCopied,
  onDiagnosticsCopiedChange,
  section,
  snapshot
}: {
  appMetadata?: AppMetadata;
  diagnosticsCopied: boolean;
  onDiagnosticsCopiedChange: (copied: boolean) => void;
  section: SettingsSectionID;
  snapshot: BaselineSnapshot;
}) {
  const [cleanupRequestPending, setCleaningUp] = useState(false);
  const cleaningUp = cleanupRequestPending || snapshot.isCleaningUpHomebrew;
  const [cleanupResponseMessage, setCleanupMessage] = useState("");
  const cleanupMessage = snapshot.homebrewCleanupMessage ?? cleanupResponseMessage;
  const cleanupPending = useRef(false);
  const cleanUp = async () => {
    if (cleanupPending.current) return;
    cleanupPending.current = true;
    setCleaningUp(true);
    setCleanupMessage("");
    try {
      setCleanupMessage(await window.baseline.cleanUpHomebrew());
    } catch {
      setCleanupMessage("Homebrew cleanup could not run. Please try again.");
    } finally {
      cleanupPending.current = false;
      setCleaningUp(false);
    }
  };
  switch (section) {
    case "general":
      return (
        <>
          <section className="panel settings-panel">
            <PanelTitle
              title="Update Tools"
              action={
                <button
                  className="ghost-button small-button"
                  disabled={snapshot.isHomebrewCommandLocked || cleaningUp}
                  onClick={() => void window.baseline.refreshToolStatus()}
                >
                  Refresh
                </button>
              }
            />
            <div className="settings-panel-box">
              <ToolStatus
                label="Homebrew"
                description="Find updates for installed casks and formulae."
                missingDetail="Homebrew is not detected on this Mac. Install Homebrew to enable this source."
                ready={snapshot.isHomebrewInstalled}
                readyDetail={homebrewReadyDetail(snapshot)}
              />
              <div
                className="settings-row settings-row-action homebrew-cleanup-row"
                role="group"
                aria-label="Homebrew cleanup"
              >
                <div>
                  <SettingsRowText
                    label="Homebrew cleanup"
                    description="Remove old package versions and cached downloads to free space. Homebrew may also remove supporting packages that are no longer needed. This applies to all Homebrew packages, including ignored items, and cannot be undone."
                  />
                  {cleanupMessage && (
                    <p className="settings-row-subtext" role="status">
                      {cleanupMessage}
                    </p>
                  )}
                </div>
                <button
                  className="danger-button small-button"
                  disabled={
                    !snapshot.isHomebrewInstalled || snapshot.isHomebrewCleanupLocked || cleaningUp
                  }
                  onClick={() => void cleanUp()}
                  title="Runs brew cleanup using your Homebrew settings. Unused dependencies may be removed."
                >
                  {cleaningUp ? "Cleaning up…" : "Clean up Homebrew"}
                </button>
              </div>
              <ToolStatus
                label="mas"
                description="Use the App Store helper when it is available."
                missingDetail="The mas helper is not detected on this Mac. Without mas, Baseline opens App Store links instead of installing App Store updates directly."
                ready={snapshot.isMasInstalled}
                enabled={snapshot.useMasForAppStoreUpdates}
              />
              <Toggle
                label="Use mas for App Store updates"
                description="When enabled, Baseline can install App Store updates directly. When disabled, it opens App Store links instead."
                value={snapshot.useMasForAppStoreUpdates}
                patch="useMasForAppStoreUpdates"
                disabled={!snapshot.isMasInstalled}
              />
            </div>
          </section>
          <section className="panel settings-panel">
            <PanelTitle title="Refresh" />
            <div className="settings-panel-box">
              <Toggle
                label="Auto refresh"
                description="Check for updates automatically in the background."
                value={snapshot.autoRefreshEnabled}
                patch="autoRefreshEnabled"
              />
              <RefreshIntervalInput
                value={snapshot.refreshIntervalMinutes}
                disabled={!snapshot.autoRefreshEnabled}
              />
            </div>
          </section>
          <section className="panel settings-panel">
            <PanelTitle
              title="Scan Directories"
              action={
                <button
                  className="toolbar-button"
                  onClick={() => void window.baseline.chooseDirectory()}
                  title="Add directory"
                >
                  <FolderPlus size={15} />
                </button>
              }
            />
            <div className="settings-panel-box">
              <div className="settings-row-list">
                {snapshot.additionalDirectories.length === 0 ? (
                  <div className="settings-row settings-empty-row">
                    <SettingsRowText
                      label="Default Applications folders"
                      description="Baseline scans the system and user Applications folders automatically."
                    />
                  </div>
                ) : (
                  snapshot.defaultScanDirectories.map((directory) => (
                    <div className="settings-row settings-row-action" key={`default:${directory}`}>
                      <SettingsRowText
                        label={defaultScanDirectoryLabel(directory)}
                        description={directory}
                      />
                    </div>
                  ))
                )}
                {snapshot.additionalDirectories.map((directory) => (
                  <div className="settings-row settings-row-action" key={directory}>
                    <SettingsRowText label="Custom folder" description={directory} />
                    <button
                      className="toolbar-button"
                      onClick={() => void window.baseline.removeDirectory(directory)}
                      title="Remove"
                    >
                      <XCircle size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </>
      );
    case "profile":
      return <ProfileSection snapshot={snapshot} />;
    case "appearance":
      return (
        <>
          <section className="panel settings-panel">
            <PanelTitle title="Theme" />
            <div className="settings-panel-box">
              <div className="settings-row settings-row-action">
                <SettingsRowText
                  label="App theme"
                  description="Use light, dark, or match your system."
                />
                <AppearanceSelector value={snapshot.appearancePreference} />
              </div>
            </div>
          </section>
          <section className="panel settings-panel">
            <PanelTitle title="Dock & Menu Bar" />
            <div className="settings-panel-box">
              <Toggle
                label="Show Dock icon"
                description="Show Baseline in the Dock and Command-Tab app switcher. Turning this off keeps the menu bar icon on so you can reopen Baseline."
                value={snapshot.showDockIcon}
                patch="showDockIcon"
              />
              <Toggle
                label="Show menu bar icon"
                description="Click for the compact update popover. Right-click to refresh your apps, open Settings, check for Baseline updates, or quit. Turning this off shows the Dock icon."
                value={snapshot.showMenuBarIcon}
                patch="showMenuBarIcon"
              />
            </div>
          </section>
        </>
      );
    case "diagnostics":
      return (
        <>
          <section className="panel settings-panel">
            <PanelTitle title="About" />
            <div className="settings-panel-box">
              <div className="settings-row settings-row-action">
                <span>Current version</span>
                <strong className="settings-row-value">{appMetadata?.version ?? "Loading"}</strong>
              </div>
            </div>
          </section>
          <section className="panel settings-panel">
            <PanelTitle title="Diagnostics" />
            <div className="settings-panel-box">
              <div className="settings-row settings-row-action">
                <SettingsRowText
                  label="Diagnostic report"
                  description="Copy a local report with counts, tool status, scan paths, and the latest non-sensitive refresh message."
                />
                <button
                  className="primary-button wide"
                  onClick={() => {
                    void window.baseline
                      .copyDiagnostics()
                      .then(() => onDiagnosticsCopiedChange(true));
                  }}
                >
                  {diagnosticsCopied ? "Copied" : "Copy Report"}
                </button>
              </div>
            </div>
          </section>
        </>
      );
  }
}

function ProfileSection({ snapshot }: { snapshot: BaselineSnapshot }) {
  const profile = useMemo(() => buildProfileSummary(snapshot), [snapshot]);
  const activeSourceMix = profile.sourceMix.filter((source) => source.count > 0);
  const sourceMixTotal = profile.sourceMix.reduce((total, source) => total + source.count, 0);
  const resetNotice = snapshot.profileStats.resetNotice;
  const shouldShowResetWarning =
    Boolean(resetNotice) && snapshot.profileStatsResetAcknowledgedID !== resetNotice?.id;
  return (
    <div className="profile-page">
      <div className="profile-stack">
        <section className="panel settings-panel profile-start-section">
          <div className="settings-panel-box profile-start-panel-box">
            <div className="profile-start-summary">
              <strong>
                <span className="profile-start-value">{profile.startedUsing.relativeLabel}</span>
                <span className="profile-start-unit">with Baseline</span>
              </strong>
              <span className="profile-start-date">{profile.startedUsing.dateLabel}</span>
            </div>
          </div>
        </section>
        <section className="panel settings-panel">
          <PanelTitle title="Stats" />
          <div className="settings-panel-box profile-panel-box">
            <div className="profile-stat-grid">
              <ProfileMetric label="Total updates" value={String(profile.totalUpdates)} />
              <ProfileMetric label="Unique apps" value={String(profile.differentApps)} />
              <ProfileMetric label="Homebrew Installs" value={String(profile.discoverInstalls)} />
              <ProfileMetric label="Favorite source" value={profile.favoriteChannelLabel} />
            </div>
          </div>
        </section>
        <section className="panel settings-panel profile-source-section">
          <div className="settings-panel-box profile-source-panel-box">
            {activeSourceMix.length > 0 ? (
              <div className="profile-source-list">
                <div
                  className="profile-source-bar"
                  aria-label={activeSourceMix
                    .map((source) => profileSourceShareLabel(source, sourceMixTotal))
                    .join(", ")}
                  role="img"
                >
                  {activeSourceMix.map((source) => (
                    <span
                      className={`profile-source-segment ${profileSourceClass(source.channel)}`}
                      key={source.channel}
                      style={{ flexGrow: source.count }}
                    >
                      <span className="profile-source-tooltip" aria-hidden="true">
                        {profileSourceCountLabel(source)}
                      </span>
                    </span>
                  ))}
                </div>
                <div className="profile-source-legend">
                  {activeSourceMix.map((source) => (
                    <div
                      className="profile-source-chip"
                      key={source.channel}
                      aria-label={profileSourceShareLabel(source, sourceMixTotal)}
                    >
                      <span
                        className={`profile-source-dot ${profileSourceClass(source.channel)}`}
                        aria-hidden="true"
                      />
                      <span>{source.label}</span>
                      <strong>{profileSourcePercentLabel(source, sourceMixTotal)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="profile-empty-state">
                Update something with Baseline to build a source history.
              </p>
            )}
          </div>
        </section>
        <section className="panel settings-panel">
          <PanelTitle title="Most updated apps" />
          <div className="settings-panel-box profile-top-apps-panel-box">
            {profile.topApps.length > 0 ? (
              <ol className="profile-top-app-list">
                {profile.topApps.map((app) => (
                  <li key={app.targetID}>
                    <span className={`profile-top-app-rank profile-top-app-rank-${app.rank}`}>
                      {app.rank}
                    </span>
                    <span
                      className={
                        app.iconDataURL ? "profile-top-app-icon has-image" : "profile-top-app-icon"
                      }
                      aria-hidden="true"
                    >
                      {app.iconDataURL ? (
                        <img src={app.iconDataURL} alt="" draggable={false} />
                      ) : (
                        app.displayName.slice(0, 1).toUpperCase()
                      )}
                    </span>
                    <span className="profile-top-app-name">{app.displayName}</span>
                    <strong>
                      {app.count} update{app.count === 1 ? "" : "s"}
                    </strong>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="profile-empty-state">Apps you update with Baseline will appear here.</p>
            )}
          </div>
        </section>
        <section className="panel settings-panel">
          <PanelTitle title="Most updated tools" />
          <div className="settings-panel-box profile-top-apps-panel-box">
            {profile.topHomebrewItems.length > 0 ? (
              <ol className="profile-top-app-list profile-top-tool-list">
                {profile.topHomebrewItems.map((item) => (
                  <li key={item.targetID}>
                    <span className={`profile-top-app-rank profile-top-app-rank-${item.rank}`}>
                      {item.rank}
                    </span>
                    <span className="profile-top-app-icon profile-top-tool-icon" aria-hidden="true">
                      <Terminal size={29} strokeWidth={2.2} />
                    </span>
                    <span className="profile-top-app-name">{item.displayName}</span>
                    <strong>
                      {item.count} update{item.count === 1 ? "" : "s"} · {item.kindLabel}
                    </strong>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="profile-empty-state">
                Tools you update with Baseline will appear here.
              </p>
            )}
          </div>
        </section>
      </div>
      {shouldShowResetWarning && (
        <section className="panel settings-panel profile-footer-panel">
          <div className="settings-panel-box">
            <div className="settings-row settings-row-action profile-warning-row">
              <SettingsRowText
                label="Stats were reset"
                description="Baseline could not verify the local stats history, so it started a fresh one on this Mac."
              />
              <button
                className="toolbar-button"
                onClick={() => void window.baseline.acknowledgeProfileStatsReset()}
                title="Dismiss"
                aria-label="Dismiss stats reset warning"
              >
                <X size={15} />
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function ProfileMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="profile-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function AppearanceSelector({ value }: { value: AppearancePreference }) {
  return (
    <div className="appearance-options" role="group" aria-label="Appearance">
      {appearanceOptions.map((option) => {
        const Icon = option.icon;
        const selected = option.value === value;
        return (
          <button
            aria-pressed={selected}
            className={selected ? "selected" : ""}
            key={option.value}
            onClick={() =>
              void window.baseline.updatePreferences({ appearancePreference: option.value })
            }
            type="button"
          >
            <Icon size={15} strokeWidth={toolbarIconStrokeWidth} />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function RefreshIntervalInput({ value, disabled }: { value: number; disabled: boolean }) {
  const [draft, setDraft] = useState(String(value));
  const lastCommittedDraftRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const nextDraft = String(value);
    setDraft(nextDraft);
    if (lastCommittedDraftRef.current !== nextDraft) {
      lastCommittedDraftRef.current = undefined;
    }
  }, [value]);

  const commitDraft = () => {
    if (!draft) {
      setDraft(String(value));
      return;
    }
    const refreshIntervalMinutes = clampRefreshIntervalMinutes(Number.parseInt(draft, 10));
    const normalizedDraft = String(refreshIntervalMinutes);
    setDraft(normalizedDraft);
    if (lastCommittedDraftRef.current === normalizedDraft) {
      return;
    }
    lastCommittedDraftRef.current = normalizedDraft;
    void window.baseline.updatePreferences({ refreshIntervalMinutes });
  };

  return (
    <label
      className={
        disabled
          ? "settings-row settings-row-control settings-row-disabled"
          : "settings-row settings-row-control"
      }
    >
      <SettingsRowText
        label="Interval minutes"
        description="How often Baseline checks when auto refresh is on."
      />
      <input
        aria-label="Interval minutes"
        className="settings-number-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        disabled={disabled}
        value={draft}
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          if (!/^\d*$/u.test(nextValue)) {
            return;
          }
          lastCommittedDraftRef.current = undefined;
          setDraft(nextValue);
        }}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commitDraft();
          }
        }}
      />
    </label>
  );
}

function Toggle({
  label,
  description,
  value,
  patch,
  disabled = false
}: {
  label: string;
  description: string;
  value: boolean;
  patch: TogglePatch;
  disabled?: boolean;
}) {
  return (
    <label
      className={
        disabled
          ? "settings-row settings-row-control settings-row-disabled"
          : "settings-row settings-row-control"
      }
    >
      <SettingsRowText label={label} description={description} />
      <input
        aria-label={label}
        className="settings-switch"
        type="checkbox"
        role="switch"
        checked={value}
        disabled={disabled}
        onChange={(event) => {
          if (disabled) {
            return;
          }
          void window.baseline.updatePreferences({ [patch]: event.currentTarget.checked });
        }}
      />
    </label>
  );
}

function SettingsRowText({
  label,
  description,
  secondaryDescription
}: {
  label: string;
  description?: string;
  secondaryDescription?: string;
}) {
  return (
    <span className="settings-row-text">
      <span>{label}</span>
      {description && <span className="settings-row-subtext">{description}</span>}
      {secondaryDescription && <span className="settings-row-subtext">{secondaryDescription}</span>}
    </span>
  );
}

function ToolStatus({
  label,
  description,
  missingDetail,
  ready,
  readyDetail,
  enabled = true
}: {
  label: string;
  description: string;
  missingDetail: string;
  ready: boolean;
  readyDetail?: string;
  enabled?: boolean;
}) {
  const active = ready && enabled;
  const statusLabel = ready ? (enabled ? "Enabled" : "Not used") : "Not detected";
  const detail = ready ? (readyDetail ?? description) : `${description} ${missingDetail}`;
  return (
    <div className="settings-row settings-row-status">
      <SettingsRowText label={label} description={detail} />
      <span className={active ? "settings-status-label enabled" : "settings-status-label muted"}>
        <span className="settings-status-glyph" aria-hidden="true" />
        <span>{statusLabel}</span>
      </span>
    </div>
  );
}

function currentRoute(): Route {
  const raw = window.location.hash.replace(/^#\/?/u, "");
  if (raw === "menubar" || raw === "settings") {
    return raw;
  }
  return "main";
}

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(<App />);
}

export { AppRow, DiscoverRow, HomebrewRow } from "./components/ItemViews";

export { UpdateActionButton } from "./components/CommonControls";

export { ActionConfirmationContext } from "./components/ActionConfirmation";

export { actionStateFromFlags } from "./helpers/actionState";

export { uninstallableHomebrewItemForApp } from "./helpers/sections";

export type { ActionConfirmation, ActionState } from "./types";
