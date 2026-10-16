// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { BaselineAPI } from "../shared/ipc";

export const baseline: Pick<
  BaselineAPI,
  | "acknowledgeProfileStatsReset"
  | "chooseDirectory"
  | "cleanUpHomebrew"
  | "copyDiagnostics"
  | "copyOperationFailure"
  | "dismissOperationFailure"
  | "getAppMetadata"
  | "getSnapshot"
  | "installHomebrewItem"
  | "onSnapshotChanged"
  | "onSnapshotProgress"
  | "openApp"
  | "openExternal"
  | "performAppUpdate"
  | "performHomebrewUpdate"
  | "performHomebrewUpdateAll"
  | "refresh"
  | "refreshToolStatus"
  | "removeDirectory"
  | "setSearchText"
  | "setSelectedTab"
  | "showMainWindow"
  | "showSettings"
  | "toggleIgnoredApp"
  | "toggleIgnoredHomebrew"
  | "uninstallHomebrewItem"
  | "updatePreferences"
> = {
  acknowledgeProfileStatsReset: (...args) => window.baseline.acknowledgeProfileStatsReset(...args),
  chooseDirectory: (...args) => window.baseline.chooseDirectory(...args),
  cleanUpHomebrew: (...args) => window.baseline.cleanUpHomebrew(...args),
  copyDiagnostics: (...args) => window.baseline.copyDiagnostics(...args),
  copyOperationFailure: (...args) => window.baseline.copyOperationFailure(...args),
  dismissOperationFailure: (...args) => window.baseline.dismissOperationFailure(...args),
  getAppMetadata: (...args) => window.baseline.getAppMetadata(...args),
  getSnapshot: (...args) => window.baseline.getSnapshot(...args),
  installHomebrewItem: (...args) => window.baseline.installHomebrewItem(...args),
  onSnapshotChanged: (...args) => window.baseline.onSnapshotChanged(...args),
  onSnapshotProgress: (...args) => window.baseline.onSnapshotProgress(...args),
  openApp: (...args) => window.baseline.openApp(...args),
  openExternal: (...args) => window.baseline.openExternal(...args),
  performAppUpdate: (...args) => window.baseline.performAppUpdate(...args),
  performHomebrewUpdate: (...args) => window.baseline.performHomebrewUpdate(...args),
  performHomebrewUpdateAll: (...args) => window.baseline.performHomebrewUpdateAll(...args),
  refresh: (...args) => window.baseline.refresh(...args),
  refreshToolStatus: (...args) => window.baseline.refreshToolStatus(...args),
  removeDirectory: (...args) => window.baseline.removeDirectory(...args),
  setSearchText: (...args) => window.baseline.setSearchText(...args),
  setSelectedTab: (...args) => window.baseline.setSelectedTab(...args),
  showMainWindow: (...args) => window.baseline.showMainWindow(...args),
  showSettings: (...args) => window.baseline.showSettings(...args),
  toggleIgnoredApp: (...args) => window.baseline.toggleIgnoredApp(...args),
  toggleIgnoredHomebrew: (...args) => window.baseline.toggleIgnoredHomebrew(...args),
  uninstallHomebrewItem: (...args) => window.baseline.uninstallHomebrewItem(...args),
  updatePreferences: (...args) => window.baseline.updatePreferences(...args)
};
