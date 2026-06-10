// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import type { VersionValue } from "./version";

export type UpdateSource = "appStore" | "sparkle" | "homebrew" | "web" | "unknown";
export type SupportLevel = "supported" | "limited" | "unsupported";
export type MenuTab = "all" | "apps" | "homebrew" | "installed" | "ignored";
export type AppearancePreference = "system" | "light" | "dark";
export type HomebrewManagedItemKind = "formula" | "cask";
export type HomebrewPresentation = "formula" | "app" | "cli" | "package" | "cask";

export type AppRecord = {
  id: string;
  bundlePath: string;
  displayName: string;
  bundleIdentifier?: string;
  localVersion: VersionValue;
  bundleVersion?: VersionValue;
  sourceHint: UpdateSource;
  isIOSAppOnMac?: boolean;
  hasAppStoreEvidence?: boolean;
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
  remoteBuildVersion?: VersionValue;
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
  presentation: HomebrewPresentation;
  bundleIdentifiers: string[];
  inferredBundleIdentifiers?: string[];
  appBundleNames: string[];
};

export type HomebrewCaskDiscoveryItem = {
  id: string;
  kind: HomebrewManagedItemKind;
  token: string;
  displayName: string;
  presentation?: HomebrewPresentation;
  version: VersionValue;
  homepageURL?: string;
};

export type HomebrewCaskIndex = {
  byToken: Record<string, HomebrewCaskEntry>;
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
  localBuildVersion?: VersionValue;
  remoteBuildVersion?: VersionValue;
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
  source?: UpdateSource;
  fromVersion: VersionValue;
  toVersion: VersionValue;
  fromBuildVersion?: VersionValue;
  toBuildVersion?: VersionValue;
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

export type ProfileStatsChannel = "appStore" | "sparkle" | "homebrew" | "web" | "unknown";

export type ProfileStatsEventType = "appUpdate" | "homebrewUpdate" | "homebrewInstall";

export type ProfileStatsEvent = {
  id: string;
  type: ProfileStatsEventType;
  targetID: string;
  displayName: string;
  channel: ProfileStatsChannel;
  occurredAt: string;
};

export type ProfileStatsIntegrityStatus =
  | "pending"
  | "verified"
  | "unavailable"
  | "resetAfterTamper";

export type ProfileStats = {
  createdAt: string;
  startedUsingAt: string;
  signatureVersion: number;
  events: ProfileStatsEvent[];
  signature?: string;
  integrityStatus: ProfileStatsIntegrityStatus;
};

export const profileStatsSignatureVersion = 2;

export type HomebrewManagedItem = {
  id: string;
  token: string;
  name: string;
  kind: HomebrewManagedItemKind;
  presentation?: HomebrewPresentation;
  installedVersion: VersionValue;
  latestVersion?: VersionValue;
  isOutdated: boolean;
  releaseDate?: string;
  iconDataURL?: string;
  appID?: string;
};

export type SelfUpdateRecord = {
  available: boolean;
  currentVersion: VersionValue;
  latestVersion?: VersionValue;
  releaseURL?: string;
  checkedAt?: string;
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
  collapsedAppSectionIDs: string[];
  collapsedHomebrewSectionIDs: string[];
  autoRefreshEnabled: boolean;
  refreshIntervalMinutes: number;
  appearancePreference: AppearancePreference;
  useMasForAppStoreUpdates: boolean;
  showMenuBarIcon: boolean;
  profileStats: ProfileStats;
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
    defaultScanDirectories: string[];
    selfUpdate?: SelfUpdateRecord;
  };

export const emptyHomebrewCaskIndex: HomebrewCaskIndex = {
  byToken: {},
  byBundleIdentifier: {},
  byAppBundleName: {}
};

export const emptyHomebrewFormulaIndex: HomebrewFormulaIndex = {
  byToken: {}
};

export function defaultPersistedSnapshot(now = new Date().toISOString()): PersistedSnapshot {
  return {
    apps: [],
    updates: [],
    recentlyUpdated: [],
    homebrewItems: [],
    homebrewRecentlyUpdated: [],
    ignoredIDs: [],
    ignoredHomebrewItemIDs: [],
    additionalDirectories: [],
    selectedTab: "all",
    collapsedAppSectionIDs: [],
    collapsedHomebrewSectionIDs: [],
    autoRefreshEnabled: true,
    refreshIntervalMinutes: 60,
    appearancePreference: "system",
    useMasForAppStoreUpdates: true,
    showMenuBarIcon: true,
    profileStats: defaultProfileStats(now)
  };
}

export function defaultProfileStats(now = new Date().toISOString()): ProfileStats {
  return {
    createdAt: now,
    startedUsingAt: now,
    signatureVersion: profileStatsSignatureVersion,
    events: [],
    integrityStatus: "pending"
  };
}

export function normalizeAppearancePreference(value: unknown): AppearancePreference {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return "system";
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

export function homebrewPresentationLabel(
  kind: HomebrewManagedItemKind,
  presentation?: HomebrewPresentation
): string {
  if (kind === "formula") {
    return "Formula";
  }
  return {
    app: "App Cask",
    cli: "CLI Cask",
    package: "Package Cask",
    cask: "Cask",
    formula: "Formula"
  }[presentation ?? "cask"];
}
