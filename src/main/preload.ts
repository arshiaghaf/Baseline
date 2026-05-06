import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels, type BaselineAPI, type PreferencePatch } from "../shared/ipc";
import type { HomebrewCaskDiscoveryItem } from "../shared/domain";
import type { HomebrewMaintenanceRunEvent } from "../shared/homebrewProgress";

const api: BaselineAPI = {
  getSnapshot: () => ipcRenderer.invoke(ipcChannels.getSnapshot),
  getDiagnostics: () => ipcRenderer.invoke(ipcChannels.getDiagnostics),
  getToolStatus: () => ipcRenderer.invoke(ipcChannels.getToolStatus),
  refreshToolStatus: () => ipcRenderer.invoke(ipcChannels.refreshToolStatus),
  refresh: (lightweight?: boolean) => ipcRenderer.invoke(ipcChannels.refresh, lightweight),
  setSearchText: (searchText: string) => ipcRenderer.invoke(ipcChannels.setSearchText, searchText),
  setSelectedTab: (tab) => ipcRenderer.invoke(ipcChannels.setSelectedTab, tab),
  updatePreferences: (patch: PreferencePatch) =>
    ipcRenderer.invoke(ipcChannels.updatePreferences, patch),
  toggleIgnoredApp: (appID: string) => ipcRenderer.invoke(ipcChannels.toggleIgnoredApp, appID),
  toggleIgnoredHomebrew: (itemID: string) =>
    ipcRenderer.invoke(ipcChannels.toggleIgnoredHomebrew, itemID),
  performAppUpdate: (appID: string) => ipcRenderer.invoke(ipcChannels.performAppUpdate, appID),
  performHomebrewUpdate: (itemID: string) =>
    ipcRenderer.invoke(ipcChannels.performHomebrewUpdate, itemID),
  performHomebrewUpdateAll: () => ipcRenderer.invoke(ipcChannels.performHomebrewUpdateAll),
  installHomebrewItem: (item: HomebrewCaskDiscoveryItem) =>
    ipcRenderer.invoke(ipcChannels.installHomebrewItem, item),
  uninstallHomebrewItem: (itemID: string) =>
    ipcRenderer.invoke(ipcChannels.uninstallHomebrewItem, itemID),
  openApp: (appID: string) => ipcRenderer.invoke(ipcChannels.openApp, appID),
  openExternal: (url: string) => ipcRenderer.invoke(ipcChannels.openExternal, url),
  chooseDirectory: () => ipcRenderer.invoke(ipcChannels.chooseDirectory),
  removeDirectory: (path: string) => ipcRenderer.invoke(ipcChannels.removeDirectory, path),
  copyDiagnostics: () => ipcRenderer.invoke(ipcChannels.copyDiagnostics),
  showMainWindow: () => ipcRenderer.invoke(ipcChannels.showMainWindow),
  showSettings: () => ipcRenderer.invoke(ipcChannels.showSettings),
  onSnapshotChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      snapshot: Awaited<ReturnType<BaselineAPI["getSnapshot"]>>
    ) => {
      callback(snapshot);
    };
    ipcRenderer.on(ipcChannels.snapshotChanged, listener);
    return () => ipcRenderer.off(ipcChannels.snapshotChanged, listener);
  },
  onHomebrewCommandEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: HomebrewMaintenanceRunEvent) => {
      callback(event);
    };
    ipcRenderer.on(ipcChannels.homebrewCommandEvent, listener);
    return () => ipcRenderer.off(ipcChannels.homebrewCommandEvent, listener);
  }
};

contextBridge.exposeInMainWorld("baseline", api);
