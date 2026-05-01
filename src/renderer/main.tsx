import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  AppWindow,
  Beer,
  Check,
  CheckCircle2,
  ChevronRight,
  Eye,
  EyeOff,
  ExternalLink,
  FolderPlus,
  Package,
  RefreshCcw,
  Search,
  Settings,
  Trash2,
  XCircle
} from "lucide-react";
import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  MenuTab,
  UpdateRecord
} from "../shared/domain";
import { defaultPersistedSnapshot } from "../shared/domain";
import "./styles.css";

type Route = "main" | "menubar" | "settings";
type ActionState =
  | { type: "ready" }
  | { type: "updating"; progress?: number }
  | { type: "done" }
  | { type: "failed" };
type ActionConfirmation =
  | { type: "install"; item: HomebrewCaskDiscoveryItem }
  | { type: "uninstall"; item: HomebrewManagedItem };
type RequestActionConfirmation = (confirmation: ActionConfirmation) => void;

const ActionConfirmationContext = React.createContext<RequestActionConfirmation>(() => {});

const initialSnapshot: BaselineSnapshot = {
  ...defaultPersistedSnapshot(),
  isMasInstalled: false,
  isHomebrewInstalled: false,
  isChecking: true,
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
  laggingHomebrewCaskTokens: []
};

function App() {
  const [snapshot, setSnapshot] = useState<BaselineSnapshot>(initialSnapshot);
  const [route, setRoute] = useState<Route>(currentRoute());

  useEffect(() => {
    void window.baseline.getSnapshot().then(setSnapshot);
    return window.baseline.onSnapshotChanged(setSnapshot);
  }, []);

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
      onOpenSettings={() => {
        if (route === "menubar") {
          void window.baseline.showSettings();
        } else {
          window.location.hash = "/settings";
        }
      }}
    />
  );
}

