// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import type {
  BaselineSnapshot,
  AppearancePreference,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  MenuTab,
  ToolStatus
} from "./domain";
import type { HomebrewMaintenanceRunEvent } from "./homebrewProgress";

export const ipcChannels = {
  getSnapshot: "baseline:getSnapshot",
  getDiagnostics: "baseline:getDiagnostics",
  getToolStatus: "baseline:getToolStatus",
  refreshToolStatus: "baseline:refreshToolStatus",
  refresh: "baseline:refresh",
  setSearchText: "baseline:setSearchText",
  setSelectedTab: "baseline:setSelectedTab",
  updatePreferences: "baseline:updatePreferences",
  toggleIgnoredApp: "baseline:toggleIgnoredApp",
  toggleIgnoredHomebrew: "baseline:toggleIgnoredHomebrew",
  performAppUpdate: "baseline:performAppUpdate",
  performHomebrewUpdate: "baseline:performHomebrewUpdate",
  performHomebrewUpdateAll: "baseline:performHomebrewUpdateAll",
  installHomebrewItem: "baseline:installHomebrewItem",
  uninstallHomebrewItem: "baseline:uninstallHomebrewItem",
  openApp: "baseline:openApp",
  openExternal: "baseline:openExternal",
  chooseDirectory: "baseline:chooseDirectory",
  removeDirectory: "baseline:removeDirectory",
  copyDiagnostics: "baseline:copyDiagnostics",
  showMainWindow: "baseline:showMainWindow",
  showSettings: "baseline:showSettings",
  snapshotChanged: "baseline:snapshotChanged",
  refreshStateChanged: "baseline:refreshStateChanged",
  homebrewCommandEvent: "baseline:homebrewCommandEvent",
  toolStatusChanged: "baseline:toolStatusChanged"
} as const;

export type PreferencePatch = Partial<{
  selectedTab: MenuTab;
  collapsedAppSectionIDs: string[];
  collapsedHomebrewSectionIDs: string[];
  autoRefreshEnabled: boolean;
  refreshIntervalMinutes: number;
  appearancePreference: AppearancePreference;
  useMasForAppStoreUpdates: boolean;
  showMenuBarIcon: boolean;
}>;

export type BaselineAPI = {
  getSnapshot(): Promise<BaselineSnapshot>;
  getDiagnostics(): Promise<string>;
  getToolStatus(): Promise<ToolStatus>;
  refreshToolStatus(): Promise<void>;
  refresh(lightweight?: boolean): Promise<void>;
  setSearchText(searchText: string): Promise<void>;
  setSelectedTab(tab: MenuTab): Promise<void>;
  updatePreferences(patch: PreferencePatch): Promise<void>;
  toggleIgnoredApp(appID: string): Promise<void>;
  toggleIgnoredHomebrew(itemID: string): Promise<void>;
  performAppUpdate(appID: string): Promise<void>;
  performHomebrewUpdate(itemID: string): Promise<void>;
  performHomebrewUpdateAll(): Promise<void>;
  installHomebrewItem(item: HomebrewCaskDiscoveryItem): Promise<void>;
  uninstallHomebrewItem(itemID: string): Promise<void>;
  openApp(appID: string): Promise<void>;
  openExternal(url: string): Promise<boolean>;
  chooseDirectory(): Promise<string | undefined>;
  removeDirectory(path: string): Promise<void>;
  copyDiagnostics(): Promise<void>;
  showMainWindow(): Promise<void>;
  showSettings(): Promise<void>;
  onSnapshotChanged(callback: (snapshot: BaselineSnapshot) => void): () => void;
  onHomebrewCommandEvent(callback: (event: HomebrewMaintenanceRunEvent) => void): () => void;
};

export type { BaselineSnapshot, HomebrewCaskDiscoveryItem, HomebrewManagedItem, ToolStatus };
