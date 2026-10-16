// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  AppWindowMac,
  Beer,
  CheckCircle2,
  Download,
  EyeOff,
  RefreshCcw,
  Search,
  Server,
  Settings
} from "lucide-react";
import type { BaselineSnapshot, MenuTab } from "../../shared/domain";
import { deriveSections, type DerivedSections, combinedAvailableCount } from "../helpers/sections";
import type { ActionConfirmation } from "../types";
import {
  clearCompactPopoverControlFocus,
  setElementInert,
  suppressCompactPopoverControlFocus
} from "../helpers/focus";
import { ToolbarSearch, SearchPalette } from "./Search";
import { toolbarIconStrokeWidth, sidebarIconStrokeWidth } from "../constants";
import { OperationFailures } from "./OperationFailures";
import { SelectedTabContent } from "./DashboardContent";
import { selectedTabTitle } from "../helpers/labels";
import { ActionConfirmationContext, ActionConfirmationOverlay } from "./ActionConfirmation";

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

export function Sidebar({
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

export function SidebarBadge({ count }: { count: number }) {
  return count > 0 ? <strong>{count}</strong> : null;
}

export function SelfUpdateToolbarButton({ releaseURL }: { releaseURL: string }) {
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