export function Dashboard({
  snapshot,
  compact,
  onOpenSettings
}: {
  snapshot: BaselineSnapshot;
  compact: boolean;
  onOpenSettings: () => void;
}) {
  const derived = useMemo(() => deriveSections(snapshot), [snapshot]);
  const selectedTab = snapshot.selectedTab;
  const [toolbarSearchOpen, setToolbarSearchOpen] = useState(Boolean(snapshot.searchText));
  const [actionConfirmation, setActionConfirmation] = useState<ActionConfirmation>();

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

  let shell: React.ReactNode;
  if (compact) {
    const compactTitle = selectedTabTitle(selectedTab);
    shell = (
      <main className="app-shell compact">
        <header className="popover-titlebar">
          <div>
            <h1>Baseline</h1>
            <p>
              {snapshot.isRefreshing
                ? "Checking updates"
                : selectedTab === "all"
                  ? `${combinedAvailableCount(derived)} available`
                  : selectedTab === "installed"
                    ? `${combinedInstalledCount(derived)} installed`
                    : `${compactTitle} updates`}
            </p>
          </div>
          <div className="topbar-actions">
            <button
              className="toolbar-button refresh-button"
              onClick={() => void window.baseline.refresh(false)}
              title="Refresh"
            >
              <RefreshCcw className={snapshot.isRefreshing ? "spin" : undefined} size={15} />
            </button>
            <button className="toolbar-button" onClick={onOpenSettings} title="Settings">
              <Settings size={15} />
            </button>
          </div>
        </header>
        <CommandBar snapshot={snapshot} selectedTab={selectedTab} showTabs />
        <section className="content single">
          <SelectedTabContent snapshot={snapshot} derived={derived} compact={compact} />
        </section>
      </main>
    );
  } else {
    const title = selectedTabTitle(selectedTab);
    shell = (
      <main className="app-shell">
        <Sidebar snapshot={snapshot} derived={derived} route="main" />
        <section className="workspace">
          <header className="topbar">
            <div>
              <h1>{title}</h1>
            </div>
            <div className="topbar-actions">
              <ToolbarSearch
                open={toolbarSearchOpen}
                snapshot={snapshot}
                onToggle={() => setToolbarSearchOpen((open) => !open)}
              />
              <button
                className="toolbar-button refresh-button"
                onClick={() => void window.baseline.refresh(false)}
                title="Refresh"
              >
                <RefreshCcw className={snapshot.isRefreshing ? "spin" : undefined} size={16} />
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
            <SelectedTabContent snapshot={snapshot} derived={derived} compact={compact} />
          </section>
        </section>
      </main>
    );
  }

  return (
    <ActionConfirmationContext.Provider value={setActionConfirmation}>
      <div
        className={actionConfirmation ? "action-surface action-surface-disabled" : "action-surface"}
        aria-hidden={actionConfirmation ? true : undefined}
      >
        {shell}
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
  route
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
  route: "main" | "settings";
}) {
  return (
    <aside className="sidebar">
      <nav className="source-list">
        <button
          className={route === "main" && snapshot.selectedTab === "all" ? "selected" : ""}
          onClick={() => {
            window.location.hash = "/main";
            void window.baseline.setSelectedTab("all");
          }}
        >
          <AppWindow size={16} />
          <span>All</span>
          <strong>{combinedAvailableCount(derived)}</strong>
        </button>
        <button
          className={route === "main" && snapshot.selectedTab === "apps" ? "selected" : ""}
          onClick={() => {
            window.location.hash = "/main";
            void window.baseline.setSelectedTab("apps");
          }}
        >
          <Package size={16} />
          <span>Applications</span>
          <strong>{derived.availableApps.length}</strong>
        </button>
        <button
          className={route === "main" && snapshot.selectedTab === "homebrew" ? "selected" : ""}
          onClick={() => {
            window.location.hash = "/main";
            void window.baseline.setSelectedTab("homebrew");
          }}
        >
          <Beer size={16} />
          <span>Homebrew</span>
          <strong>{derived.homebrewOutdated.length}</strong>
        </button>
        <button
          className={route === "main" && snapshot.selectedTab === "installed" ? "selected" : ""}
          onClick={() => {
            window.location.hash = "/main";
            void window.baseline.setSelectedTab("installed");
          }}
        >
          <CheckCircle2 size={16} />
          <span>Installed</span>
          <strong>{combinedInstalledCount(derived)}</strong>
        </button>
      </nav>
      <div className="sidebar-footer">
        <button
          className={route === "settings" ? "selected" : ""}
          onClick={() => (window.location.hash = "/settings")}
        >
          <Settings size={16} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

function ToolbarSearch({
  open,
  snapshot,
  onToggle
}: {
  open: boolean;
  snapshot: BaselineSnapshot;
  onToggle: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  return (
    <div className={open ? "toolbar-search open" : "toolbar-search"}>
      <div className="toolbar-search-field">
        <input
          ref={inputRef}
          value={snapshot.searchText}
          onChange={(event) => void window.baseline.setSearchText(event.currentTarget.value)}
          placeholder={searchPlaceholder()}
          tabIndex={open ? 0 : -1}
          aria-hidden={!open}
        />
      </div>
      <button
        className="toolbar-button"
        onClick={onToggle}
        title={open ? "Close Search" : "Search"}
      >
        <Search size={16} />
      </button>
    </div>
  );
}

function CommandBar({
  snapshot,
  selectedTab,
  showTabs = false
}: {
  snapshot: BaselineSnapshot;
  selectedTab: MenuTab;
  showTabs?: boolean;
}) {
  return (
    <section className={showTabs ? "command-row" : "command-row search-only"}>
      <label className="search-box">
        <Search size={15} />
        <input
          value={snapshot.searchText}
          onChange={(event) => void window.baseline.setSearchText(event.currentTarget.value)}
          placeholder={searchPlaceholder()}
        />
      </label>
      {showTabs && <SegmentedTabs selectedTab={selectedTab} />}
    </section>
  );
}

function SegmentedTabs({ selectedTab }: { selectedTab: MenuTab }) {
  return (
    <div className="segmented" role="tablist">
      {(["all", "apps", "homebrew", "installed"] as MenuTab[]).map((tab) => (
        <button
          key={tab}
          className={selectedTab === tab ? "selected" : ""}
          onClick={() => void window.baseline.setSelectedTab(tab)}
        >
          {tab === "all"
            ? "All"
            : tab === "apps"
              ? "Apps"
              : tab === "homebrew"
                ? "Homebrew"
                : "Installed"}
        </button>
      ))}
    </div>
  );
}

function SelectedTabContent({
  snapshot,
  derived,
  compact
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
  compact: boolean;
}) {
  if (snapshot.searchText.trim()) {
    return snapshot.selectedTab === "installed" ? (
      <InstalledTab snapshot={snapshot} derived={derived} compact={compact} />
    ) : (
      <AllTab snapshot={snapshot} derived={derived} />
    );
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

function AllTab({ snapshot, derived }: { snapshot: BaselineSnapshot; derived: DerivedSections }) {
  const isSearching = Boolean(snapshot.searchText.trim());
  return (
    <div className="stack">
      {isSearching && <DiscoverSection snapshot={snapshot} />}
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
      {snapshot.showRecentlyUpdatedAppsSection && (
        <AppSection
          sectionID="recentlyUpdated"
          collapsible
          title="Recently Updated Apps"
          apps={derived.recentlyUpdatedApps}
          snapshot={snapshot}
          empty="No recently updated apps yet."
          recentlyUpdated
        />
      )}
      {snapshot.showRecentlyUpdatedHomebrewSection && (
        <HomebrewSection
          sectionID="recentlyUpdated"
          collapsible
          title="Recently Updated Homebrew"
          items={derived.homebrewRecentlyUpdated}
          snapshot={snapshot}
          empty="No recently updated Homebrew items yet."
          recentlyUpdated
        />
      )}
    </div>
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
      />
      {snapshot.showRecentlyUpdatedAppsSection && (
        <AppSection
          sectionID="recentlyUpdated"
          collapsible
          title="Recently Updated"
          apps={derived.recentlyUpdatedApps}
          snapshot={snapshot}
          empty="No recently updated apps yet."
          recentlyUpdated
        />
      )}
      {snapshot.showIgnoredAppsSection && (
        <AppSection
          sectionID="ignored"
          collapsible
          title={`Ignored (${derived.ignoredApps.length})`}
          apps={derived.ignoredApps}
          snapshot={snapshot}
          empty="No ignored apps."
        />
      )}
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
  collapsible = false
}: {
  sectionID: string;
  title: string;
  apps: AppRecord[];
  snapshot: BaselineSnapshot;
  empty: string;
  recentlyUpdated?: boolean;
  collapsible?: boolean;
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
  const update = snapshot.updates.find((candidate) => candidate.appID === app.id);
  const isUpdating = snapshot.appUpdatingIDs.includes(app.id);
  const isIgnored = snapshot.ignoredIDs.includes(app.id);
  const progress = snapshot.homebrewFallbackProgressByAppID[app.id];
  const failed = snapshot.homebrewFallbackFailedAppIDs.includes(app.id);
  const done = snapshot.appUpdatedPendingRefreshIDs.includes(app.id);
  const uninstallableItem = uninstallableHomebrewItemForApp(app, snapshot);
  const isUninstalling = uninstallableItem
    ? snapshot.homebrewUninstallingItemIDs.includes(uninstallableItem.id)
    : false;
  const actionState = actionStateFromFlags({
    failed,
    updating: isUpdating,
    progress,
    done
  });
  const recentlyUpdatedAt = recentlyUpdated
    ? snapshot.recentlyUpdated.find((record) => record.appID === app.id)?.updatedAt
    : undefined;

  return (
    <article className={isIgnored ? "row ignored-row" : "row"}>
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
      <div className="row-main">
        <div className="row-title">
          <strong>{app.displayName}</strong>
          {update && <span>{sourceLabel(update)}</span>}
        </div>
        <p>
          {update
            ? `${app.localVersion.raw || "unknown"} -> ${update.remoteVersion.raw || "unknown"}`
            : recentlyUpdatedAt
              ? updatedRelativeLabel(recentlyUpdatedAt)
              : `${app.localVersion.raw || "unknown"} installed`}
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
        <IgnoreActionIconButton
          isIgnored={isIgnored}
          disabled={isUninstalling}
          onToggle={() => void window.baseline.toggleIgnoredApp(app.id)}
        />
        {uninstallableItem && (
          <button
            className="destructive-icon-button"
            disabled={isUpdating || isUninstalling}
            onClick={() =>
              requestActionConfirmation({ type: "uninstall", item: uninstallableItem })
            }
            title={`Uninstall ${app.displayName}`}
            aria-label={`Uninstall ${app.displayName}`}
          >
            {isUninstalling ? <UninstallActionGlyph /> : <Trash2 size={15} />}
          </button>
        )}
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
      {snapshot.searchText.trim() && <DiscoverSection snapshot={snapshot} />}
      <HomebrewSection
        sectionID="outdated"
        title={`Outdated (${derived.homebrewOutdated.length})`}
        items={derived.homebrewOutdated}
        snapshot={snapshot}
        empty="All your Homebrew items are up to date."
        showUpdateAll
      />
      {snapshot.showRecentlyUpdatedHomebrewSection && (
        <HomebrewSection
          sectionID="recentlyUpdated"
          collapsible
          title="Recently Updated"
          items={derived.homebrewRecentlyUpdated}
          snapshot={snapshot}
          empty="No recently updated Homebrew items yet."
          recentlyUpdated
        />
      )}
      {snapshot.showIgnoredHomebrewSection && (
        <HomebrewSection
          sectionID="ignored"
          collapsible
          title={`Ignored (${derived.homebrewIgnored.length})`}
          items={derived.homebrewIgnored}
          snapshot={snapshot}
          empty="No ignored Homebrew items."
        />
      )}
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
      {!compact && snapshot.showInstalledAppsSection && (
        <AppSection
          sectionID="installed"
          collapsible
          title="Installed Apps"
          apps={derived.installedApps}
          snapshot={snapshot}
          empty="No installed apps found."
        />
      )}
      {!compact && snapshot.showInstalledHomebrewSection && (
        <HomebrewSection
          sectionID="installed"
          collapsible
          title="Installed Homebrew"
          items={derived.homebrewInstalled}
          snapshot={snapshot}
          empty="No installed Homebrew items found."
        />
      )}
      {compact && <Empty text="Open Baseline to view installed items." />}
    </div>
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

  return (
    <article className="row">
      <HomebrewItemIcon item={item} snapshot={snapshot} />
      <div className="row-main">
        <div className="row-title">
          <strong>{item.displayName}</strong>
          <span>{item.kind}</span>
        </div>
        <p>{item.version.raw || item.token}</p>
      </div>
      <div className="row-actions">
        {item.homepageURL && (
          <button
            className="icon-button"
            onClick={() => void window.baseline.openExternal(item.homepageURL!)}
            title="Open Homebrew page"
          >
            <ExternalLink size={15} />
          </button>
        )}
        <UpdateActionButton
          state={actionStateFromFlags({ failed, updating: installing, progress, done })}
          readyLabel="Install"
          onAction={() => requestActionConfirmation({ type: "install", item })}
        />
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
  recentlyUpdated = false
}: {
  sectionID: string;
  title: string;
  items: HomebrewManagedItem[];
  snapshot: BaselineSnapshot;
  empty: string;
  showUpdateAll?: boolean;
  collapsible?: boolean;
  recentlyUpdated?: boolean;
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
              state={
                snapshot.isRunningHomebrewMaintenance
                  ? { type: "updating" }
                  : items.every((item) =>
                        snapshot.homebrewUpdatedPendingRefreshItemIDs.includes(item.id)
                      )
                    ? { type: "done" }
                    : { type: "ready" }
              }
              readyLabel="Update All"
              onAction={() => void window.baseline.performHomebrewUpdateAll()}
            />
          ) : undefined
        }
      />
      {!collapsed &&
        (items.length === 0 ? (
          <Empty text={empty} />
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
  const isUpdating = snapshot.homebrewUpdatingItemIDs.includes(item.id);
  const isUninstalling = snapshot.homebrewUninstallingItemIDs.includes(item.id);
  const isIgnored = snapshot.ignoredHomebrewItemIDs.includes(item.id);
  const failed = snapshot.homebrewBatchFailedItemIDs.includes(item.id);
  const done = snapshot.homebrewUpdatedPendingRefreshItemIDs.includes(item.id);
  const progress = snapshot.homebrewBatchProgressByItemID[item.id];
  const updateState = actionStateFromFlags({
    failed,
    updating: isUpdating,
    progress,
    done
  });
  const recentlyUpdatedAt = recentlyUpdated
    ? snapshot.homebrewRecentlyUpdated.find((record) => record.itemID === item.id)?.updatedAt
    : undefined;

  return (
    <article className={isIgnored ? "row ignored-row" : "row"}>
      <HomebrewItemIcon item={item} snapshot={snapshot} />
      <div className="row-main">
        <div className="row-title">
          <strong>{item.name}</strong>
          <span>{item.kind}</span>
        </div>
        <p>
          {recentlyUpdatedAt
            ? updatedRelativeLabel(recentlyUpdatedAt)
            : `${item.installedVersion.raw || "unknown"}${
                item.latestVersion ? ` -> ${item.latestVersion.raw}` : ""
              }`}
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
        <IgnoreActionIconButton
          isIgnored={isIgnored}
          disabled={isUninstalling}
          onToggle={() => void window.baseline.toggleIgnoredHomebrew(item.id)}
        />
        {item.kind === "cask" && (
          <button
            className="destructive-icon-button"
            disabled={isUpdating || isUninstalling}
            onClick={() => requestActionConfirmation({ type: "uninstall", item })}
            title={`Uninstall ${item.name}`}
            aria-label={`Uninstall ${item.name}`}
          >
            {isUninstalling ? <UninstallActionGlyph /> : <Trash2 size={15} />}
          </button>
        )}
      </div>
    </article>
  );
}

function HomebrewItemIcon({
  item,
  snapshot
}: {
  item: Pick<HomebrewManagedItem, "kind" | "token"> &
    Partial<
      Pick<HomebrewManagedItem, "name" | "iconDataURL"> &
        Pick<HomebrewCaskDiscoveryItem, "displayName">
    >;
  snapshot: BaselineSnapshot;
}) {
  const app = matchingAppForHomebrewItem(item, snapshot);
  const iconDataURL = item.iconDataURL ?? app?.iconDataURL;
  const label = isCask(item.kind) ? "C" : "F";

  if (app) {
    return (
      <button
        className={
          iconDataURL
            ? "app-icon app-icon-image clickable-app-icon"
            : "app-icon brew clickable-app-icon"
        }
        onClick={() => void window.baseline.openApp(app.id)}
        title="Open app"
        aria-label="Open app"
      >
        {iconDataURL ? <img src={iconDataURL} alt="" draggable={false} /> : label}
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

  return <div className="app-icon brew">{label}</div>;
}

export function UpdateActionButton({
  state,
  onAction,
  readyLabel = "Update",
  disabled = false
}: {
  state: ActionState;
  onAction: () => void;
  readyLabel?: string;
  disabled?: boolean;
}) {
  if (state.type === "ready") {
    return (
      <button className="primary-button" disabled={disabled} onClick={onAction}>
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
      {state.type === "updating" ? (
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

function IgnoreActionIconButton({
  isIgnored,
  disabled,
  onToggle
}: {
  isIgnored: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const label = isIgnored ? "Unignore" : "Ignore";
  return (
    <button
      className="secondary-icon-button"
      disabled={disabled}
      onClick={onToggle}
      title={label}
      aria-label={label}
    >
      {isIgnored ? <EyeOff size={15} /> : <Eye size={15} />}
    </button>
  );
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
  const [showCheckmark, setShowCheckmark] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowCheckmark(true), 320);
    return () => window.clearTimeout(timer);
  }, []);

  return showCheckmark ? <Check size={15} /> : <ProgressRing value={1} />;
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
      ? `This will run Homebrew and install ${confirmation.item.displayName} (${confirmation.item.kind} ${confirmation.item.token}) on your Mac.`
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
  updating,
  progress,
  done
}: {
  failed: boolean;
  updating: boolean;
  progress?: number;
  done: boolean;
}): ActionState {
  if (failed) {
    return { type: "failed" };
  }
  if (updating) {
    return progress === undefined ? { type: "updating" } : { type: "updating", progress };
  }
  if (done) {
    return { type: "done" };
  }
  return { type: "ready" };
}

function actionStateLabel(state: Exclude<ActionState, { type: "ready" }>): string {
  if (state.type === "updating") {
    return "Updating";
  }
  if (state.type === "done") {
    return "Updated";
  }
  return "Update failed";
}

function SettingsView({ snapshot }: { snapshot: BaselineSnapshot }) {
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const derived = useMemo(() => deriveSections(snapshot), [snapshot]);

  return (
    <main className="app-shell">
      <Sidebar snapshot={snapshot} derived={derived} route="settings" />
      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>Settings</h1>
            <p>Sections, scan paths, optional tools, and refresh behavior</p>
          </div>
          <button
            className="toolbar-button text-button"
            onClick={() => (window.location.hash = "/main")}
          >
            Done
          </button>
        </header>

        <section className="settings-grid">
          <section className="panel">
            <PanelTitle title="Readiness" />
            <Readiness label="Homebrew" ready={snapshot.isHomebrewInstalled} />
            <Readiness label="mas" ready={snapshot.isMasInstalled} />
            <div className="settings-action">
              <button
                className="ghost-button wide"
                onClick={() => void window.baseline.refresh(true)}
              >
                Check Again
              </button>
            </div>
          </section>

          <section className="panel">
            <PanelTitle title="Sections" />
            <Toggle
              label="Installed apps"
              value={snapshot.showInstalledAppsSection}
              patch="showInstalledAppsSection"
            />
            <Toggle
              label="Recently updated apps"
              value={snapshot.showRecentlyUpdatedAppsSection}
              patch="showRecentlyUpdatedAppsSection"
            />
            <Toggle
              label="Ignored apps"
              value={snapshot.showIgnoredAppsSection}
              patch="showIgnoredAppsSection"
            />
            <Toggle
              label="Recently updated Homebrew"
              value={snapshot.showRecentlyUpdatedHomebrewSection}
              patch="showRecentlyUpdatedHomebrewSection"
            />
            <Toggle
              label="Installed Homebrew"
              value={snapshot.showInstalledHomebrewSection}
              patch="showInstalledHomebrewSection"
            />
            <Toggle
              label="Ignored Homebrew"
              value={snapshot.showIgnoredHomebrewSection}
              patch="showIgnoredHomebrewSection"
            />
          </section>

          <section className="panel">
            <PanelTitle title="Refresh" />
            <Toggle
              label="Auto refresh"
              value={snapshot.autoRefreshEnabled}
              patch="autoRefreshEnabled"
            />
            <label className="field">
              <span>Interval minutes</span>
              <input
                type="number"
                min={5}
                max={1440}
                value={snapshot.refreshIntervalMinutes}
                onChange={(event) =>
                  void window.baseline.updatePreferences({
                    refreshIntervalMinutes: Number(event.currentTarget.value)
                  })
                }
              />
            </label>
            <Toggle
              label="Use mas for App Store updates"
              value={snapshot.useMasForAppStoreUpdates}
              patch="useMasForAppStoreUpdates"
            />
          </section>

          <section className="panel wide-panel">
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
            <div className="directory-list">
              {snapshot.additionalDirectories.length === 0 && (
                <Empty text="Using default Applications folders." />
              )}
              {snapshot.additionalDirectories.map((directory) => (
                <div className="directory-row" key={directory}>
                  <span>{directory}</span>
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
          </section>

          <section className="panel">
            <PanelTitle title="Diagnostics" />
            <p className="muted panel-copy">
              Copy a local report with counts, tool status, scan paths, and the latest non-sensitive
              refresh message.
            </p>
            <div className="settings-action">
              <button
                className="primary-button wide"
                onClick={() => {
                  void window.baseline.copyDiagnostics().then(() => setDiagnosticsCopied(true));
                }}
              >
                {diagnosticsCopied ? "Copied" : "Copy Report"}
              </button>
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}

type TogglePatch = Exclude<
  keyof Parameters<typeof window.baseline.updatePreferences>[0],
  "selectedTab" | "refreshIntervalMinutes"
>;

function Toggle({ label, value, patch }: { label: string; value: boolean; patch: TogglePatch }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(event) =>
          void window.baseline.updatePreferences({ [patch]: event.currentTarget.checked })
        }
      />
    </label>
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

function Readiness({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className="ready-row">
      {ready ? (
        <CheckCircle2 className="good" size={17} />
      ) : (
        <XCircle className="muted-icon" size={17} />
      )}
      <span>{label}</span>
      <strong>{ready ? "Available" : "Not detected"}</strong>
    </div>
  );
}

function sourceLabel(update: UpdateRecord): string {
  if (update.source === "appStore") return "App Store";
  if (update.source === "sparkle") return "Sparkle";
  if (update.source === "homebrew") return "Homebrew";
  return "Update";
}

function selectedTabTitle(tab: MenuTab): string {
  if (tab === "all") return "All";
  if (tab === "apps") return "Applications";
  if (tab === "installed") return "Installed";
  return "Homebrew";
}

function searchPlaceholder(): string {
  return "Search";
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

function combinedAvailableCount(derived: DerivedSections): number {
  return derived.availableApps.length + derived.allHomebrewOutdated.length;
}

function combinedInstalledCount(derived: DerivedSections): number {
  return derived.installedApps.length + derived.homebrewInstalled.length;
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
  const allHomebrewOutdated = homebrewOutdated.filter(
    (item) => !homebrewItemHasAppUpdate(item, availableApps, updatesByAppID)
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

function homebrewItemHasAppUpdate(
  item: HomebrewManagedItem,
  apps: AppRecord[],
  updatesByAppID: Map<string, UpdateRecord>
): boolean {
  if (!isCask(item.kind)) {
    return false;
  }

  return apps.some((app) => {
    const update = updatesByAppID.get(app.id);
    if (
      update?.homebrewToken &&
      normalizedName(update.homebrewToken) === normalizedName(item.token)
    ) {
      return true;
    }
    return normalizedAppCandidates(app).has(normalizedName(item.token));
  });
}

function matchingAppForHomebrewItem(
  item: Pick<HomebrewManagedItem, "kind" | "token"> &
    Partial<Pick<HomebrewManagedItem, "name"> & Pick<HomebrewCaskDiscoveryItem, "displayName">>,
  snapshot: BaselineSnapshot
): AppRecord | undefined {
  if (!isCask(item.kind)) {
    return undefined;
  }

  const identifiers = homebrewItemIdentifiers(item);
  const matchingUpdate = snapshot.updates.find(
    (update) => update.homebrewToken && identifiers.has(normalizedName(update.homebrewToken))
  );
  const appFromUpdate = matchingUpdate
    ? snapshot.apps.find((app) => app.id === matchingUpdate.appID)
    : undefined;
  if (appFromUpdate?.iconDataURL) {
    return appFromUpdate;
  }

  return snapshot.apps.find((app) =>
    [...identifiers].some((identifier) => normalizedAppCandidates(app).has(identifier))
  );
}

function uninstallableHomebrewItemForApp(
  app: AppRecord,
  snapshot: BaselineSnapshot
): HomebrewManagedItem | undefined {
  const update = snapshot.updates.find((candidate) => candidate.appID === app.id);
  if (update?.homebrewToken) {
    const token = normalizedName(update.homebrewToken);
    const matchedByUpdate = snapshot.homebrewItems.find(
      (item) => item.kind === "cask" && normalizedName(item.token) === token
    );
    if (matchedByUpdate) {
      return matchedByUpdate;
    }
  }

  const appCandidates = normalizedAppCandidates(app);
  return snapshot.homebrewItems.find((item) => {
    if (item.kind !== "cask") {
      return false;
    }
    const identifiers = homebrewItemIdentifiers(item);
    return [...identifiers].some((identifier) => appCandidates.has(identifier));
  });
}

function homebrewItemIdentifiers(
  item: Pick<HomebrewManagedItem, "token"> &
    Partial<Pick<HomebrewManagedItem, "name"> & Pick<HomebrewCaskDiscoveryItem, "displayName">>
): Set<string> {
  return new Set(
    [item.token, item.name, item.displayName]
      .filter((value): value is string => Boolean(value))
      .map(normalizedName)
  );
}

function normalizedAppCandidates(app: AppRecord): Set<string> {
  const fileName = app.bundlePath
    .split("/")
    .pop()
    ?.replace(/\.app$/iu, "");
  const candidates = [app.displayName, app.bundleIdentifier, fileName]
    .filter((value): value is string => Boolean(value))
    .map(normalizedName);
  return new Set(candidates.flatMap((value) => [value, value.replace(/^com/u, "")]));
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isCask(kind: string): boolean {
  return kind.toLowerCase() === "cask";
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
