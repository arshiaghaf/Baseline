import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell, Tray } from "electron";
import path from "node:path";
import { renderDiagnostics } from "../shared/diagnostics";
import type { BaselineSnapshot, HomebrewCaskDiscoveryItem, MenuTab } from "../shared/domain";
import { ipcChannels, type PreferencePatch } from "../shared/ipc";
import { isAllowedExternalURL } from "../shared/security";
import { SnapshotPersistence } from "./persistence";
import { UpdateStore } from "./updateStore";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | undefined;
let menuWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayBaseIcon: Electron.NativeImage | undefined;
let trayRefreshIcon: Electron.NativeImage | undefined;
let store: UpdateStore;
let isQuitting = false;

const trayRefreshIconDataURL =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAA0VXHyAAABIklEQVQ4EaWSP2pCQRCHTUidAySkCgErb5DSVBZapfIeOY6FjVYWgeANklIFCYiNSPAMFonf99wF9+3zD+QH3467+2acnZla7Z+6Cv6vwQ6CbWBb8Bj2C+wIvsM+M0NO5B7e4Q/W8BH4wf5CH24hk85j2MAcmnAoM+2AgSaQBdF5C1PowjNU6YFDg5hJoi92ph1ZJbfpxkx8Tj09vnznc8ziTZdrF2QXYieKgxOLWVqHJ7+5cUEvcAexjZ6dUq98aTqmFeeifH92b0EsjAU6Jgsbi6z9LH9oa8zCVlXJ1nZhBrbc1idyOCyOQdpQfo7D5ZA5bDo7fJkMYiY+x0BxlNf8Nm3H3HGPo5/9C3eFrIlZFK3CLkFnJ1XFll/atb1X1boDYBs/6p2bHjwAAAAASUVORK5CYII=";

const isDevelopment = !app.isPackaged;

if (process.env.BASELINE_USER_DATA_DIR) {
  app.setPath("userData", process.env.BASELINE_USER_DATA_DIR);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      showWindow(mainWindow);
    }
  });
}

if (hasSingleInstanceLock) {
  void app.whenReady().then(async () => {
    const persistence = new SnapshotPersistence(app.getPath("userData"));
    const persisted = await persistence.load();
    store = new UpdateStore({
      persistence,
      persisted,
      openExternalURL: async (url) => {
        if (!isAllowedExternalURL(url)) {
          return false;
        }
        await shell.openExternal(url);
        return true;
      },
      openAppBundle: async (bundlePath) => {
        await shell.openPath(bundlePath);
      }
    });

    createTray();
    createMainWindow("main");
    wireStoreEvents();
    wireIpc();
    if (process.env.BASELINE_SKIP_INITIAL_REFRESH === "1") {
      store.emit("snapshot", store.getSnapshot());
    } else {
      await store.start();
    }

    app.on("activate", () => {
      if (!mainWindow) {
        createMainWindow("main");
      } else {
        showWindow(mainWindow);
      }
    });
  });
}

app.on("window-all-closed", () => undefined);
app.on("before-quit", () => {
  isQuitting = true;
});

function createMainWindow(route: "main" | "settings"): BrowserWindow {
  mainWindow =
    mainWindow ??
    new BrowserWindow({
      width: 1020,
      height: 760,
      minWidth: 660,
      minHeight: 620,
      title: "Baseline",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 14 },
      vibrancy: "sidebar",
      visualEffectState: "active",
      transparent: true,
      backgroundColor: "#00000000",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  void loadRenderer(mainWindow, route);
  mainWindow.once("ready-to-show", () => showWindow(mainWindow));
  return mainWindow;
}

function createMenuWindow(): BrowserWindow {
  menuWindow =
    menuWindow ??
    new BrowserWindow({
      width: 440,
      height: 560,
      resizable: false,
      movable: true,
      title: "Baseline",
      vibrancy: "popover",
      visualEffectState: "active",
      transparent: true,
      backgroundColor: "#00000000",
      show: false,
      frame: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

  menuWindow.on("blur", () => {
    if (!isDevelopment) {
      menuWindow?.hide();
    }
  });

  void loadRenderer(menuWindow, "menubar");
  return menuWindow;
}

async function loadRenderer(
  window: BrowserWindow,
  route: "main" | "menubar" | "settings"
): Promise<void> {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#/${route}`);
  } else {
    await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
      hash: `/${route}`
    });
  }
}

function createTray(): void {
  trayBaseIcon = nativeImage.createFromDataURL(
    "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path fill="black" d="M9 1.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm0 2.2 4.7 8.1H4.3L9 3.7Z"/></svg>`
      )
  );
  trayBaseIcon.setTemplateImage(true);
  trayRefreshIcon = nativeImage.createFromDataURL(trayRefreshIconDataURL);
  trayRefreshIcon.setTemplateImage(true);
  tray = new Tray(trayBaseIcon);
  tray.setToolTip("Baseline");
  tray.on("click", toggleMenuWindow);
}

function toggleMenuWindow(): void {
  const window = createMenuWindow();
  if (window.isVisible()) {
    window.hide();
    return;
  }
  if (tray) {
    const bounds = tray.getBounds();
    const windowBounds = window.getBounds();
    window.setPosition(
      Math.round(bounds.x + bounds.width / 2 - windowBounds.width / 2),
      Math.round(bounds.y + bounds.height + 6),
      false
    );
  }
  window.setAlwaysOnTop(true, "pop-up-menu");
  window.showInactive();
}

