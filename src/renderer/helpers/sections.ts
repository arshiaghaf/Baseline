// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  UpdateRecord
} from "../../shared/domain";
import { homebrewItemForAppUpdate, isCask } from "../../shared/homebrewAppLinking";

export function compareRecentRows(
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

export function combinedAvailableCount(derived: DerivedSections): number {
  return derived.availableApps.length + derived.allHomebrewOutdated.length;
}

export type DerivedSections = ReturnType<typeof deriveSections>;

export function deriveSections(
  snapshot: Pick<
    BaselineSnapshot,
    | "apps"
    | "updates"
    | "ignoredIDs"
    | "recentlyUpdated"
    | "homebrewItems"
    | "ignoredHomebrewItemIDs"
    | "homebrewRecentlyUpdated"
    | "searchText"
  >
) {
  const term = snapshot.searchText.trim().toLowerCase();
  const updatesByAppID = new Map(
    snapshot.updates
      .filter(
        (update) =>
          !(
            update.source === "homebrew" &&
            homebrewItemForAppUpdate(update, snapshot.homebrewItems)?.pinned
          )
      )
      .map((update) => [update.appID, update])
  );
  const appByID = new Map(snapshot.apps.map((app) => [app.id, app]));
  const uninstallableAppIDs = new Set(
    snapshot.homebrewItems
      .filter((item) => item.kind === "cask" && item.appID)
      .map((item) => item.appID)
  );
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
    .filter((app) => !uninstallableAppIDs.has(app.id))
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
    .filter(
      (item) =>
        item.isOutdated && !item.pinned && !snapshot.ignoredHomebrewItemIDs.includes(item.id)
    )
    .filter(homebrewFilter)
    .sort(sortHomebrewOutdated);
  const ignoredAppsUnfiltered = snapshot.apps.filter((app) => snapshot.ignoredIDs.includes(app.id));
  const appsRepresentedOutsideHomebrew = term
    ? [...availableApps, ...ignoredAppsUnfiltered]
    : snapshot.apps.filter(
        (app) => updatesByAppID.has(app.id) || snapshot.ignoredIDs.includes(app.id)
      );
  const representedAppIDs = new Set(appsRepresentedOutsideHomebrew.map((app) => app.id));
  const allHomebrewOutdated = homebrewOutdated.filter(
    (item) => !(isCask(item.kind) && item.appID && representedAppIDs.has(item.appID))
  );
  const homebrewInstalled = snapshot.homebrewItems
    .filter(
      (item) =>
        (!item.isOutdated || item.pinned) && !snapshot.ignoredHomebrewItemIDs.includes(item.id)
    )
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

export function matchingAppForHomebrewItem(
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

  return undefined;
}

export function uninstallableHomebrewItemForApp(
  app: AppRecord,
  snapshot: BaselineSnapshot
): HomebrewManagedItem | undefined {
  const matchedByExplicitLink = snapshot.homebrewItems.find(
    (item) => item.kind === "cask" && item.appID === app.id
  );
  if (matchedByExplicitLink) {
    return matchedByExplicitLink;
  }

  return undefined;
}

export function sortByName(lhs: AppRecord, rhs: AppRecord): number {
  return lhs.displayName.localeCompare(rhs.displayName, undefined, { sensitivity: "base" });
}

export function sortByUpdateDate(
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

export function sortHomebrewOutdated(lhs: HomebrewManagedItem, rhs: HomebrewManagedItem): number {
  const left = new Date(lhs.releaseDate ?? 0).getTime();
  const right = new Date(rhs.releaseDate ?? 0).getTime();
  return right - left || lhs.name.localeCompare(rhs.name, undefined, { sensitivity: "base" });
}

export function sortHomebrewInstalled(lhs: HomebrewManagedItem, rhs: HomebrewManagedItem): number {
  return (
    lhs.kind.localeCompare(rhs.kind) ||
    lhs.name.localeCompare(rhs.name, undefined, { sensitivity: "base" })
  );
}
