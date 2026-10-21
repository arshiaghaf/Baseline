// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { performPermissionGuideAction } from "./permissionGuide";
import { configureAdminAskpass, focusAdminAskpass } from "./adminAskpassRuntime";
import { confirmHomebrewCleanup } from "./homebrewCleanupConfirmation";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  nativeImage,
  screen,
  shell,
  Tray
} from "electron";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { appMetadata } from "./appMetadata";
import { renderDiagnostics } from "../shared/diagnostics";
import type {
  AppearancePreference,
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  MenuTab
} from "../shared/domain";
import { trayUpdateTitle } from "./trayStatus";
import { ipcChannels, type PreferencePatch } from "../shared/ipc";
import { isAllowedExternalURL } from "../shared/security";
import { SnapshotPersistence } from "./persistence";
import { calculateTrayWindowPosition } from "./trayWindowPosition";
import { UpdateStore } from "./updateStore";
import { catalogueCacheDirectory } from "./catalogueCacheDirectory";
import { isTrustedBackendSender } from "./backendIpcAuthorization";
import { backendIpcRegistrar } from "./backendIpc";
import type { HomebrewDiagnosticsRequest } from "../shared/homebrewDiagnostics";
import { trayMenuTemplate } from "./trayMenu";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | undefined;
let mainWindowRoute: "main" | "settings" | undefined;
let menuWindow: BrowserWindow | undefined;
let permissionGuideWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayBaseIcon: Electron.NativeImage | undefined;
let trayRefreshIcon: Electron.NativeImage | undefined;
let store: UpdateStore;
let isQuitting = false;
let quitTask: Promise<void> | undefined;
let quitNoticeOpen = false;
let dockShowTask: Promise<void> | undefined;
let lastDockShowTime = -Infinity;
let dockHideTimer: ReturnType<typeof setTimeout> | undefined;
let selfUpdateCheckOpen = false;
let metadata: ReturnType<typeof appMetadata>;

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
    metadata = appMetadata(app);
    app.setAboutPanelOptions({
      applicationVersion: metadata.version,
      version: metadata.buildNumber,
      copyright: "© 2026 Arshia Ghaf"
    });

    if (app.isPackaged) {
      await configureAdminAskpass(path.join(process.resourcesPath, "admin-askpass"));
    }

    const persistence = new SnapshotPersistence(app.getPath("userData"));
    const persisted = await persistence.load();
    applyAppearancePreference(persisted.appearancePreference);
    store = new UpdateStore({
      persistence,
      persisted,
      catalogueCacheRoot: catalogueCacheDirectory(
        app.getPath("home"),
        app.getPath("userData"),
        Boolean(process.env.BASELINE_USER_DATA_DIR)
      ),
      openExternalURL: async (url) => {
        if (!isAllowedExternalURL(url)) {
          return false;
        }
        await shell.openExternal(url);
        return true;
      },
      openAppBundle: async (bundlePath) => {
        await shell.openPath(bundlePath);
      },
      currentAppVersion: metadata.version,
      currentAppIdentity: {
        bundleIdentifier: "com.arshiaghaf.baseline",
        bundlePath: app.isPackaged
          ? await realpath(path.resolve(path.dirname(app.getPath("exe")), "../..")).catch(() =>
              path.resolve(path.dirname(app.getPath("exe")), "../..")
            )
          : undefined
      }
    });

    createMainWindow("main");
    wireStoreEvents();
    wireIpc();
    void verifyProfileStatsIntegrityAfterLaunch();
    syncAppVisibility(store.getSnapshot());
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
app.on("before-quit", (event) => {
  if (isQuitting || !store) return;
  event.preventDefault();
  if (store.hasActiveUpdateOperation()) {
    // Keep the existing wait-before-quit policy. A waiting dialog must stay
    // reachable so the user can answer or cancel, then quit after reconciliation.
    if (focusCurrentAdminPrompt()) return;
    if (!quitNoticeOpen) {
      quitNoticeOpen = true;
      void dialog
        .showMessageBox({
          type: "info",
          message: "An app or Homebrew operation is still running",
          detail:
            "Wait for the current check, update, installation, removal, or Homebrew cleanup to finish, then quit Baseline.",
          buttons: ["OK"]
        })
        .finally(() => {
          quitNoticeOpen = false;
        });
    }
    return;
  }
  quitTask ??= store
    .prepareToQuit()
    .then((readyToQuit) => {
      if (!readyToQuit) {
        quitTask = undefined;
        app.quit();
        return;
      }
      if (dockHideTimer) clearTimeout(dockHideTimer);
      isQuitting = true;
      app.quit();
    })
    .catch(() => {
      quitTask = undefined;
      void dialog.showMessageBox({
        type: "error",
        message: "Baseline could not finish saving",
        detail: "Try quitting again after the current save finishes.",
        buttons: ["OK"]
      });
    });
});
app.on("did-resign-active", hideMenuWindowForNativeDismissal);

