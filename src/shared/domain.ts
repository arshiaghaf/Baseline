import type { VersionValue } from "./version";

export type UpdateSource = "appStore" | "sparkle" | "homebrew" | "web" | "unknown";
export type SupportLevel = "supported" | "limited" | "unsupported";
export type MenuTab = "apps" | "homebrew";
export type HomebrewManagedItemKind = "formula" | "cask";

export type AppRecord = {
  id: string;
  bundlePath: string;
  displayName: string;
  bundleIdentifier?: string;
  localVersion: VersionValue;
  sourceHint: UpdateSource;
  sparkleFeedURL?: string;
  iconDataURL?: string;
};

export type AppStoreLookupResult = {
  remoteVersion: VersionValue;
  updateURL?: string;
  releaseNotesSummary?: string;
  releaseDate?: string;
  appStoreItemID?: number;
};

export type SparkleLookupResult = {
  remoteVersion: VersionValue;
  updateURL?: string;
  releaseNotesURL?: string;
  releaseDate?: string;
};

export type HomebrewLookupResult = {
  remoteVersion: VersionValue;
  token: string;
  homepageURL?: string;
};

export type HomebrewCaskEntry = {
  token: string;
  version: VersionValue;
  homepageURL?: string;
  bundleIdentifiers: string[];
  appBundleNames: string[];
};

export type HomebrewCaskDiscoveryItem = {
  id: string;
  kind: HomebrewManagedItemKind;
  token: string;
  displayName: string;
  version: VersionValue;
  homepageURL?: string;
};

export type HomebrewCaskIndex = {
  byBundleIdentifier: Record<string, HomebrewCaskEntry>;
  byAppBundleName: Record<string, HomebrewCaskEntry[]>;
};

export type HomebrewFormulaEntry = {
  token: string;
  version: VersionValue;
  homepageURL?: string;
  description?: string;
};

export type HomebrewFormulaIndex = {
  byToken: Record<string, HomebrewFormulaEntry>;
};

export type UpdateRecord = {
  id: string;
  appID: string;
  source: UpdateSource;
  supportLevel: SupportLevel;
  localVersion: VersionValue;
  remoteVersion: VersionValue;
  updateURL?: string;
  appStoreItemID?: number;
  homebrewToken?: string;
  releaseNotesURL?: string;
  releaseNotesSummary?: string;
  releaseDate?: string;
  checkedAt: string;
};

export type RecentlyUpdatedRecord = {
  id: string;
  appID: string;
  displayName: string;
  fromVersion: VersionValue;
  toVersion: VersionValue;
  updatedAt: string;
};

export type HomebrewRecentlyUpdatedRecord = {
  id: string;
  itemID: string;
  token: string;
  kind: HomebrewManagedItemKind;
  displayName: string;
  fromVersion: VersionValue;
  toVersion: VersionValue;
  updatedAt: string;
};

export type HomebrewManagedItem = {
  id: string;
  token: string;
  name: string;
  kind: HomebrewManagedItemKind;
  installedVersion: VersionValue;
  latestVersion?: VersionValue;
  isOutdated: boolean;
  releaseDate?: string;
};

export type PersistedSnapshot = {
  apps: AppRecord[];
  updates: UpdateRecord[];
  recentlyUpdated: RecentlyUpdatedRecord[];
  homebrewItems: HomebrewManagedItem[];
  homebrewRecentlyUpdated: HomebrewRecentlyUpdatedRecord[];
  ignoredIDs: string[];
  ignoredHomebrewItemIDs: string[];
  additionalDirectories: string[];
  selectedTab: MenuTab;
  showInstalledAppsSection: boolean;
  showRecentlyUpdatedAppsSection: boolean;
  showIgnoredAppsSection: boolean;
  showRecentlyUpdatedHomebrewSection: boolean;
  showInstalledHomebrewSection: boolean;
  showIgnoredHomebrewSection: boolean;
  autoRefreshEnabled: boolean;
  refreshIntervalMinutes: number;
  useMasForAppStoreUpdates: boolean;
  lastRefreshDate?: string;
};

export type ToolStatus = {
  isMasInstalled: boolean;
  isHomebrewInstalled: boolean;
  isChecking: boolean;
  masTestMessage?: string;
  masTestSucceeded?: boolean;
};

export type RefreshState = {
  isRefreshing: boolean;
  refreshErrorMessage?: string;
  lastRefreshNoticeMessage?: string;
  lastRefreshDate?: string;
};

export type BaselineSnapshot = PersistedSnapshot &
  ToolStatus &
  RefreshState & {
    searchText: string;
    isRunningHomebrewMaintenance: boolean;
    appUpdatingIDs: string[];
    appUpdatedPendingRefreshIDs: string[];
    homebrewUpdatingItemIDs: string[];
    homebrewUninstallingItemIDs: string[];
    homebrewUpdatedPendingRefreshItemIDs: string[];
    homebrewBatchProgressByItemID: Record<string, number>;
    homebrewBatchFailedItemIDs: string[];
    homebrewFallbackProgressByAppID: Record<string, number>;
    homebrewFallbackFailedAppIDs: string[];
    homebrewDiscoverItems: HomebrewCaskDiscoveryItem[];
    homebrewDiscoverInstallingItemIDs: string[];
    homebrewDiscoverInstalledPendingRefreshItemIDs: string[];
    homebrewDiscoverFailedItemIDs: string[];
    homebrewDiscoverProgressByItemID: Record<string, number>;
    laggingHomebrewCaskTokens: string[];
  };

export const emptyHomebrewCaskIndex: HomebrewCaskIndex = {
  byBundleIdentifier: {},
  byAppBundleName: {}
};

export const emptyHomebrewFormulaIndex: HomebrewFormulaIndex = {
  byToken: {}
};

export function defaultPersistedSnapshot(): PersistedSnapshot {
  return {
    apps: [],
    updates: [],
    recentlyUpdated: [],
    homebrewItems: [],
    homebrewRecentlyUpdated: [],
    ignoredIDs: [],
    ignoredHomebrewItemIDs: [],
    additionalDirectories: [],
    selectedTab: "apps",
    showInstalledAppsSection: true,
    showRecentlyUpdatedAppsSection: true,
    showIgnoredAppsSection: true,
    showRecentlyUpdatedHomebrewSection: true,
    showInstalledHomebrewSection: true,
    showIgnoredHomebrewSection: true,
    autoRefreshEnabled: true,
    refreshIntervalMinutes: 60,
    useMasForAppStoreUpdates: true
  };
}

export function homebrewItemID(kind: HomebrewManagedItemKind, token: string): string {
  return `${kind}:${token.toLowerCase()}`;
}

export function homebrewDiscoverID(kind: HomebrewManagedItemKind, token: string): string {
  return homebrewItemID(kind, token);
}

export function sourceDisplayName(source: UpdateSource): string {
  return {
    appStore: "App Store",
    sparkle: "Sparkle",
    homebrew: "Homebrew",
    web: "Web",
    unknown: "Unknown"
  }[source];
}