function showMainWindow(route: "main" | "settings"): void {
  const window = createMainWindow(route);
  void loadRenderer(window, route);
  showWindow(window);
}

function showWindow(window?: BrowserWindow): void {
  if (!window) {
    return;
  }
  window.show();
  window.focus();
}

function wireStoreEvents(): void {
  store.on("snapshot", (snapshot) => {
    updateTrayStatus(snapshot);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.snapshotChanged, snapshot);
      window.webContents.send(ipcChannels.refreshStateChanged, {
        isRefreshing: snapshot.isRefreshing,
        refreshErrorMessage: snapshot.refreshErrorMessage,
        lastRefreshNoticeMessage: snapshot.lastRefreshNoticeMessage,
        lastRefreshDate: snapshot.lastRefreshDate
      });
      window.webContents.send(ipcChannels.toolStatusChanged, {
        isMasInstalled: snapshot.isMasInstalled,
        isHomebrewInstalled: snapshot.isHomebrewInstalled,
        isChecking: snapshot.isChecking,
        masTestMessage: snapshot.masTestMessage,
        masTestSucceeded: snapshot.masTestSucceeded
      });
    }
  });
  store.on("homebrewCommand", (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.homebrewCommandEvent, event);
    }
  });
}

function updateTrayStatus(snapshot: BaselineSnapshot): void {
  if (!tray) {
    return;
  }
  if (snapshot.isRefreshing) {
    if (trayRefreshIcon && !trayRefreshIcon.isEmpty()) {
      tray.setImage(trayRefreshIcon);
    }
    tray.setTitle("");
    return;
  }
  if (trayBaseIcon) {
    tray.setImage(trayBaseIcon);
  }
  tray.setTitle(trayUpdateTitle(snapshot));
}

function trayUpdateTitle(snapshot: BaselineSnapshot): string {
  const ignored = new Set(snapshot.ignoredIDs);
  const visibleUpdates = snapshot.updates.filter((update) => !ignored.has(update.appID)).length;
  if (visibleUpdates === 0) {
    return "✓";
  }
  return `${visibleUpdates}\u2009↓`;
}

function wireIpc(): void {
  ipcMain.handle(ipcChannels.getSnapshot, () => store.getSnapshot());
  ipcMain.handle(ipcChannels.getDiagnostics, () =>
    renderDiagnostics(store.getSnapshot(), app.getVersion(), process.platform)
  );
  ipcMain.handle(ipcChannels.getToolStatus, () => {
    const snapshot = store.getSnapshot();
    return {
      isMasInstalled: snapshot.isMasInstalled,
      isHomebrewInstalled: snapshot.isHomebrewInstalled,
      isChecking: snapshot.isChecking,
      masTestMessage: snapshot.masTestMessage,
      masTestSucceeded: snapshot.masTestSucceeded
    };
  });
  ipcMain.handle(ipcChannels.refresh, (_event, lightweight?: boolean) =>
    store.refresh(Boolean(lightweight))
  );
  ipcMain.handle(ipcChannels.setSearchText, (_event, value: string) =>
    store.setSearchText(String(value))
  );
  ipcMain.handle(ipcChannels.setSelectedTab, (_event, tab: MenuTab) => store.setSelectedTab(tab));
  ipcMain.handle(ipcChannels.updatePreferences, (_event, patch: PreferencePatch) =>
    store.updatePreferences(patch)
  );
  ipcMain.handle(ipcChannels.toggleIgnoredApp, (_event, appID: string) =>
    store.toggleIgnoredApp(String(appID))
  );
  ipcMain.handle(ipcChannels.toggleIgnoredHomebrew, (_event, itemID: string) =>
    store.toggleIgnoredHomebrew(String(itemID))
  );
  ipcMain.handle(ipcChannels.performAppUpdate, (_event, appID: string) =>
    store.performAppUpdate(String(appID))
  );
  ipcMain.handle(ipcChannels.performHomebrewUpdate, (_event, itemID: string) =>
    store.performHomebrewUpdate(String(itemID))
  );
  ipcMain.handle(ipcChannels.performHomebrewUpdateAll, () => store.performHomebrewUpdateAll());
  ipcMain.handle(ipcChannels.installHomebrewItem, (_event, item: HomebrewCaskDiscoveryItem) =>
    store.installHomebrewItem(item)
  );
  ipcMain.handle(ipcChannels.uninstallHomebrewItem, (_event, itemID: string) =>
    store.uninstallHomebrewItem(String(itemID))
  );
  ipcMain.handle(ipcChannels.openApp, (_event, appID: string) => store.openApp(String(appID)));
  ipcMain.handle(ipcChannels.openExternal, (_event, url: string) =>
    store.openExternal(String(url))
  );
  ipcMain.handle(ipcChannels.chooseDirectory, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      buttonLabel: "Add"
    });
    const directory = result.filePaths[0];
    if (result.canceled || !directory) {
      return undefined;
    }
    await store.addDirectory(directory);
    return directory;
  });
  ipcMain.handle(ipcChannels.removeDirectory, (_event, directory: string) =>
    store.removeDirectory(String(directory))
  );
  ipcMain.handle(ipcChannels.copyDiagnostics, () => {
    clipboard.writeText(renderDiagnostics(store.getSnapshot(), app.getVersion(), process.platform));
  });
  ipcMain.handle(ipcChannels.showMainWindow, () => showMainWindow("main"));
  ipcMain.handle(ipcChannels.showSettings, () => showMainWindow("settings"));
}
