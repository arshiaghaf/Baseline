// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  AppWindowMac,
  ArrowLeft,
  Beer,
  Check,
  CheckCircle2,
  CircleUserRound,
  ChevronRight,
  ClockArrowDown,
  Download,
  Eye,
  EyeOff,
  FolderPlus,
  Link2,
  Monitor,
  MoreHorizontal,
  Moon,
  Package,
  RefreshCcw,
  Search,
  Server,
  Settings,
  ShieldCogCorner,
  Sun,
  Terminal,
  Trash2,
  X,
  XCircle
} from "lucide-react";
import type { AppMetadata } from "../shared/appMetadata";
import type {
  AppRecord,
  AppearancePreference,
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  MenuTab,
  ProfileStatsChannel,
  ProfileStatsEvent,
  RecentlyUpdatedRecord,
  UpdateRecord
} from "../shared/domain";
import {
  defaultPersistedSnapshot,
  homebrewPresentationLabel,
  sourceDisplayName
} from "../shared/domain";
import {
  homebrewItemHasAppRepresentation,
  homebrewItemIdentifiers,
  homebrewItemMatchesApp,
  isCask,
  normalizedHomebrewAppName
} from "../shared/homebrewAppLinking";
import { compareVersions } from "../shared/version";
import "./styles.css";

type Route = "main" | "menubar" | "settings";
type ActionState =
  | { type: "ready" }
  | { type: "queued" }
  | { type: "updating"; progress?: number }
  | { type: "done" }
  | { type: "failed" };
type ActionConfirmation =
  | { type: "install"; item: HomebrewCaskDiscoveryItem }
  | { type: "uninstall"; item: HomebrewManagedItem };
type RequestActionConfirmation = (confirmation: ActionConfirmation) => void;
type RowUpdateMenuAction = {
  state: ActionState;
  disabled?: boolean;
  onAction: () => void;
};
type RowActionMenuPlacement = "below" | "above" | "floating";
type RowActionMenuFloatingPosition = {
  left: number;
  top: number;
};
type SettingsSectionID = "general" | "profile" | "appearance" | "diagnostics";

const ActionConfirmationContext = React.createContext<RequestActionConfirmation>(() => {});
const sidebarIconStrokeWidth = 1.5;
const toolbarIconStrokeWidth = 1.5;
const settingsSidebarItems: Array<{
  id: SettingsSectionID;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
}> = [
  { id: "general", label: "General", icon: Settings },
  { id: "profile", label: "Profile", icon: CircleUserRound },
  { id: "appearance", label: "Appearance", icon: Monitor },
  { id: "diagnostics", label: "Diagnostics", icon: Terminal }
];
const primarySettingsSidebarItems = settingsSidebarItems.filter(
  (item) => item.id !== "diagnostics"
);

const initialSnapshot: BaselineSnapshot = {
  ...defaultPersistedSnapshot(),
  isMasInstalled: false,
  isHomebrewInstalled: false,
  isChecking: true,
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
  defaultScanDirectories: []
};

export function App() {
  const [snapshot, setSnapshot] = useState<BaselineSnapshot>(initialSnapshot);
  const [route, setRoute] = useState<Route>(currentRoute());
  const [searchActive, setSearchActive] = useState(false);
  const previousSearchTextRef = useRef(initialSnapshot.searchText);

  useEffect(() => {
    void window.baseline.getSnapshot().then(setSnapshot);
    return window.baseline.onSnapshotChanged(setSnapshot);
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
  const derived = useMemo(
    () => deriveSections(compact && searchActive ? snapshot : { ...snapshot, searchText: "" }),
    [snapshot, compact, searchActive]
  );
  const searchDerived = useMemo(
    () => deriveSections(searchActive ? snapshot : { ...snapshot, searchText: "" }),
    [snapshot, searchActive]
  );
  const sidebarDerived = useMemo(() => deriveSections({ ...snapshot, searchText: "" }), [snapshot]);
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

function clearCompactPopoverControlFocus(
  target: EventTarget | Element | null,
  compactShell: HTMLElement | null
): void {
  const focusTarget = compactPopoverControlFocusTarget(target, compactShell);
  if (!focusTarget) {
    return;
  }
  focusTarget.blur();
}

function suppressCompactPopoverControlFocus(
  target: EventTarget | Element | null,
  compactShell: HTMLElement | null,
  event: React.MouseEvent
): void {
  if (compactPopoverControlFocusTarget(target, compactShell)) {
    event.preventDefault();
  }
}

function compactPopoverControlFocusTarget(
  target: EventTarget | Element | null,
  compactShell: HTMLElement | null
): HTMLElement | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }
  const focusTarget = target.closest("button, input, textarea, [contenteditable='true']");
  if (!(focusTarget instanceof HTMLElement)) {
    return undefined;
  }
  if (compactShell && !compactShell.contains(focusTarget)) {
    return undefined;
  }
  if (focusTarget.matches("input, textarea, [contenteditable='true']")) {
    return undefined;
  }
  return focusTarget;
}

function setElementInert(element: HTMLElement, inert: boolean): void {
  (element as HTMLElement & { inert: boolean }).inert = inert;
}

const focusableSelector = [
  "a[href]:not([tabindex='-1'])",
  "button:not(:disabled):not([tabindex='-1'])",
  "input:not(:disabled):not([tabindex='-1'])",
  "select:not(:disabled):not([tabindex='-1'])",
  "textarea:not(:disabled):not([tabindex='-1'])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function focusableElementsIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
    .filter(
      (element) =>
        !element.closest("[aria-hidden='true']") &&
        element.getAttribute("tabindex") !== "-1" &&
        element.tabIndex >= 0
    )
    .sort(compareDocumentOrder);
}

function compareDocumentOrder(lhs: HTMLElement, rhs: HTMLElement): number {
  if (lhs === rhs) {
    return 0;
  }
  const position = lhs.compareDocumentPosition(rhs);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
    return -1;
  }
  if (position & Node.DOCUMENT_POSITION_PRECEDING) {
    return 1;
  }
  return 0;
}

