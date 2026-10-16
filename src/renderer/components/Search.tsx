// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { baseline } from "../ipc";
import React, { useEffect, useRef } from "react";
import { Search, X } from "lucide-react";
import type { BaselineSnapshot } from "../../shared/domain";
import { toolbarIconStrokeWidth } from "../constants";
import { type DerivedSections, uninstallableHomebrewItemForApp } from "../helpers/sections";
import { hasOpenNestedMenu, trapFocusWithin } from "../helpers/focus";
import { DiscoverRow, AppRow, HomebrewRow } from "./ItemViews";

export function ToolbarSearch({
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
    void baseline.setSearchText("");
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
          onChange={(event) => void baseline.setSearchText(event.currentTarget.value)}
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

export function SearchPalette({
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

export function SearchField({
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
    void baseline.setSearchText("");
    inputRef.current?.focus();
  };

  return (
    <div className="search-box search-palette-field">
      <Search size={15} strokeWidth={toolbarIconStrokeWidth} />
      <input
        ref={inputRef}
        value={snapshot.searchText}
        onChange={(event) => void baseline.setSearchText(event.currentTarget.value)}
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

export function SearchPaletteResults({
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

export function SearchPaletteSection({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="search-palette-section">
      <h2>{title}</h2>
      <div className="rows">{children}</div>
    </section>
  );
}