async function verifyProfileStatsIntegrityAfterLaunch(): Promise<void> {
  try {
    await store.verifyProfileStatsIntegrity();
  } catch {
    // Profile stats should never block app launch or normal update checks.
  }
}

function createMainWindow(route: "main" | "settings"): BrowserWindow {
  if (mainWindow) {
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
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

  mainWindow.on("close", handleMainWindowClose);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
    mainWindowRoute = undefined;
  });
  mainWindow.webContents.on("did-finish-load", () => syncMainWindowRoute(mainWindow));
  mainWindow.webContents.on("did-navigate-in-page", () => syncMainWindowRoute(mainWindow));

  mainWindowRoute = route;
  void loadRenderer(mainWindow, route);
  mainWindow.once("ready-to-show", () => showWindow(mainWindow));
  return mainWindow;
}

function showPermissionGuide(): void {
  if (permissionGuideWindow && !permissionGuideWindow.isDestroyed()) {
    permissionGuideWindow.showInactive();
    return;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(320, area.width);
  const height = Math.min(224, area.height);
  const window = new BrowserWindow({
    width,
    height,
    x: area.x + area.width - width,
    y: area.y + area.height - height,
    minWidth: Math.min(320, width),
    minHeight: Math.min(240, height),
    title: "App Management help",
    frame: false,
    type: process.platform === "darwin" ? "panel" : undefined,
    vibrancy: "popover",
    visualEffectState: "active",
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  permissionGuideWindow = window;
  let displayed = false;
  window.on("closed", () => {
    if (displayed)
      void store.updatePreferences({ updateIntroductionDismissed: true }).catch(() => {});
    if (permissionGuideWindow === window) permissionGuideWindow = undefined;
  });
  const clamp = () => {
    if (window.isDestroyed()) return;
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    window.setMinimumSize(Math.min(320, area.width), Math.min(240, area.height));
    window.setBounds({
      x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
      y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)),
      width: Math.min(bounds.width, area.width),
      height: Math.min(bounds.height, area.height)
    });
  };
  screen.on("display-metrics-changed", clamp);
  screen.on("display-removed", clamp);
  window.on("closed", () => {
    screen.removeListener("display-metrics-changed", clamp);
    screen.removeListener("display-removed", clamp);
  });
  void loadRenderer(window, "permission-guide")
    .then(() => {
      if (!window.isDestroyed()) {
        window.showInactive();
        displayed = true;
      }
    })
    .catch(() => {
      if (!window.isDestroyed()) window.close();
    });
}

function createMenuWindow(): BrowserWindow {
  if (menuWindow) {
    return menuWindow;
  }

  menuWindow = new BrowserWindow({
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
    // A native panel takes keyboard focus without activating Baseline or
    // leaving the user's current full-screen Space.
    type: process.platform === "darwin" ? "panel" : undefined,
    fullscreenable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  menuWindow.on("blur", hideMenuWindowForNativeDismissal);
  menuWindow.on("closed", () => {
    menuWindow = undefined;
  });

  void loadRenderer(menuWindow, "menubar");
  return menuWindow;
}

async function loadRenderer(
  window: BrowserWindow,
  route: "main" | "menubar" | "settings" | "permission-guide"
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
  if (tray) {
    return;
  }
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
  tray.on("right-click", () => {
    menuWindow?.hide();
    tray?.popUpContextMenu(createTrayContextMenu());
  });
}

function createTrayContextMenu(): Menu {
  return Menu.buildFromTemplate(
    trayMenuTemplate({
      store,
      showMainWindow: () => showMainWindow("main"),
      showSettings: () => showMainWindow("settings"),
      checkForUpdates: checkForBaselineUpdates,
      isCheckingForUpdates: selfUpdateCheckOpen,
      quit: () => app.quit()
    })
  );
}

async function checkForBaselineUpdates(): Promise<void> {
  if (selfUpdateCheckOpen) return;
  selfUpdateCheckOpen = true;
  try {
    const update = await store.checkForSelfUpdate();
    if (isQuitting || quitTask) return;
    if (update?.available && update.releaseURL) {
      const result = await dialog.showMessageBox({
        type: "info",
        message: "A Baseline update is available",
        detail: `Baseline ${update.latestVersion?.raw ?? ""} is available. You are using ${metadata.version}. Open the release page to download it.`,
        buttons: ["Open Release Page", "Later"],
        defaultId: 0,
        cancelId: 1
      });
      if (result.response === 0 && !isQuitting && !quitTask)
        await store.openExternal(update.releaseURL);
    } else {
      await dialog.showMessageBox({
        type: "info",
        message: update?.latestVersion
          ? "Baseline is up to date"
          : "Could not check for Baseline updates",
        detail: update?.latestVersion
          ? `You are using Baseline ${metadata.version}. No newer release is available.`
          : "Check your internet connection and try again.",
        buttons: ["OK"]
      });
    }
  } finally {
    selfUpdateCheckOpen = false;
  }
}

function destroyTray(): void {
  menuWindow?.destroy();
  menuWindow = undefined;
  tray?.destroy();
  tray = undefined;
}

function toggleMenuWindow(): void {
  // A recovery tray remains usable even when the preference is off because
  // macOS could not restore the Dock icon.
  if (!tray) {
    return;
  }
  const window = createMenuWindow();
  if (window.isVisible()) {
    window.hide();
    return;
  }
  if (tray) {
    const bounds = tray.getBounds();
    const windowBounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const position = calculateTrayWindowPosition(bounds, windowBounds, display);
    window.setPosition(position.x, position.y, false);
  }
  window.setAlwaysOnTop(true, "pop-up-menu");
  window.show();
  focusCurrentAdminPrompt();
}

function hideMenuWindowForNativeDismissal(): void {
  if (!isDevelopment) {
    menuWindow?.hide();
  }
}

function handleMainWindowClose(event: Electron.Event): void {
  if (!isQuitting) {
    event.preventDefault();
    mainWindow?.hide();
  }
}

function syncMainWindowRoute(window?: BrowserWindow): void {
  const route = mainWindowRouteFromURL(window?.webContents.getURL());
  if (route) {
    mainWindowRoute = route;
  }
}

function mainWindowRouteFromURL(url?: string): "main" | "settings" | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const route = new URL(url).hash.replace(/^#\/?/u, "");
    if (route === "main" || route === "settings") {
      return route;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function showMainWindow(route: "main" | "settings"): void {
  menuWindow?.hide();
  const window = createMainWindow(route);
  const currentRoute = mainWindowRouteFromURL(window.webContents.getURL()) ?? mainWindowRoute;
  if (currentRoute !== route) {
    mainWindowRoute = route;
    void loadRenderer(window, route);
  }
  showWindow(window);
}

function showWindow(window?: BrowserWindow): void {
  if (!window) {
    return;
  }
  window.show();
  window.focus();
  focusCurrentAdminPrompt();
}

function focusCurrentAdminPrompt(): boolean {
  const operation = store?.getSnapshot().homebrewOperation;
  return operation?.phase === "waiting" && operation.waitingPromptID
    ? focusAdminAskpass(operation.id, operation.waitingPromptID)
    : false;
}

function wireStoreEvents(): void {
  store.on("progress", (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.snapshotProgress, event);
    }
  });
  store.on("snapshot", (snapshot) => {
    applyAppearancePreference(snapshot.appearancePreference);
    syncAppVisibility(snapshot);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.snapshotChanged, snapshot);
    }
  });
}

function applyAppearancePreference(preference: AppearancePreference): void {
  nativeTheme.themeSource = preference;
}

function syncAppVisibility(snapshot: BaselineSnapshot): void {
  if (snapshot.showMenuBarIcon) updateTrayStatus(snapshot);
  if (!app.dock) {
    if (!snapshot.showMenuBarIcon) destroyTray();
    return;
  }
  if (snapshot.showDockIcon && dockHideTimer) {
    clearTimeout(dockHideTimer);
    dockHideTimer = undefined;
  }
  if (!snapshot.showDockIcon && tray && !dockShowTask) {
    // Electron ignores Dock hides for one second after show to avoid duplicate
    // macOS Dock icons. Replay the latest preference after that cooldown.
    const remainingCooldown = 1100 - (performance.now() - lastDockShowTime);
    if (remainingCooldown > 0) {
      dockHideTimer ??= setTimeout(() => {
        dockHideTimer = undefined;
        if (!isQuitting) syncAppVisibility(store.getSnapshot());
      }, remainingCooldown);
      return;
    }
    if (app.dock.isVisible()) app.dock.hide();
    return;
  }
  if (snapshot.showDockIcon && !app.dock.isVisible()) {
    if (dockShowTask) return;
    lastDockShowTime = performance.now();
    dockShowTask ??= app.dock
      .show()
      .then(() => {
        dockShowTask = undefined;
        if (!isQuitting) syncAppVisibility(store.getSnapshot());
      })
      .catch(() => {
        dockShowTask = undefined;
        // Retain an entry point if macOS cannot restore the Dock icon.
        createTray();
      });
    return;
  }
  if (snapshot.showDockIcon && !snapshot.showMenuBarIcon) destroyTray();
}

function updateTrayStatus(snapshot: BaselineSnapshot): void {
  if (!snapshot.showMenuBarIcon) {
    destroyTray();
    return;
  }
  createTray();
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

function wireIpc(): void {
  const handle = backendIpcRegistrar(ipcMain, requireBackendSender);
  handle("permissionGuide", (event, action) =>
    performPermissionGuideAction(action, event.sender, {
      show: showPermissionGuide,
      close: () => {
        permissionGuideWindow?.close();
        showMainWindow("main");
      }
    })
  );
  handle("getSnapshot", () => store.getSnapshot());
  handle("getAppMetadata", () => metadata);
  handle(
    "getDiagnostics",
    () =>
      renderDiagnostics(store.getSnapshot(), metadata, process.platform) +
      store.getCatalogueDiagnostics()
  );
  handle("collectHomebrewDiagnostics", (_event, request?: HomebrewDiagnosticsRequest) => {
    return store.collectHomebrewDiagnostics(request);
  });
  handle("getHomebrewInstalledContext", (_event, itemID: string) => {
    return store.getHomebrewInstalledContext(itemID);
  });
  handle("getToolStatus", () => {
    const snapshot = store.getSnapshot();
    return {
      isMasInstalled: snapshot.isMasInstalled,
      isHomebrewInstalled: snapshot.isHomebrewInstalled,
      isChecking: snapshot.isChecking
    };
  });
  handle("cleanUpHomebrew", (event) =>
    store.cleanUpHomebrew(() => confirmHomebrewCleanup(BrowserWindow.fromWebContents(event.sender)))
  );
  handle("refreshToolStatus", () => store.refreshToolStatus());
  handle("refresh", (_event, lightweight?: boolean, forceAppDiscovery?: boolean) =>
    store.refresh(lightweight, { forceAppDiscovery })
  );
  handle("setSearchText", (_event, value: string) => store.setSearchText(value));
  handle("setSelectedTab", (_event, tab: MenuTab) => store.setSelectedTab(tab));
  handle("updatePreferences", (_event, patch: PreferencePatch) => store.updatePreferences(patch));
  handle("acknowledgeProfileStatsReset", () => store.acknowledgeProfileStatsReset());
  handle("dismissOperationFailure", (_event, id: string) => store.dismissOperationFailure(id));
  handle("toggleIgnoredApp", (_event, appID: string) => store.toggleIgnoredApp(appID));
  handle("toggleIgnoredHomebrew", (_event, itemID: string) => store.toggleIgnoredHomebrew(itemID));
  handle("performAppUpdate", (_event, appID: string) => store.performAppUpdate(appID));
  handle("performHomebrewUpdate", (_event, itemID: string) => store.performHomebrewUpdate(itemID));
  handle("performHomebrewUpdateAll", (_event, itemIDs?: string[]) =>
    store.performHomebrewUpdateAll(itemIDs)
  );
  handle("installHomebrewItem", (_event, item: HomebrewCaskDiscoveryItem) =>
    store.installHomebrewItem(item)
  );
  handle("uninstallHomebrewItem", (_event, itemID: string) => store.uninstallHomebrewItem(itemID));
  handle("openApp", (_event, appID: string) => store.openApp(appID));
  handle("openExternal", (_event, url: string) => store.openExternal(url));
  handle("chooseDirectory", async () => {
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
  handle("removeDirectory", (_event, directory: string) => store.removeDirectory(directory));
  handle("copyOperationFailure", (_event, id: string, attemptID: string) => {
    const text = store.operationFailureText(id, attemptID);
    if (!text) return false;
    clipboard.writeText(text);
    return true;
  });
  handle("copyDiagnostics", () => {
    clipboard.writeText(
      renderDiagnostics(store.getSnapshot(), metadata, process.platform) +
        store.getCatalogueDiagnostics()
    );
  });
  handle("showMainWindow", () => showMainWindow("main"));
  handle("showSettings", () => showMainWindow("settings"));
}

function requireBackendSender(event: Electron.IpcMainInvokeEvent): void {
  const windows = [mainWindow, menuWindow, permissionGuideWindow].filter(
    (window): window is BrowserWindow => Boolean(window && !window.isDestroyed())
  );
  const documentURL =
    MAIN_WINDOW_VITE_DEV_SERVER_URL ||
    pathToFileURL(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)).href;
  if (
    !isTrustedBackendSender(
      event,
      windows.map((window) => window.webContents),
      documentURL
    )
  ) {
    throw new Error("Untrusted diagnostics caller");
  }
}