function trapFocusWithin(event: KeyboardEvent, container: HTMLElement | null): void {
  if (!container) {
    return;
  }

  const focusableElements = focusableElementsIn(container);
  if (focusableElements.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }

  const firstElement = focusableElements[0]!;
  const lastElement = focusableElements[focusableElements.length - 1]!;
  const activeElement = document.activeElement;
  if (event.shiftKey) {
    if (activeElement === firstElement || !container.contains(activeElement)) {
      event.preventDefault();
      lastElement.focus();
    }
    return;
  }

  if (activeElement === lastElement || !container.contains(activeElement)) {
    event.preventDefault();
    firstElement.focus();
  }
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

const searchPaletteFloatingRowMenuSelector =
  "[data-search-palette-floating-row-menu='true'][role='menu']";

function hasOpenNestedMenu(container: HTMLElement | null): boolean {
  return Boolean(
    container?.querySelector("[role='menu']") ||
    document.querySelector(searchPaletteFloatingRowMenuSelector)
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
              state={{ type: "ready" }}
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

type AppControlState = {
  update?: UpdateRecord;
  isIgnored: boolean;
  uninstallableItem?: HomebrewManagedItem;
  isUninstalling: boolean;
  actionState: ActionState;
  isUpdating: boolean;
  homebrewUninstallBlocked: boolean;
};

function appControlState(app: AppRecord, snapshot: BaselineSnapshot): AppControlState {
  const update = snapshot.updates.find((candidate) => candidate.appID === app.id);
  const isIgnored = snapshot.ignoredIDs.includes(app.id);
  const uninstallableItem = uninstallableHomebrewItemForApp(app, snapshot);
  const isUninstalling = uninstallableItem
    ? snapshot.homebrewUninstallingItemIDs.includes(uninstallableItem.id)
    : false;
  const { state: actionState, isUpdating } = appUpdateActionState(app, snapshot);
  const homebrewCommandActive = isHomebrewCommandActive(snapshot);
  const homebrewUninstallBlocked = Boolean(
    uninstallableItem && homebrewCommandActive && !isUninstalling
  );
  return {
    update,
    isIgnored,
    uninstallableItem,
    isUninstalling,
    actionState,
    isUpdating,
    homebrewUninstallBlocked
  };
}

function AppIconButton({ app }: { app: AppRecord }) {
  return (
    <button
      className={
        app.iconDataURL
          ? "app-icon app-icon-image clickable-app-icon"
          : "app-icon clickable-app-icon"
      }
      onClick={() => void window.baseline.openApp(app.id)}
      title="Open app"
      aria-label="Open app"
    >
      {app.iconDataURL ? (
        <img src={app.iconDataURL} alt="" draggable={false} />
      ) : (
        app.displayName.slice(0, 1).toUpperCase()
      )}
    </button>
  );
}

function AppUpdateCard({ app, snapshot }: { app: AppRecord; snapshot: BaselineSnapshot }) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const {
    update,
    isIgnored,
    uninstallableItem,
    isUninstalling,
    actionState,
    isUpdating,
    homebrewUninstallBlocked
  } = appControlState(app, snapshot);
  const label = appSourceLabel(app, snapshot);

  return (
    <article className={isIgnored ? "item-card update-card ignored-row" : "item-card update-card"}>
      <div className="item-card-top">
        <AppIconButton app={app} />
        <div className="item-card-actions">
          {update && (
            <UpdateActionButton
              state={actionState}
              disabled={isUninstalling}
              onAction={() => void window.baseline.performAppUpdate(app.id)}
            />
          )}
          <RowMoreActionButton
            isIgnored={isIgnored}
            disabled={isUninstalling}
            onToggleIgnore={() => void window.baseline.toggleIgnoredApp(app.id)}
            uninstallLabel="Uninstall"
            canUninstall={Boolean(uninstallableItem)}
            uninstalling={isUninstalling}
            uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
            onUninstall={() =>
              uninstallableItem &&
              requestActionConfirmation({ type: "uninstall", item: uninstallableItem })
            }
          />
        </div>
      </div>
      <div className="item-card-main row-main">
        <div className="row-title">
          <strong>{app.displayName}</strong>
          {label && <span>{label}</span>}
        </div>
        <p>
          {update ? (
            <VersionChange
              from={appUpdateVersionChange(update).from}
              to={appUpdateVersionChange(update).to}
            />
          ) : (
            app.localVersion.raw || "unknown"
          )}
        </p>
      </div>
    </article>
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

function RecentAppCard({ app, snapshot }: { app: AppRecord; snapshot: BaselineSnapshot }) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const {
    update,
    isIgnored,
    uninstallableItem,
    isUninstalling,
    actionState,
    isUpdating,
    homebrewUninstallBlocked
  } = appControlState(app, snapshot);
  const recentlyUpdatedRecord = snapshot.recentlyUpdated.find((record) => record.appID === app.id);
  const label = appSourceLabel(app, snapshot, recentlyUpdatedRecord);

  return (
    <article className={isIgnored ? "item-card recent-card ignored-row" : "item-card recent-card"}>
      <div className="item-card-top">
        <AppIconButton app={app} />
        <div className="item-card-actions">
          {update && (
            <UpdateActionButton
              state={actionState}
              disabled={isUninstalling}
              onAction={() => void window.baseline.performAppUpdate(app.id)}
            />
          )}
          <RowMoreActionButton
            isIgnored={isIgnored}
            disabled={isUninstalling}
            onToggleIgnore={() => void window.baseline.toggleIgnoredApp(app.id)}
            uninstallLabel="Uninstall"
            canUninstall={Boolean(uninstallableItem)}
            uninstalling={isUninstalling}
            uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
            onUninstall={() =>
              uninstallableItem &&
              requestActionConfirmation({ type: "uninstall", item: uninstallableItem })
            }
          />
        </div>
      </div>
      <div className="item-card-main row-main">
        <div className="row-title">
          <strong>{app.displayName}</strong>
          {label && <span>{label}</span>}
        </div>
        <p>
          {recentlyUpdatedRecord
            ? updatedRelativeLabel(recentlyUpdatedRecord.updatedAt)
            : "Updated recently"}
        </p>
      </div>
    </article>
  );
}

function IgnoredAppCard({ app, snapshot }: { app: AppRecord; snapshot: BaselineSnapshot }) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const {
    update,
    isIgnored,
    uninstallableItem,
    isUninstalling,
    actionState,
    isUpdating,
    homebrewUninstallBlocked
  } = appControlState(app, snapshot);
  const label = appSourceLabel(app, snapshot);

  return (
    <article className="item-card ignored-card ignored-row">
      <div className="item-card-top">
        <AppIconButton app={app} />
        <div className="item-card-actions">
          <RowMoreActionButton
            isIgnored={isIgnored}
            disabled={isUninstalling}
            updateAction={
              update
                ? {
                    state: actionState,
                    disabled: isUninstalling,
                    onAction: () => void window.baseline.performAppUpdate(app.id)
                  }
                : undefined
            }
            onToggleIgnore={() => void window.baseline.toggleIgnoredApp(app.id)}
            uninstallLabel="Uninstall"
            canUninstall={Boolean(uninstallableItem)}
            uninstalling={isUninstalling}
            uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
            onUninstall={() =>
              uninstallableItem &&
              requestActionConfirmation({ type: "uninstall", item: uninstallableItem })
            }
          />
        </div>
      </div>
      <div className="item-card-main row-main">
        <div className="row-title">
          <strong>{app.displayName}</strong>
          {label && <span>{label}</span>}
        </div>
        <p>
          {update ? (
            <VersionChange
              from={appUpdateVersionChange(update).from}
              to={appUpdateVersionChange(update).to}
            />
          ) : (
            app.localVersion.raw || "unknown"
          )}
        </p>
      </div>
    </article>
  );
}

export function AppRow({
  app,
  snapshot,
  recentlyUpdated
}: {
  app: AppRecord;
  snapshot: BaselineSnapshot;
  recentlyUpdated: boolean;
}) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const {
    update,
    isIgnored,
    uninstallableItem,
    isUninstalling,
    actionState,
    isUpdating,
    homebrewUninstallBlocked
  } = appControlState(app, snapshot);
  const recentlyUpdatedRecord = recentlyUpdated
    ? snapshot.recentlyUpdated.find((record) => record.appID === app.id)
    : undefined;
  const recentlyUpdatedAt = recentlyUpdatedRecord?.updatedAt;
  const label = appSourceLabel(app, snapshot, recentlyUpdatedRecord);

  return (
    <article className={isIgnored ? "row ignored-row" : "row"}>
      <AppIconButton app={app} />
      <div className="row-main">
        <div className="row-title">
          <strong>{app.displayName}</strong>
          {label && <span>{label}</span>}
        </div>
        <p>
          {update ? (
            <VersionChange
              from={appUpdateVersionChange(update).from}
              to={appUpdateVersionChange(update).to}
            />
          ) : recentlyUpdatedAt ? (
            updatedRelativeLabel(recentlyUpdatedAt)
          ) : (
            app.localVersion.raw || "unknown"
          )}
        </p>
      </div>
      <div className="row-actions">
        {update && (
          <UpdateActionButton
            state={actionState}
            disabled={isUninstalling}
            onAction={() => void window.baseline.performAppUpdate(app.id)}
          />
        )}
        <RowMoreActionButton
          isIgnored={isIgnored}
          disabled={isUninstalling}
          onToggleIgnore={() => void window.baseline.toggleIgnoredApp(app.id)}
          uninstallLabel="Uninstall"
          canUninstall={Boolean(uninstallableItem)}
          uninstalling={isUninstalling}
          uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
          onUninstall={() =>
            uninstallableItem &&
            requestActionConfirmation({ type: "uninstall", item: uninstallableItem })
          }
        />
      </div>
    </article>
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

export function DiscoverRow({
  item,
  snapshot
}: {
  item: HomebrewCaskDiscoveryItem;
  snapshot: BaselineSnapshot;
}) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const installing = snapshot.homebrewDiscoverInstallingItemIDs.includes(item.id);
  const failed = snapshot.homebrewDiscoverFailedItemIDs.includes(item.id);
  const done = snapshot.homebrewDiscoverInstalledPendingRefreshItemIDs.includes(item.id);
  const progress = snapshot.homebrewDiscoverProgressByItemID[item.id];
  const canInstall = snapshot.isHomebrewInstalled;
  const busy = canInstall && !installing && !failed && !done && isHomebrewCommandActive(snapshot);

  return (
    <article className="row">
      <HomebrewItemIcon item={item} snapshot={snapshot} />
      <div className="row-main">
        <div className="row-title">
          <strong>{item.displayName}</strong>
          <span>{homebrewPresentationLabel(item.kind, item.presentation)}</span>
        </div>
        <p>
          {canInstall
            ? item.version.raw || item.token
            : "Homebrew is not installed. Install Homebrew to enable this source."}
        </p>
      </div>
      <div className="row-actions">
        <UpdateActionButton
          state={actionStateFromFlags({ failed, updating: installing, progress, done })}
          readyLabel={canInstall ? (busy ? "Busy" : "Install") : "Needs Homebrew"}
          disabled={!canInstall || busy}
          onAction={() => {
            if (canInstall && !busy) {
              requestActionConfirmation({ type: "install", item });
            }
          }}
        />
        {item.homepageURL && (
          <button
            className="icon-button"
            onClick={() => void window.baseline.openExternal(item.homepageURL!)}
            title="Open Homebrew page"
            aria-label="Open Homebrew page"
          >
            <Link2 size={15} />
          </button>
        )}
      </div>
    </article>
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
              state={{ type: "ready" }}
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

type HomebrewControlState = {
  isUpdating: boolean;
  isUninstalling: boolean;
  isIgnored: boolean;
  updateState: ActionState;
  homebrewUninstallBlocked: boolean;
};

function homebrewControlState(
  item: HomebrewManagedItem,
  snapshot: BaselineSnapshot
): HomebrewControlState {
  const isUpdating = snapshot.homebrewUpdatingItemIDs.includes(item.id);
  const queued = snapshot.homebrewQueuedItemIDs.includes(item.id);
  const isUninstalling = snapshot.homebrewUninstallingItemIDs.includes(item.id);
  const isIgnored = snapshot.ignoredHomebrewItemIDs.includes(item.id);
  const failed = snapshot.homebrewBatchFailedItemIDs.includes(item.id);
  const done = snapshot.homebrewUpdatedPendingRefreshItemIDs.includes(item.id);
  const progress = snapshot.homebrewBatchProgressByItemID[item.id];
  const homebrewUninstallBlocked = isHomebrewCommandActive(snapshot) && !isUninstalling;
  return {
    isUpdating,
    isUninstalling,
    isIgnored,
    updateState: actionStateFromFlags({
      failed,
      queued,
      updating: isUpdating,
      progress,
      done
    }),
    homebrewUninstallBlocked
  };
}

function HomebrewUpdateCard({
  item,
  snapshot
}: {
  item: HomebrewManagedItem;
  snapshot: BaselineSnapshot;
}) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const { isUpdating, isUninstalling, isIgnored, updateState, homebrewUninstallBlocked } =
    homebrewControlState(item, snapshot);

  return (
    <article className={isIgnored ? "item-card update-card ignored-row" : "item-card update-card"}>
      <div className="item-card-top">
        <HomebrewItemIcon item={item} snapshot={snapshot} />
        <div className="item-card-actions">
          {item.isOutdated && (
            <UpdateActionButton
              state={updateState}
              disabled={isUninstalling}
              onAction={() => void window.baseline.performHomebrewUpdate(item.id)}
            />
          )}
          <RowMoreActionButton
            isIgnored={isIgnored}
            disabled={isUninstalling}
            onToggleIgnore={() => void window.baseline.toggleIgnoredHomebrew(item.id)}
            uninstallLabel="Uninstall"
            canUninstall={item.kind === "cask"}
            uninstalling={isUninstalling}
            uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
            onUninstall={() => requestActionConfirmation({ type: "uninstall", item })}
          />
        </div>
      </div>
      <div className="item-card-main row-main">
        <div className="row-title">
          <strong>{item.name}</strong>
          <span>{homebrewPresentationLabel(item.kind, item.presentation)}</span>
        </div>
        <p>
          {item.latestVersion ? (
            <VersionChange
              from={item.installedVersion.raw || "unknown"}
              to={item.latestVersion.raw}
            />
          ) : (
            item.installedVersion.raw || "unknown"
          )}
        </p>
      </div>
    </article>
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

function RecentHomebrewCard({
  item,
  snapshot,
  appCaskLabel
}: {
  item: HomebrewManagedItem;
  snapshot: BaselineSnapshot;
  appCaskLabel?: string;
}) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const { isUpdating, isUninstalling, isIgnored, updateState, homebrewUninstallBlocked } =
    homebrewControlState(item, snapshot);
  const recentlyUpdatedRecord = snapshot.homebrewRecentlyUpdated.find(
    (record) => record.itemID === item.id
  );

  return (
    <article className={isIgnored ? "item-card recent-card ignored-row" : "item-card recent-card"}>
      <div className="item-card-top">
        <HomebrewItemIcon item={item} snapshot={snapshot} />
        <div className="item-card-actions">
          {item.isOutdated && (
            <UpdateActionButton
              state={updateState}
              disabled={isUninstalling}
              onAction={() => void window.baseline.performHomebrewUpdate(item.id)}
            />
          )}
          <RowMoreActionButton
            isIgnored={isIgnored}
            disabled={isUninstalling}
            onToggleIgnore={() => void window.baseline.toggleIgnoredHomebrew(item.id)}
            uninstallLabel="Uninstall"
            canUninstall={item.kind === "cask"}
            uninstalling={isUninstalling}
            uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
            onUninstall={() => requestActionConfirmation({ type: "uninstall", item })}
          />
        </div>
      </div>
      <div className="item-card-main row-main">
        <div className="row-title">
          <strong>{item.name}</strong>
          <span>{homebrewItemLabel(item, appCaskLabel)}</span>
        </div>
        <p>
          {recentlyUpdatedRecord
            ? updatedRelativeLabel(recentlyUpdatedRecord.updatedAt)
            : "Updated recently"}
        </p>
      </div>
    </article>
  );
}

function IgnoredHomebrewCard({
  item,
  snapshot
}: {
  item: HomebrewManagedItem;
  snapshot: BaselineSnapshot;
}) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const { isUpdating, isUninstalling, isIgnored, updateState, homebrewUninstallBlocked } =
    homebrewControlState(item, snapshot);

  return (
    <article className="item-card ignored-card ignored-row">
      <div className="item-card-top">
        <HomebrewItemIcon item={item} snapshot={snapshot} />
        <div className="item-card-actions">
          <RowMoreActionButton
            isIgnored={isIgnored}
            disabled={isUninstalling}
            updateAction={
              item.isOutdated
                ? {
                    state: updateState,
                    disabled: isUninstalling,
                    onAction: () => void window.baseline.performHomebrewUpdate(item.id)
                  }
                : undefined
            }
            onToggleIgnore={() => void window.baseline.toggleIgnoredHomebrew(item.id)}
            uninstallLabel="Uninstall"
            canUninstall={item.kind === "cask"}
            uninstalling={isUninstalling}
            uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
            onUninstall={() => requestActionConfirmation({ type: "uninstall", item })}
          />
        </div>
      </div>
      <div className="item-card-main row-main">
        <div className="row-title">
          <strong>{item.name}</strong>
          <span>{homebrewPresentationLabel(item.kind, item.presentation)}</span>
        </div>
        <p>
          {item.latestVersion ? (
            <VersionChange
              from={item.installedVersion.raw || "unknown"}
              to={item.latestVersion.raw}
            />
          ) : (
            item.installedVersion.raw || "unknown"
          )}
        </p>
      </div>
    </article>
  );
}

export function HomebrewRow({
  item,
  snapshot,
  recentlyUpdated = false
}: {
  item: HomebrewManagedItem;
  snapshot: BaselineSnapshot;
  recentlyUpdated?: boolean;
}) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const { isUpdating, isUninstalling, isIgnored, updateState, homebrewUninstallBlocked } =
    homebrewControlState(item, snapshot);
  const recentlyUpdatedAt = recentlyUpdated
    ? snapshot.homebrewRecentlyUpdated.find((record) => record.itemID === item.id)?.updatedAt
    : undefined;

  return (
    <article className={isIgnored ? "row ignored-row" : "row"}>
      <HomebrewItemIcon item={item} snapshot={snapshot} />
      <div className="row-main">
        <div className="row-title">
          <strong>{item.name}</strong>
          <span>{homebrewPresentationLabel(item.kind, item.presentation)}</span>
        </div>
        <p>
          {recentlyUpdatedAt ? (
            updatedRelativeLabel(recentlyUpdatedAt)
          ) : item.latestVersion ? (
            <VersionChange
              from={item.installedVersion.raw || "unknown"}
              to={item.latestVersion.raw}
            />
          ) : (
            item.installedVersion.raw || "unknown"
          )}
        </p>
      </div>
      <div className="row-actions">
        {item.isOutdated && (
          <UpdateActionButton
            state={updateState}
            disabled={isUninstalling}
            onAction={() => void window.baseline.performHomebrewUpdate(item.id)}
          />
        )}
        <RowMoreActionButton
          isIgnored={isIgnored}
          disabled={isUninstalling}
          onToggleIgnore={() => void window.baseline.toggleIgnoredHomebrew(item.id)}
          uninstallLabel="Uninstall"
          canUninstall={item.kind === "cask"}
          uninstalling={isUninstalling}
          uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
          onUninstall={() => requestActionConfirmation({ type: "uninstall", item })}
        />
      </div>
    </article>
  );
}

function HomebrewItemIcon({
  item,
  snapshot
}: {
  item: Pick<HomebrewManagedItem, "kind" | "token" | "presentation"> &
    Partial<
      Pick<HomebrewManagedItem, "appID" | "name" | "iconDataURL"> &
        Pick<HomebrewCaskDiscoveryItem, "displayName">
    >;
  snapshot: BaselineSnapshot;
}) {
  const app = matchingAppForHomebrewItem(item, snapshot);
  const iconDataURL = item.iconDataURL ?? app?.iconDataURL;
  const isCaskItem = isCask(item.kind);
  const isCliLike = item.kind === "formula" || item.presentation === "cli";
  const fallbackIcon = isCliLike ? <Terminal size={25} strokeWidth={2.2} /> : <Package size={26} />;
  const fallbackClassName = [
    "app-icon",
    "brew",
    isCaskItem ? "cask" : "formula",
    isCliLike ? "tool" : undefined
  ]
    .filter(Boolean)
    .join(" ");

  if (app) {
    return (
      <button
        className={
          iconDataURL
            ? "app-icon app-icon-image clickable-app-icon"
            : `${fallbackClassName} clickable-app-icon`
        }
        onClick={() => void window.baseline.openApp(app.id)}
        title="Open app"
        aria-label="Open app"
      >
        {iconDataURL ? <img src={iconDataURL} alt="" draggable={false} /> : fallbackIcon}
      </button>
    );
  }

  if (iconDataURL) {
    return (
      <div className="app-icon app-icon-image">
        <img src={iconDataURL} alt="" draggable={false} />
      </div>
    );
  }

  return <div className={fallbackClassName}>{fallbackIcon}</div>;
}

export function UpdateActionButton({
  state,
  onAction,
  readyLabel = "Update",
  disabled = false,
  readyVariant = "filled"
}: {
  state: ActionState;
  onAction: () => void;
  readyLabel?: string;
  disabled?: boolean;
  readyVariant?: "filled" | "outline";
}) {
  if (state.type === "ready") {
    return (
      <button
        className={
          readyVariant === "outline"
            ? "primary-button outline-button update-action-button"
            : "primary-button update-action-button"
        }
        disabled={disabled}
        onClick={onAction}
      >
        {readyLabel}
      </button>
    );
  }

  const isFailure = state.type === "failed";
  return (
    <button
      className={isFailure ? "destructive-icon-button" : "update-icon-button"}
      aria-label={actionStateLabel(state)}
      title={actionStateLabel(state)}
      disabled={disabled}
      onClick={(event) => event.preventDefault()}
      tabIndex={-1}
      type="button"
    >
      {state.type === "queued" ? (
        <ClockArrowDown size={14} />
      ) : state.type === "updating" ? (
        state.progress === undefined ? (
          <RefreshCcw className="spin" size={14} />
        ) : (
          <ProgressRing value={state.progress} />
        )
      ) : state.type === "done" ? (
        <DoneTransitionGlyph />
      ) : (
        <span className="failure-glyph">!</span>
      )}
    </button>
  );
}

function RowMoreActionButton({
  isIgnored,
  disabled,
  updateAction,
  onToggleIgnore,
  uninstallLabel,
  canUninstall = false,
  uninstalling = false,
  uninstallDisabled = false,
  onUninstall
}: {
  isIgnored: boolean;
  disabled?: boolean;
  updateAction?: RowUpdateMenuAction;
  onToggleIgnore: () => void;
  uninstallLabel: string;
  canUninstall?: boolean;
  uninstalling?: boolean;
  uninstallDisabled?: boolean;
  onUninstall: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPlacement, setPopoverPlacement] = useState<RowActionMenuPlacement>("below");
  const [floatingPopoverPosition, setFloatingPopoverPosition] =
    useState<RowActionMenuFloatingPosition>();
  const ignoreLabel = isIgnored ? "Unignore" : "Ignore";

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPlacement("below");
      setFloatingPopoverPosition(undefined);
      return undefined;
    }

    const updatePopoverPlacement = () => {
      const trigger = triggerRef.current;
      const clippingContainer =
        menuRef.current?.closest(".search-palette-results") ??
        menuRef.current?.closest(".search-palette");
      if (!trigger || !(clippingContainer instanceof HTMLElement)) {
        setPopoverPlacement("below");
        setFloatingPopoverPosition(undefined);
        return;
      }

      const triggerRect = trigger.getBoundingClientRect();
      const clippingRect = clippingContainer.getBoundingClientRect();
      const popoverRect = popoverRef.current?.getBoundingClientRect();
      const popoverWidth = popoverRect?.width || rowActionMenuEstimatedWidth;
      const popoverHeight =
        popoverRect?.height || rowActionMenuEstimatedHeight(updateAction, canUninstall);
      const viewportPadding = 8;
      const gap = 6;
      const availableBelow = clippingRect.bottom - triggerRect.bottom - gap - viewportPadding;
      const availableAbove = triggerRect.top - clippingRect.top - gap - viewportPadding;

      if (availableBelow >= popoverHeight) {
        setPopoverPlacement("below");
        setFloatingPopoverPosition(undefined);
        return;
      }

      if (availableAbove >= popoverHeight) {
        setPopoverPlacement("above");
        setFloatingPopoverPosition(undefined);
        return;
      }

      const preferredTop =
        availableBelow >= availableAbove
          ? triggerRect.bottom + gap
          : triggerRect.top - popoverHeight - gap;
      const maxTop = Math.max(
        viewportPadding,
        window.innerHeight - popoverHeight - viewportPadding
      );
      const maxLeft = Math.max(viewportPadding, window.innerWidth - popoverWidth - viewportPadding);
      setPopoverPlacement("floating");
      setFloatingPopoverPosition({
        left: Math.min(Math.max(viewportPadding, triggerRect.right - popoverWidth), maxLeft),
        top: Math.min(Math.max(viewportPadding, preferredTop), maxTop)
      });
    };

    updatePopoverPlacement();
    window.addEventListener("resize", updatePopoverPlacement);
    window.addEventListener("scroll", updatePopoverPlacement, true);
    return () => {
      window.removeEventListener("resize", updatePopoverPlacement);
      window.removeEventListener("scroll", updatePopoverPlacement, true);
    };
  }, [canUninstall, open, updateAction]);

  const invokeIgnore = () => {
    setOpen(false);
    onToggleIgnore();
  };

  const invokeUpdate = () => {
    if (!updateAction || updateAction.state.type !== "ready" || updateAction.disabled) {
      return;
    }

    setOpen(false);
    updateAction.onAction();
  };

  const invokeUninstall = () => {
    setOpen(false);
    onUninstall();
  };
  const isSearchPaletteRowMenu = Boolean(menuRef.current?.closest(".search-palette"));
  const popover = open ? (
    <div
      ref={popoverRef}
      className={rowActionMenuPopoverClassName(popoverPlacement)}
      data-search-palette-floating-row-menu={
        isSearchPaletteRowMenu && popoverPlacement === "floating" ? "true" : undefined
      }
      role="menu"
      style={
        popoverPlacement === "floating"
          ? floatingRowActionMenuStyle(floatingPopoverPosition)
          : undefined
      }
    >
      {updateAction && (
        <button
          onClick={invokeUpdate}
          role="menuitem"
          disabled={updateAction.disabled || updateAction.state.type !== "ready"}
        >
          {updateAction.state.type === "ready" ? (
            <Download size={14} />
          ) : updateAction.state.type === "queued" ? (
            <ClockArrowDown size={14} />
          ) : updateAction.state.type === "updating" ? (
            updateAction.state.progress === undefined ? (
              <RefreshCcw className="spin" size={14} />
            ) : (
              <ProgressRing value={updateAction.state.progress} />
            )
          ) : updateAction.state.type === "done" ? (
            <Check className="done-glyph" size={14} strokeWidth={3} />
          ) : (
            <span className="failure-glyph">!</span>
          )}
          <span>
            {updateAction.state.type === "ready" ? "Update" : actionStateLabel(updateAction.state)}
          </span>
        </button>
      )}
      <button onClick={invokeIgnore} role="menuitem" disabled={disabled}>
        {isIgnored ? <EyeOff size={14} /> : <Eye size={14} />}
        <span>{ignoreLabel}</span>
      </button>
      {canUninstall && (
        <button
          className="danger-menu-item"
          onClick={invokeUninstall}
          role="menuitem"
          disabled={uninstallDisabled}
        >
          {uninstalling ? <UninstallActionGlyph /> : <Trash2 size={14} />}
          <span>{uninstallLabel}</span>
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="row-action-menu" ref={menuRef}>
      <button
        ref={triggerRef}
        className="secondary-icon-button"
        disabled={disabled}
        onClick={() => setOpen((isOpen) => !isOpen)}
        title="Actions"
        aria-label="Actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {uninstalling ? <UninstallActionGlyph /> : <MoreHorizontal size={15} />}
      </button>
      {popoverPlacement === "floating" && popover ? createPortal(popover, document.body) : popover}
    </div>
  );
}

const rowActionMenuEstimatedWidth = 142;

function rowActionMenuPopoverClassName(placement: RowActionMenuPlacement): string {
  if (placement === "above") {
    return "row-action-menu-popover row-action-menu-popover-above";
  }
  if (placement === "floating") {
    return "row-action-menu-popover row-action-menu-popover-floating";
  }
  return "row-action-menu-popover";
}

function floatingRowActionMenuStyle(
  position: RowActionMenuFloatingPosition | undefined
): React.CSSProperties {
  return {
    left: position?.left ?? 0,
    top: position?.top ?? 0,
    visibility: position ? "visible" : "hidden"
  };
}

function rowActionMenuEstimatedHeight(
  updateAction: RowUpdateMenuAction | undefined,
  canUninstall: boolean
): number {
  const itemCount = 1 + (updateAction ? 1 : 0) + (canUninstall ? 1 : 0);
  return itemCount * 28 + 10;
}

function ProgressRing({ value }: { value: number }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(value, 1));
  return (
    <svg className="progress-ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="progress-ring-track" cx="8" cy="8" r={radius} />
      <circle
        className="progress-ring-value"
        cx="8"
        cy="8"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
      />
    </svg>
  );
}

