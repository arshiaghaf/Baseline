import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  AppWindow,
  Beer,
  CheckCircle2,
  ExternalLink,
  FolderPlus,
  Loader2,
  Package,
  RefreshCcw,
  Search,
  Settings,
  SlidersHorizontal,
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

function Dashboard({
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

  if (compact) {
    return (
      <main className="app-shell compact">
        <header className="popover-titlebar">
          <div>
            <h1>Baseline</h1>
            <p>
              {snapshot.isRefreshing
                ? "Checking updates"
                : `${derived.availableApps.length} apps, ${derived.homebrewOutdated.length} brew`}
            </p>
          </div>
          <div className="topbar-actions">
            {snapshot.isRefreshing && <Loader2 className="spin" size={16} />}
            <button
              className="toolbar-button"
              onClick={() => void window.baseline.refresh(false)}
              title="Refresh"
            >
              <RefreshCcw size={15} />
            </button>
            <button className="toolbar-button" onClick={onOpenSettings} title="Settings">
              <Settings size={15} />
            </button>
          </div>
        </header>
        <CommandBar snapshot={snapshot} selectedTab={selectedTab} />
        <section className="content single">
          {selectedTab === "apps" ? (
            <AppsTab snapshot={snapshot} derived={derived} compact={compact} />
          ) : (
            <HomebrewTab snapshot={snapshot} derived={derived} compact={compact} />
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <Sidebar snapshot={snapshot} derived={derived} route="main" />
      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>{selectedTab === "apps" ? "Applications" : "Homebrew"}</h1>
            <p>
              {snapshot.isRefreshing
                ? "Checking installed apps and Homebrew metadata"
                : selectedTab === "apps"
                  ? `${derived.availableApps.length} available updates`
                  : `${derived.homebrewOutdated.length} outdated items`}
            </p>
          </div>
          <div className="topbar-actions">
            {snapshot.isRefreshing && <Loader2 className="spin" size={17} />}
            <button
              className="toolbar-button"
              onClick={() => void window.baseline.refresh(false)}
              title="Refresh"
            >
              <RefreshCcw size={16} />
            </button>
            <button className="toolbar-button" onClick={onOpenSettings} title="Settings">
              <Settings size={16} />
            </button>
          </div>
        </header>

        <CommandBar snapshot={snapshot} selectedTab={selectedTab} />

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
          {selectedTab === "apps" ? (
            <AppsTab snapshot={snapshot} derived={derived} compact={compact} />
          ) : (
            <HomebrewTab snapshot={snapshot} derived={derived} compact={compact} />
          )}
          <Inspector snapshot={snapshot} derived={derived} />
        </section>
      </section>
    </main>
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
      <div className="sidebar-title">
        <AppWindow size={20} />
        <strong>Baseline</strong>
      </div>
      <nav className="source-list">
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
          className={route === "settings" ? "selected" : ""}
          onClick={() => (window.location.hash = "/settings")}
        >
          <SlidersHorizontal size={16} />
          <span>Settings</span>
        </button>
      </nav>
      <div className="sidebar-footer">
        <Readiness label="Homebrew" ready={snapshot.isHomebrewInstalled} />
        <Readiness label="mas" ready={snapshot.isMasInstalled} />
      </div>
    </aside>
  );
}

function CommandBar({
  snapshot,
  selectedTab
}: {
  snapshot: BaselineSnapshot;
  selectedTab: MenuTab;
}) {
  return (
    <section className="command-row">
      <label className="search-box">
        <Search size={15} />
        <input
          value={snapshot.searchText}
          onChange={(event) => void window.baseline.setSearchText(event.currentTarget.value)}
          placeholder={
            selectedTab === "homebrew" ? "Search installed or discover Homebrew" : "Search apps"
          }
        />
      </label>
      <SegmentedTabs selectedTab={selectedTab} />
    </section>
  );
}

function SegmentedTabs({ selectedTab }: { selectedTab: MenuTab }) {
  return (
    <div className="segmented" role="tablist">
      {(["apps", "homebrew"] as MenuTab[]).map((tab) => (
        <button
          key={tab}
          className={selectedTab === tab ? "selected" : ""}
          onClick={() => void window.baseline.setSelectedTab(tab)}
        >
          {tab === "apps" ? "Apps" : "Homebrew"}
        </button>
      ))}
    </div>
  );
}

function AppsTab({
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
      <AppSection
        title={`Available (${derived.availableApps.length})`}
        apps={derived.availableApps}
        snapshot={snapshot}
        empty="All your apps are up to date."
      />
      {snapshot.showRecentlyUpdatedAppsSection && (
        <AppSection
          title="Recently Updated"
          apps={derived.recentlyUpdatedApps}
          snapshot={snapshot}
          empty="No recently updated apps yet."
          recentlyUpdated
        />
      )}
      {!compact && snapshot.showInstalledAppsSection && (
        <AppSection
          title={`Installed (${derived.installedApps.length})`}
          apps={derived.installedApps}
          snapshot={snapshot}
          empty="No installed apps found."
        />
      )}
      {snapshot.showIgnoredAppsSection && (
        <AppSection
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
  title,
  apps,
  snapshot,
  empty,
  recentlyUpdated = false
}: {
  title: string;
  apps: AppRecord[];
  snapshot: BaselineSnapshot;
  empty: string;
  recentlyUpdated?: boolean;
}) {
  return (
    <section className="panel">
      <PanelTitle title={title} />
      {apps.length === 0 ? (
        <Empty text={empty} />
      ) : (
        <div className="rows">
          {apps.map((app) => (
            <AppRow key={app.id} app={app} snapshot={snapshot} recentlyUpdated={recentlyUpdated} />
          ))}
        </div>
      )}
    </section>
  );
}

function AppRow({
  app,
  snapshot,
  recentlyUpdated
}: {
  app: AppRecord;
  snapshot: BaselineSnapshot;
  recentlyUpdated: boolean;
}) {
  const update = snapshot.updates.find((candidate) => candidate.appID === app.id);
  const isUpdating = snapshot.appUpdatingIDs.includes(app.id);
  const isIgnored = snapshot.ignoredIDs.includes(app.id);
  const progress = snapshot.homebrewFallbackProgressByAppID[app.id];

  return (
    <article className="row">
      <button
        className={app.iconDataURL ? "app-icon app-icon-image" : "app-icon"}
        onClick={() => void window.baseline.openApp(app.id)}
        title="Open app"
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
            : recentlyUpdated
              ? "Updated recently"
              : `${app.localVersion.raw || "unknown"} installed`}
        </p>
        {progress !== undefined && <Progress value={progress} />}
      </div>
      <div className="row-actions">
        <button
          className="ghost-button"
          onClick={() => void window.baseline.toggleIgnoredApp(app.id)}
        >
          {isIgnored ? "Unignore" : "Ignore"}
        </button>
        <button
          className="primary-button"
          disabled={isUpdating}
          onClick={() => void window.baseline.performAppUpdate(app.id)}
        >
          {isUpdating ? <Loader2 className="spin" size={14} /> : update ? "Update" : "Open"}
        </button>
      </div>
    </article>
  );
}

function HomebrewTab({
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
      {snapshot.searchText.trim() && <DiscoverSection snapshot={snapshot} />}
      <HomebrewSection
        title={`Outdated (${derived.homebrewOutdated.length})`}
        items={derived.homebrewOutdated}
        snapshot={snapshot}
        empty="All your Homebrew items are up to date."
        showUpdateAll
      />
      {snapshot.showRecentlyUpdatedHomebrewSection && (
        <HomebrewSection
          title="Recently Updated"
          items={derived.homebrewRecentlyUpdated}
          snapshot={snapshot}
          empty="No recently updated Homebrew items yet."
        />
      )}
      {!compact && snapshot.showInstalledHomebrewSection && (
        <HomebrewSection
          title={`Installed (${derived.homebrewInstalled.length})`}
          items={derived.homebrewInstalled}
          snapshot={snapshot}
          empty="No installed Homebrew items found."
        />
      )}
      {snapshot.showIgnoredHomebrewSection && (
        <HomebrewSection
          title={`Ignored (${derived.homebrewIgnored.length})`}
          items={derived.homebrewIgnored}
          snapshot={snapshot}
          empty="No ignored Homebrew items."
        />
      )}
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

function DiscoverRow({
  item,
  snapshot
}: {
  item: HomebrewCaskDiscoveryItem;
  snapshot: BaselineSnapshot;
}) {
  const installing = snapshot.homebrewDiscoverInstallingItemIDs.includes(item.id);
  const failed = snapshot.homebrewDiscoverFailedItemIDs.includes(item.id);
  const done = snapshot.homebrewDiscoverInstalledPendingRefreshItemIDs.includes(item.id);

  return (
    <article className="row">
      <div className="app-icon brew">{item.kind === "cask" ? "C" : "F"}</div>
      <div className="row-main">
        <div className="row-title">
          <strong>{item.displayName}</strong>
          <span>{item.kind}</span>
        </div>
        <p>{item.version.raw || item.token}</p>
        {snapshot.homebrewDiscoverProgressByItemID[item.id] !== undefined && (
          <Progress value={snapshot.homebrewDiscoverProgressByItemID[item.id] ?? 0} />
        )}
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
        <button
          className={failed ? "danger-button" : "primary-button"}
          disabled={installing || done}
          onClick={() => void window.baseline.installHomebrewItem(item)}
        >
          {installing ? (
            <Loader2 className="spin" size={14} />
          ) : done ? (
            "Done"
          ) : failed ? (
            "Retry"
          ) : (
            "Install"
          )}
        </button>
      </div>
    </article>
  );
}

function HomebrewSection({
  title,
  items,
  snapshot,
  empty,
  showUpdateAll = false
}: {
  title: string;
  items: HomebrewManagedItem[];
  snapshot: BaselineSnapshot;
  empty: string;
  showUpdateAll?: boolean;
}) {
  return (
    <section className="panel">
      <PanelTitle
        title={title}
        action={
          showUpdateAll && items.length > 0 ? (
            <button
              className="ghost-button"
              onClick={() => void window.baseline.performHomebrewUpdateAll()}
            >
              {snapshot.isRunningHomebrewMaintenance ? "Running" : "Update All"}
            </button>
          ) : undefined
        }
      />
      {items.length === 0 ? (
        <Empty text={empty} />
      ) : (
        <div className="rows">
          {items.map((item) => (
            <HomebrewRow key={item.id} item={item} snapshot={snapshot} />
          ))}
        </div>
      )}
    </section>
  );
}

function HomebrewRow({
  item,
  snapshot
}: {
  item: HomebrewManagedItem;
  snapshot: BaselineSnapshot;
}) {
  const isUpdating = snapshot.homebrewUpdatingItemIDs.includes(item.id);
  const isUninstalling = snapshot.homebrewUninstallingItemIDs.includes(item.id);
  const isIgnored = snapshot.ignoredHomebrewItemIDs.includes(item.id);
  const failed = snapshot.homebrewBatchFailedItemIDs.includes(item.id);
  const progress = snapshot.homebrewBatchProgressByItemID[item.id];

  return (
    <article className="row">
      <div className="app-icon brew">{item.kind === "cask" ? "C" : "F"}</div>
      <div className="row-main">
        <div className="row-title">
          <strong>{item.name}</strong>
          <span>{item.kind}</span>
        </div>
        <p>
          {item.installedVersion.raw || "unknown"}
          {item.latestVersion ? ` -> ${item.latestVersion.raw}` : ""}
        </p>
        {progress !== undefined && <Progress value={progress} />}
      </div>
      <div className="row-actions">
        <button
          className="ghost-button"
          onClick={() => void window.baseline.toggleIgnoredHomebrew(item.id)}
        >
          {isIgnored ? "Unignore" : "Ignore"}
        </button>
        {item.kind === "cask" && (
          <button
            className="icon-button"
            disabled={isUninstalling}
            onClick={() => void window.baseline.uninstallHomebrewItem(item.id)}
            title="Uninstall"
          >
            {isUninstalling ? <Loader2 className="spin" size={14} /> : <Trash2 size={15} />}
          </button>
        )}
        <button
          className={failed ? "danger-button" : "primary-button"}
          disabled={!item.isOutdated || isUpdating}
          onClick={() => void window.baseline.performHomebrewUpdate(item.id)}
        >
          {isUpdating ? (
            <Loader2 className="spin" size={14} />
          ) : item.isOutdated ? (
            "Update"
          ) : (
            "Current"
          )}
        </button>
      </div>
    </article>
  );
}

function Inspector({
  snapshot,
  derived
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
}) {
  return (
    <aside className="inspector">
      <section className="panel">
        <PanelTitle title="Status" />
        <dl className="stats">
          <div>
            <dt>Apps</dt>
            <dd>{snapshot.apps.length}</dd>
          </div>
          <div>
            <dt>Available</dt>
            <dd>{derived.availableApps.length}</dd>
          </div>
          <div>
            <dt>Homebrew</dt>
            <dd>{snapshot.homebrewItems.length}</dd>
          </div>
          <div>
            <dt>Outdated</dt>
            <dd>{derived.homebrewOutdated.length}</dd>
          </div>
        </dl>
        <div className="readiness">
          <Readiness label="Homebrew" ready={snapshot.isHomebrewInstalled} />
          <Readiness label="mas" ready={snapshot.isMasInstalled} />
        </div>
      </section>
      <section className="panel">
        <PanelTitle title="Last Refresh" />
        <p className="muted">
          {snapshot.lastRefreshDate ? new Date(snapshot.lastRefreshDate).toLocaleString() : "Never"}
        </p>
        <button className="primary-button wide" onClick={() => void window.baseline.refresh(false)}>
          Refresh Now
        </button>
      </section>
    </aside>
  );
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

function PanelTitle({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="panel-title">
      <h2>{title}</h2>
      {action}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

function Progress({ value }: { value: number }) {
  return (
    <div className="progress">
      <span style={{ width: `${Math.round(Math.max(0, Math.min(value, 1)) * 100)}%` }} />
    </div>
  );
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
    homebrewInstalled,
    homebrewIgnored,
    homebrewRecentlyUpdated
  };
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

createRoot(document.getElementById("root")!).render(<App />);
