// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React from "react";
import type { AppRecord, BaselineSnapshot, HomebrewManagedItem } from "../../shared/domain";
import { homebrewItemMatchesApp } from "../../shared/homebrewAppLinking";
import {
  type DerivedSections,
  uninstallableHomebrewItemForApp,
  combinedAvailableCount,
  compareRecentRows
} from "../helpers/sections";
import { Empty, PanelTitle, UpdateActionButton } from "./CommonControls";
import {
  IgnoredAppCard,
  IgnoredHomebrewCard,
  AppUpdateCard,
  HomebrewUpdateCard,
  AppRow,
  RecentAppCard,
  RecentHomebrewCard,
  DiscoverRow,
  HomebrewRow
} from "./ItemViews";
import { homebrewBatchActionState } from "../helpers/actionState";
import { performHomebrewUpdateAllForItems, toggleCollapsedSection } from "../helpers/actions";
import {
  appUpdatesEmptyText,
  combinedUpdatesEmptyText,
  homebrewUpdatesEmptyText
} from "../helpers/appChecks";

export function SelectedTabContent({
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

export function SearchResults({
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
          empty={appUpdatesEmptyText(snapshot)}
          cardLayout
        />
      )}
      {derived.allHomebrewOutdated.length > 0 && (
        <HomebrewSection
          sectionID="outdated"
          title="Homebrew Updates"
          items={derived.allHomebrewOutdated}
          snapshot={snapshot}
          empty={homebrewUpdatesEmptyText(snapshot)}
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

export function SearchIgnoredSection({
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

export function AllTab({
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
          empty={appUpdatesEmptyText(snapshot)}
        />
        <HomebrewSection
          sectionID="outdated"
          title={`Homebrew Updates (${derived.allHomebrewOutdated.length})`}
          items={derived.allHomebrewOutdated}
          snapshot={snapshot}
          empty={homebrewUpdatesEmptyText(snapshot)}
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

export function AllUpdatesSection({
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
        <Empty text={combinedUpdatesEmptyText(snapshot)} />
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

export function AllRecentlyUpdatedSection({
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

export function AppsTab({
  snapshot,
  derived
}: {
  snapshot: BaselineSnapshot;
  derived: DerivedSections;
}) {
  return (
    <div className="stack">
      <AppSection
        sectionID="available"
        title={`Available (${derived.availableApps.length})`}
        apps={derived.availableApps}
        snapshot={snapshot}
        empty={appUpdatesEmptyText(snapshot)}
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

export function AppSection({
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

export function RecentlyUpdatedAppSection({
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

export function IgnoredAppSection({
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

export type RecentGridItem =
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

export type IgnoredGridItem =
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

export function RecentGrid({
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

export function CardGrid({
  children,
  sectionClassName
}: {
  children: React.ReactNode;
  sectionClassName: string;
}) {
  return <div className={`card-grid ${sectionClassName}`}>{children}</div>;
}

export function HomebrewTab({
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
        empty={homebrewUpdatesEmptyText(snapshot)}
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

export function InstalledTab({
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

export function IgnoredTab({
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
    <div className="stack">
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
    </div>
  );
}

export function DiscoverSection({ snapshot }: { snapshot: BaselineSnapshot }) {
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

export function RecentlyUpdatedHomebrewSection({
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

export function IgnoredHomebrewSection({
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