function DoneTransitionGlyph() {
  return <Check className="done-glyph" size={15} strokeWidth={3} />;
}

function UninstallActionGlyph() {
  return <Trash2 className="uninstall-glyph" size={15} />;
}

function ActionConfirmationOverlay({
  confirmation,
  onCancel,
  onConfirm
}: {
  confirmation: ActionConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isDestructive = confirmation.type === "uninstall";
  const title =
    confirmation.type === "install"
      ? `Install ${confirmation.item.displayName}?`
      : `Uninstall ${confirmation.item.name}?`;
  const message =
    confirmation.type === "install"
      ? `This will run Homebrew and install ${confirmation.item.displayName} (${homebrewPresentationLabel(
          confirmation.item.kind,
          confirmation.item.presentation
        )} ${confirmation.item.token}) on your Mac.`
      : "This will fully delete the item from your Mac. Do you want to proceed?";
  const actionTitle =
    confirmation.type === "install"
      ? `Install ${confirmation.item.displayName}`
      : `Uninstall ${confirmation.item.name}`;

  return (
    <div className="confirmation-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="confirmation-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <h2 id="confirmation-title">{title}</h2>
          <p>{message}</p>
        </div>
        <div className="confirmation-actions">
          <button
            className={isDestructive ? "destructive-text-button" : "primary-button wide"}
            onClick={onConfirm}
          >
            {actionTitle}
          </button>
          <button className="ghost-button wide" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}

function actionStateFromFlags({
  failed,
  queued = false,
  updating,
  progress,
  done
}: {
  failed: boolean;
  queued?: boolean;
  updating: boolean;
  progress?: number;
  done: boolean;
}): ActionState {
  if (failed) {
    return { type: "failed" };
  }
  if (done) {
    return { type: "done" };
  }
  if (queued) {
    return { type: "queued" };
  }
  if (updating) {
    return progress === undefined ? { type: "updating" } : { type: "updating", progress };
  }
  return { type: "ready" };
}

function isHomebrewCommandActive(snapshot: BaselineSnapshot): boolean {
  return (
    snapshot.isHomebrewCommandLocked ||
    snapshot.isRunningHomebrewMaintenance ||
    snapshot.homebrewUpdatingItemIDs.length > 0 ||
    snapshot.homebrewUninstallingItemIDs.length > 0 ||
    snapshot.homebrewDiscoverInstallingItemIDs.length > 0
  );
}

function actionStateLabel(state: Exclude<ActionState, { type: "ready" }>): string {
  if (state.type === "updating") {
    return "Updating";
  }
  if (state.type === "queued") {
    return "Queued";
  }
  if (state.type === "done") {
    return "Updated";
  }
  return "Update failed";
}

function appUpdateActionState(
  app: AppRecord,
  snapshot: BaselineSnapshot
): { state: ActionState; isUpdating: boolean } {
  const update = snapshot.updates.find((candidate) => candidate.appID === app.id);
  const matchedHomebrewItem =
    update?.source === "homebrew" ? uninstallableHomebrewItemForApp(app, snapshot) : undefined;
  const isUpdating =
    snapshot.appUpdatingIDs.includes(app.id) ||
    Boolean(
      matchedHomebrewItem && snapshot.homebrewUpdatingItemIDs.includes(matchedHomebrewItem.id)
    );
  const queued = Boolean(
    matchedHomebrewItem && snapshot.homebrewQueuedItemIDs.includes(matchedHomebrewItem.id)
  );
  const progress =
    snapshot.homebrewFallbackProgressByAppID[app.id] ??
    (matchedHomebrewItem
      ? snapshot.homebrewBatchProgressByItemID[matchedHomebrewItem.id]
      : undefined);
  const failed =
    snapshot.homebrewFallbackFailedAppIDs.includes(app.id) ||
    Boolean(
      matchedHomebrewItem && snapshot.homebrewBatchFailedItemIDs.includes(matchedHomebrewItem.id)
    );
  const done =
    snapshot.appUpdatedPendingRefreshIDs.includes(app.id) ||
    Boolean(
      matchedHomebrewItem &&
      snapshot.homebrewUpdatedPendingRefreshItemIDs.includes(matchedHomebrewItem.id)
    );

  return {
    isUpdating,
    state: actionStateFromFlags({
      failed,
      queued,
      updating: isUpdating,
      progress,
      done
    })
  };
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
          <div>
            <h1>{selectedItem?.label ?? "Settings"}</h1>
          </div>
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
              />
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
            <PanelTitle title="Menu Bar" />
            <div className="settings-panel-box">
              <Toggle
                label="Show menu bar icon"
                description="Keep the compact update popover available in the menu bar."
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
          <PanelTitle title="Source mix" />
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
                        {profileSourcePercentLabel(source, sourceMixTotal)}
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
                      <strong>{source.count}</strong>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="profile-empty-state">
                Update or install something with Baseline to build a source history.
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
      <section className="panel settings-panel profile-footer-panel">
        <div className="settings-panel-box">
          {shouldShowResetWarning && (
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
          )}
          <div className="settings-row profile-footer-row">
            <span className="profile-footer-text">
              Only updates and installs completed with Baseline are counted. Stats stay private on
              this Mac.
            </span>
          </div>
        </div>
      </section>
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

type TogglePatch = Exclude<
  keyof Parameters<typeof window.baseline.updatePreferences>[0],
  "selectedTab" | "refreshIntervalMinutes" | "appearancePreference"
>;

const appearanceOptions: Array<{
  value: AppearancePreference;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
}> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon }
];

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

function defaultScanDirectoryLabel(directory: string): string {
  if (directory === "/Applications") {
    return "System Applications";
  }
  return "User Applications";
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

function clampRefreshIntervalMinutes(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 5), 1440);
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

function PanelTitle({
  title,
  action,
  canCollapse = false,
  collapsed = false,
  onToggleCollapse
}: {
  title: string;
  action?: React.ReactNode;
  canCollapse?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const label = sectionTitleLabel(title);
  return (
    <div className="panel-title">
      {canCollapse ? (
        <button
          className="section-toggle"
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
          title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
        >
          <span>{label}</span>
          <ChevronRight size={13} className={collapsed ? "" : "expanded"} />
        </button>
      ) : (
        <h2>{label}</h2>
      )}
      {action}
    </div>
  );
}

function sectionTitleLabel(title: string): string {
  const match = /^(?<label>.+?)\s+\((?<count>\d+)\)$/u.exec(title);
  return match?.groups?.label ?? title;
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

function VersionChange({ from, to }: { from: string; to: string }) {
  return (
    <>
      <span className="version-token">{from}</span>
      <span className="version-arrow">→</span>
      <span className="version-token">{to}</span>
    </>
  );
}

function appUpdateVersionChange(update: UpdateRecord): { from: string; to: string } {
  if (shouldShowAppBuildVersion(update)) {
    return {
      from: versionLabelWithBuild(update.localVersion.raw, update.localBuildVersion?.raw),
      to: versionLabelWithBuild(update.remoteVersion.raw, update.remoteBuildVersion?.raw)
    };
  }
  return {
    from: update.localVersion.raw || "unknown",
    to: update.remoteVersion.raw || "unknown"
  };
}

function shouldShowAppBuildVersion(update: UpdateRecord): boolean {
  return Boolean(
    update.localBuildVersion?.raw.trim() &&
    update.remoteBuildVersion?.raw.trim() &&
    compareVersions(update.localVersion, update.remoteVersion) === 0 &&
    compareVersions(update.localBuildVersion, update.remoteBuildVersion) !== 0
  );
}

function versionLabelWithBuild(versionRaw: string, buildRaw?: string): string {
  const displayVersion = versionRaw.trim() || "unknown";
  const buildVersion = buildRaw?.trim();
  return buildVersion ? `${displayVersion} (${buildVersion})` : displayVersion;
}

function ToolStatus({
  label,
  description,
  missingDetail,
  ready,
  enabled = true
}: {
  label: string;
  description: string;
  missingDetail: string;
  ready: boolean;
  enabled?: boolean;
}) {
  const active = ready && enabled;
  const statusLabel = ready ? (enabled ? "Enabled" : "Not used") : "Not detected";
  const detail = ready ? description : `${description} ${missingDetail}`;
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

type ProfileSummary = {
  differentApps: number;
  discoverInstalls: number;
  totalUpdates: number;
  startedUsing: {
    relativeLabel: string;
    dateLabel: string;
  };
  favoriteChannelLabel: string;
  sourceMix: Array<{
    channel: ProfileStatsChannel;
    label: string;
    count: number;
  }>;
  topApps: Array<{
    targetID: string;
    displayName: string;
    count: number;
    iconDataURL?: string;
    rank: number;
  }>;
  topHomebrewItems: Array<{
    targetID: string;
    displayName: string;
    count: number;
    kindLabel: string;
    rank: number;
  }>;
};

function buildProfileSummary(snapshot: BaselineSnapshot): ProfileSummary {
  const events = snapshot.profileStats.events;
  const sourceMix = buildProfileSourceMix(events);
  const favorite = sourceMix.reduce((best, item) => (item.count > best.count ? item : best));
  const topApps = buildTopUpdatedApps(events, snapshot.apps);
  const topHomebrewItems = buildTopUpdatedHomebrewItems(
    events,
    snapshot.homebrewItems,
    snapshot.apps,
    snapshot.updates
  );
  const totalUpdates = events.filter(
    (event) => event.type === "appUpdate" || event.type === "homebrewUpdate"
  ).length;
  const differentApps = new Set(
    events.filter((event) => event.type === "appUpdate").map((event) => event.targetID)
  ).size;
  const discoverInstalls = events.filter((event) => event.type === "homebrewInstall").length;
  const favoriteChannelLabel = favorite.count > 0 ? favorite.label : "No history";
  return {
    differentApps,
    discoverInstalls,
    totalUpdates,
    startedUsing: startedUsingSummary(snapshot.profileStats.startedUsingAt),
    favoriteChannelLabel,
    sourceMix,
    topApps,
    topHomebrewItems
  };
}

function profileSourceClass(channel: ProfileStatsChannel): string {
  if (channel === "appStore") return "source-app-store";
  if (channel === "sparkle") return "source-sparkle";
  if (channel === "homebrew") return "source-homebrew";
  if (channel === "web") return "source-web";
  return "source-unknown";
}

function profileSourceShareLabel(
  source: ProfileSummary["sourceMix"][number],
  total: number
): string {
  if (total <= 0) {
    return `${source.label}: no recorded events`;
  }
  const percent = Math.round((source.count / total) * 100);
  return `${source.label}: ${source.count} event${source.count === 1 ? "" : "s"} (${percent}%)`;
}

function profileSourcePercentLabel(
  source: ProfileSummary["sourceMix"][number],
  total: number
): string {
  if (total <= 0) {
    return `${source.label} 0%`;
  }
  return `${source.label} ${Math.round((source.count / total) * 100)}%`;
}

function buildProfileSourceMix(events: ProfileStatsEvent[]): ProfileSummary["sourceMix"] {
  const channels: ProfileStatsChannel[] = ["appStore", "sparkle", "homebrew", "web", "unknown"];
  const counts = new Map<ProfileStatsChannel, number>(channels.map((channel) => [channel, 0]));
  for (const event of events) {
    counts.set(event.channel, (counts.get(event.channel) ?? 0) + 1);
  }
  return channels
    .map((channel) => ({
      channel,
      label: sourceDisplayName(channel),
      count: counts.get(channel) ?? 0
    }))
    .sort((first, second) => second.count - first.count || first.label.localeCompare(second.label));
}

function buildTopUpdatedApps(
  events: ProfileStatsEvent[],
  apps: AppRecord[]
): ProfileSummary["topApps"] {
  const appByID = new Map(apps.map((app) => [app.id, app]));
  const counts = new Map<
    string,
    { targetID: string; displayName: string; count: number; iconDataURL?: string; rank: number }
  >();
  for (const event of events) {
    if (event.type !== "appUpdate") {
      continue;
    }
    const current = counts.get(event.targetID);
    const app = appByID.get(event.targetID);
    counts.set(event.targetID, {
      targetID: event.targetID,
      displayName: app?.displayName ?? event.displayName,
      count: (current?.count ?? 0) + 1,
      iconDataURL: app?.iconDataURL,
      rank: 0
    });
  }
  return [...counts.values()]
    .sort(
      (first, second) =>
        second.count - first.count || first.displayName.localeCompare(second.displayName)
    )
    .slice(0, 3)
    .map((app, index) => ({ ...app, rank: index + 1 }));
}

function buildTopUpdatedHomebrewItems(
  events: ProfileStatsEvent[],
  homebrewItems: HomebrewManagedItem[],
  apps: AppRecord[],
  updates: UpdateRecord[]
): ProfileSummary["topHomebrewItems"] {
  const itemsByID = new Map(homebrewItems.map((item) => [item.id, item]));
  const updatesByAppID = new Map(updates.map((update) => [update.appID, update]));
  const counts = new Map<
    string,
    {
      targetID: string;
      displayName: string;
      count: number;
      kindLabel: string;
      rank: number;
    }
  >();
  for (const event of events) {
    if (event.type !== "homebrewUpdate") {
      continue;
    }
    const item = itemsByID.get(event.targetID);
    if (!isProfileHomebrewToolEvent(event, item, apps, updatesByAppID)) {
      continue;
    }
    const current = counts.get(event.targetID);
    counts.set(event.targetID, {
      targetID: event.targetID,
      displayName: item?.name ?? event.displayName,
      count: (current?.count ?? 0) + 1,
      kindLabel: profileHomebrewKindLabel(event, item),
      rank: 0
    });
  }
  return [...counts.values()]
    .sort(
      (first, second) =>
        second.count - first.count || first.displayName.localeCompare(second.displayName)
    )
    .slice(0, 3)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function isProfileHomebrewToolEvent(
  event: ProfileStatsEvent,
  item: HomebrewManagedItem | undefined,
  apps: AppRecord[],
  updatesByAppID: Map<string, UpdateRecord>
): boolean {
  if (item?.kind === "formula" || event.targetID.startsWith("formula:")) {
    return true;
  }
  if (!item) {
    return false;
  }
  if (homebrewItemHasAppRepresentation(item, apps, updatesByAppID)) {
    return false;
  }
  if (item.presentation === "app") {
    return false;
  }
  return Boolean(item.presentation);
}

function profileHomebrewKindLabel(
  event: ProfileStatsEvent,
  item: HomebrewManagedItem | undefined
): string {
  if (item?.presentation) {
    return homebrewPresentationLabel(item.kind, item.presentation);
  }
  if (item?.kind === "formula" || event.targetID.startsWith("formula:")) {
    return "Formula";
  }
  return "Tool";
}

function startedUsingSummary(createdAt: string): ProfileSummary["startedUsing"] {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) {
    return {
      relativeLabel: "Today",
      dateLabel: "Since today"
    };
  }
  const createdDate = new Date(created);
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  const exactDate = dateFormatter.format(createdDate);
  const startOfCreatedDay = new Date(createdDate);
  startOfCreatedDay.setHours(0, 0, 0, 0);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const elapsedDays = Math.max(
    0,
    Math.floor((startOfToday.getTime() - startOfCreatedDay.getTime()) / 86_400_000)
  );
  const relativeLabel =
    elapsedDays === 0 ? "Today" : `${elapsedDays} day${elapsedDays === 1 ? "" : "s"}`;
  return {
    relativeLabel,
    dateLabel: `Since ${exactDate}`
  };
}

function sourceLabel(update: UpdateRecord): string {
  if (update.source === "appStore") return "App Store";
  if (update.source === "sparkle") return "Sparkle";
  if (update.source === "homebrew") return "Homebrew";
  return "Update";
}

function appSourceLabel(
  app: AppRecord,
  snapshot: BaselineSnapshot,
  recentRecord?: RecentlyUpdatedRecord
): string | undefined {
  const update = snapshot.updates.find((candidate) => candidate.appID === app.id);
  if (update) {
    if (
      update.source === "homebrew" &&
      app.sourceHint === "sparkle" &&
      !uninstallableHomebrewItemForApp(app, snapshot)
    ) {
      return sourceDisplayName(app.sourceHint);
    }
    return sourceLabel(update);
  }

  if (recentRecord?.source && recentRecord.source !== "unknown") {
    if (recentRecord.source === "homebrew") {
      const uninstallableItem = uninstallableHomebrewItemForApp(app, snapshot);
      if (uninstallableItem?.presentation && uninstallableItem.presentation !== "app") {
        return homebrewItemLabel(uninstallableItem);
      }
    }
    return sourceDisplayName(recentRecord.source);
  }

  const uninstallableItem = uninstallableHomebrewItemForApp(app, snapshot);
  if (uninstallableItem) {
    return uninstallableItem.presentation === "app" || uninstallableItem.appID === app.id
      ? "Homebrew"
      : homebrewItemLabel(uninstallableItem);
  }

  return app.sourceHint === "unknown" ? undefined : sourceDisplayName(app.sourceHint);
}

function homebrewItemLabel(item: HomebrewManagedItem, appCaskLabel?: string): string {
  if (item.presentation === "app" && appCaskLabel) {
    return appCaskLabel;
  }
  return homebrewPresentationLabel(item.kind, item.presentation);
}

function selectedTabTitle(tab: MenuTab): string {
  if (tab === "all") return "All";
  if (tab === "apps") return "Apps";
  if (tab === "installed") return "Installed";
  if (tab === "ignored") return "Ignored";
  return "Homebrew";
}

function updatedRelativeLabel(updatedAt: string, now = Date.now()): string {
  const updatedTime = new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedTime)) {
    return "Updated recently";
  }

  const days = Math.max(0, Math.floor((now - updatedTime) / 86_400_000));
  if (days === 0) {
    return "Updated today";
  }
  return `Updated ${days} ${days === 1 ? "day" : "days"} ago`;
}

function compareRecentRows(
  lhs: { updatedAt: string; id: string },
  rhs: { updatedAt: string; id: string }
): number {
  const lhsTime = new Date(lhs.updatedAt).getTime();
  const rhsTime = new Date(rhs.updatedAt).getTime();
  const lhsSafeTime = Number.isFinite(lhsTime) ? lhsTime : 0;
  const rhsSafeTime = Number.isFinite(rhsTime) ? rhsTime : 0;
  if (lhsSafeTime !== rhsSafeTime) {
    return rhsSafeTime - lhsSafeTime;
  }
  return lhs.id.localeCompare(rhs.id);
}

function combinedAvailableCount(derived: DerivedSections): number {
  return derived.availableApps.length + derived.allHomebrewOutdated.length;
}

function performHomebrewUpdateAllForItems(items: Pick<HomebrewManagedItem, "id">[]): void {
  void window.baseline.performHomebrewUpdateAll(items.map((item) => item.id));
}

function toggleCollapsedSection(
  kind: "app" | "homebrew",
  sectionID: string,
  snapshot: BaselineSnapshot
): void {
  const key = kind === "app" ? "collapsedAppSectionIDs" : "collapsedHomebrewSectionIDs";
  const values = new Set(snapshot[key]);
  if (values.has(sectionID)) {
    values.delete(sectionID);
  } else {
    values.add(sectionID);
  }
  void window.baseline.updatePreferences({ [key]: [...values].sort() });
}

type DerivedSections = ReturnType<typeof deriveSections>;

function deriveSections(snapshot: BaselineSnapshot) {
  const term = snapshot.searchText.trim().toLowerCase();
  const updatesByAppID = new Map(snapshot.updates.map((update) => [update.appID, update]));
  const appByID = new Map(snapshot.apps.map((app) => [app.id, app]));
  const appFilter = (app: AppRecord) =>
    !term ||
    app.displayName.toLowerCase().includes(term) ||
    app.bundleIdentifier?.toLowerCase().includes(term);
  const homebrewFilter = (item: HomebrewManagedItem) =>
    !term ||
    item.name.toLowerCase().includes(term) ||
    item.token.toLowerCase().includes(term) ||
    item.installedVersion.raw.toLowerCase().includes(term) ||
    item.latestVersion?.raw.toLowerCase().includes(term);

  const availableApps = snapshot.apps
    .filter((app) => updatesByAppID.has(app.id) && !snapshot.ignoredIDs.includes(app.id))
    .filter(appFilter)
    .sort((lhs, rhs) => sortByUpdateDate(lhs, rhs, updatesByAppID));
  const installedApps = snapshot.apps
    .filter((app) => !updatesByAppID.has(app.id) && !snapshot.ignoredIDs.includes(app.id))
    .filter((app) => !uninstallableHomebrewItemForApp(app, snapshot))
    .filter(appFilter)
    .sort(sortByName);
  const ignoredApps = snapshot.apps
    .filter((app) => snapshot.ignoredIDs.includes(app.id))
    .filter(appFilter)
    .sort(sortByName);
  const recentlyUpdatedApps = snapshot.recentlyUpdated
    .map((record) => appByID.get(record.appID))
    .filter((app): app is AppRecord => {
      if (!app) {
        return false;
      }
      return !snapshot.ignoredIDs.includes(app.id) && !updatesByAppID.has(app.id);
    })
    .filter(appFilter);

  const homebrewOutdated = snapshot.homebrewItems
    .filter((item) => item.isOutdated && !snapshot.ignoredHomebrewItemIDs.includes(item.id))
    .filter(homebrewFilter)
    .sort(sortHomebrewOutdated);
  const ignoredAppsUnfiltered = snapshot.apps.filter((app) => snapshot.ignoredIDs.includes(app.id));
  const appsRepresentedOutsideHomebrew = term
    ? [...availableApps, ...ignoredAppsUnfiltered]
    : snapshot.apps.filter(
        (app) => updatesByAppID.has(app.id) || snapshot.ignoredIDs.includes(app.id)
      );
  const allHomebrewOutdated = homebrewOutdated.filter(
    (item) =>
      !homebrewItemHasAppRepresentation(item, appsRepresentedOutsideHomebrew, updatesByAppID)
  );
  const homebrewInstalled = snapshot.homebrewItems
    .filter((item) => !item.isOutdated && !snapshot.ignoredHomebrewItemIDs.includes(item.id))
    .filter(homebrewFilter)
    .sort(sortHomebrewInstalled);
  const homebrewIgnored = snapshot.homebrewItems
    .filter((item) => snapshot.ignoredHomebrewItemIDs.includes(item.id))
    .filter(homebrewFilter)
    .sort(sortHomebrewInstalled);
  const recentlyIDs = new Set(snapshot.homebrewRecentlyUpdated.map((record) => record.itemID));
  const homebrewRecentlyUpdated = homebrewInstalled.filter((item) => recentlyIDs.has(item.id));

  return {
    availableApps,
    installedApps,
    ignoredApps,
    recentlyUpdatedApps,
    homebrewOutdated,
    allHomebrewOutdated,
    homebrewInstalled,
    homebrewIgnored,
    homebrewRecentlyUpdated
  };
}

function matchingAppForHomebrewItem(
  item: Pick<HomebrewManagedItem, "kind" | "token"> &
    Partial<
      Pick<HomebrewManagedItem, "appID" | "name" | "presentation"> &
        Pick<HomebrewCaskDiscoveryItem, "displayName">
    >,
  snapshot: BaselineSnapshot
): AppRecord | undefined {
  if (!isCask(item.kind)) {
    return undefined;
  }
  const appFromExplicitLink = item.appID
    ? snapshot.apps.find((app) => app.id === item.appID)
    : undefined;
  if (appFromExplicitLink) {
    return appFromExplicitLink;
  }

  const identifiers = homebrewItemIdentifiers(item);
  const matchingUpdate = snapshot.updates.find(
    (update) =>
      update.homebrewToken && identifiers.has(normalizedHomebrewAppName(update.homebrewToken))
  );
  const appFromUpdate = matchingUpdate
    ? snapshot.apps.find((app) => app.id === matchingUpdate.appID)
    : undefined;
  if (appFromUpdate?.sourceHint === "sparkle") {
    return undefined;
  }
  if (appFromUpdate?.iconDataURL) {
    return appFromUpdate;
  }

  return appFromUpdate;
}

function uninstallableHomebrewItemForApp(
  app: AppRecord,
  snapshot: BaselineSnapshot
): HomebrewManagedItem | undefined {
  const matchedByExplicitLink = snapshot.homebrewItems.find(
    (item) => item.kind === "cask" && item.appID === app.id
  );
  if (matchedByExplicitLink) {
    return matchedByExplicitLink;
  }
  if (app.sourceHint === "sparkle") {
    return undefined;
  }

  const update = snapshot.updates.find((candidate) => candidate.appID === app.id);
  if (update?.homebrewToken) {
    const token = normalizedHomebrewAppName(update.homebrewToken);
    const matchedByUpdate = snapshot.homebrewItems.find(
      (item) => item.kind === "cask" && normalizedHomebrewAppName(item.token) === token
    );
    if (matchedByUpdate) {
      return matchedByUpdate;
    }
  }

  return undefined;
}

function sortByName(lhs: AppRecord, rhs: AppRecord): number {
  return lhs.displayName.localeCompare(rhs.displayName, undefined, { sensitivity: "base" });
}

function sortByUpdateDate(
  lhs: AppRecord,
  rhs: AppRecord,
  updatesByAppID: Map<string, UpdateRecord>
): number {
  const left = new Date(
    updatesByAppID.get(lhs.id)?.releaseDate ?? updatesByAppID.get(lhs.id)?.checkedAt ?? 0
  ).getTime();
  const right = new Date(
    updatesByAppID.get(rhs.id)?.releaseDate ?? updatesByAppID.get(rhs.id)?.checkedAt ?? 0
  ).getTime();
  return right - left || sortByName(lhs, rhs);
}

function sortHomebrewOutdated(lhs: HomebrewManagedItem, rhs: HomebrewManagedItem): number {
  const left = new Date(lhs.releaseDate ?? 0).getTime();
  const right = new Date(rhs.releaseDate ?? 0).getTime();
  return right - left || lhs.name.localeCompare(rhs.name, undefined, { sensitivity: "base" });
}

function sortHomebrewInstalled(lhs: HomebrewManagedItem, rhs: HomebrewManagedItem): number {
  return (
    lhs.kind.localeCompare(rhs.kind) ||
    lhs.name.localeCompare(rhs.name, undefined, { sensitivity: "base" })
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

export { ActionConfirmationContext, actionStateFromFlags, uninstallableHomebrewItemForApp };
export type { ActionConfirmation, ActionState };
