// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { confirmHomebrewCleanup } from "./homebrewCleanupConfirmation";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
  systemPreferences,
  Tray
} from "electron";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { appMetadata } from "./appMetadata";
import { renderDiagnostics } from "../shared/diagnostics";
import type {
  AppearancePreference,
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  MenuTab
} from "../shared/domain";
import {
  homebrewItemForAppUpdate,
  homebrewItemHasAppRepresentation
} from "../shared/homebrewAppLinking";
import { ipcChannels, type PreferencePatch } from "../shared/ipc";
import { isAllowedExternalURL } from "../shared/security";
import { SnapshotPersistence } from "./persistence";
import { calculateTrayWindowPosition } from "./trayWindowPosition";
import { UpdateStore } from "./updateStore";
import { trayMenuTemplate } from "./trayMenu";
import { createTrayIcons } from "./trayIcons";
import { TrayRefreshAnimation } from "./trayRefreshAnimation";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | undefined;
let mainWindowRoute: "main" | "settings" | undefined;
let menuWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayIcons: ReturnType<typeof createTrayIcons> | undefined;
let trayAnimation: TrayRefreshAnimation | undefined;
let stopTrayMotionObservation: (() => void) | undefined;
let store: UpdateStore;
let isQuitting = false;
let quitTask: Promise<void> | undefined;
let quitNoticeOpen = false;
let dockShowTask: Promise<void> | undefined;
let lastDockShowTime = -Infinity;
let dockHideTimer: ReturnType<typeof setTimeout> | undefined;
let selfUpdateCheckOpen = false;
let metadata: ReturnType<typeof appMetadata>;

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

    const persistence = new SnapshotPersistence(app.getPath("userData"));
    const persisted = await persistence.load();
    applyAppearancePreference(persisted.appearancePreference);
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
      destroyTray();
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
  if (tray) {
    return;
  }
  trayIcons ??= createTrayIcons();
  const nativeTray = new Tray(trayIcons.idle);
  tray = nativeTray;
  const icons = trayIcons;
  trayAnimation = new TrayRefreshAnimation((frame) => {
    if (!nativeTray.isDestroyed()) {
      nativeTray.setImage(frame === undefined ? icons.idle : icons.refreshing[frame]!);
    }
  });
  const motionChanged = () => {
    if (!isQuitting) updateExistingTrayStatus(store.getSnapshot());
  };
  nativeTheme.on("updated", motionChanged);
  const motionSubscription =
    process.platform === "darwin"
      ? systemPreferences.subscribeWorkspaceNotification(
          "NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification",
          motionChanged
        )
      : undefined;
  stopTrayMotionObservation = () => {
    nativeTheme.removeListener("updated", motionChanged);
    if (motionSubscription !== undefined) {
      systemPreferences.unsubscribeWorkspaceNotification(motionSubscription);
    }
  };

  tray.setToolTip("Baseline");
  tray.on("click", toggleMenuWindow);
  tray.on("right-click", () => {
    menuWindow?.hide();
    tray?.popUpContextMenu(createTrayContextMenu());
  });
  updateExistingTrayStatus(store.getSnapshot());
}

function createTrayContextMenu(): Menu {
  return Menu.buildFromTemplate(
    trayMenuTemplate({
      store,
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
  trayAnimation?.dispose();
  trayAnimation = undefined;
  stopTrayMotionObservation?.();
  stopTrayMotionObservation = undefined;
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
  store.on("homebrewCommand", (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.homebrewCommandEvent, event);
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
  if (isQuitting) return;
  if (!snapshot.showMenuBarIcon) {
    destroyTray();
    return;
  }
  createTray();
  updateExistingTrayStatus(snapshot);
}

function updateExistingTrayStatus(snapshot: BaselineSnapshot): void {
  if (!tray || isQuitting) return;
  const { prefersReducedMotion } = systemPreferences.getAnimationSettings();
  trayAnimation?.update(snapshot.isRefreshing, prefersReducedMotion);
  tray.setToolTip(
    snapshot.isRefreshing ? "Baseline — Checking installed apps for updates…" : "Baseline"
  );
  tray.setTitle(snapshot.isRefreshing ? "" : trayUpdateTitle(snapshot));
}

function trayUpdateTitle(snapshot: BaselineSnapshot): string {
  const ignored = new Set(snapshot.ignoredIDs);
  const ignoredHomebrew = new Set(snapshot.ignoredHomebrewItemIDs);
  const visibleAppUpdates = snapshot.updates.filter(
    (update) =>
      !ignored.has(update.appID) &&
      !(
        update.source === "homebrew" &&
        homebrewItemForAppUpdate(update, snapshot.homebrewItems)?.pinned
      )
  );
  const visibleAppUpdateIDs = new Set(visibleAppUpdates.map((update) => update.appID));
  const appsRepresentedOutsideHomebrew = snapshot.apps.filter(
    (app) => visibleAppUpdateIDs.has(app.id) || ignored.has(app.id)
  );
  const visibleHomebrewUpdates = snapshot.homebrewItems.filter(
    (item) =>
      item.isOutdated &&
      !item.pinned &&
      !ignoredHomebrew.has(item.id) &&
      !homebrewItemHasAppRepresentation(item, appsRepresentedOutsideHomebrew)
  );
  const visibleUpdates = visibleAppUpdates.length + visibleHomebrewUpdates.length;
  if (visibleUpdates === 0) {
    return "✓";
  }
  return `${visibleUpdates}\u2009↓`;
}

function wireIpc(): void {
  ipcMain.handle(ipcChannels.getSnapshot, () => store.getSnapshot());
  ipcMain.handle(ipcChannels.getAppMetadata, () => metadata);
  ipcMain.handle(ipcChannels.getDiagnostics, () =>
    renderDiagnostics(store.getSnapshot(), metadata, process.platform)
  );
  ipcMain.handle(ipcChannels.getToolStatus, () => {
    const snapshot = store.getSnapshot();
    return {
      isMasInstalled: snapshot.isMasInstalled,
      isHomebrewInstalled: snapshot.isHomebrewInstalled,
      isChecking: snapshot.isChecking
    };
  });
  ipcMain.handle(ipcChannels.cleanUpHomebrew, (event) =>
    store.cleanUpHomebrew(() => confirmHomebrewCleanup(BrowserWindow.fromWebContents(event.sender)))
  );
  ipcMain.handle(ipcChannels.refreshToolStatus, () => store.refreshToolStatus());
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
  ipcMain.handle(ipcChannels.acknowledgeProfileStatsReset, () =>
    store.acknowledgeProfileStatsReset()
  );
  ipcMain.handle(ipcChannels.dismissOperationFailure, (_event, id: unknown) =>
    typeof id === "string" ? store.dismissOperationFailure(id) : undefined
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
  ipcMain.handle(ipcChannels.performHomebrewUpdateAll, (_event, itemIDs?: unknown) =>
    store.performHomebrewUpdateAll(
      Array.isArray(itemIDs) ? itemIDs.map((itemID) => String(itemID)) : undefined
    )
  );
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
    clipboard.writeText(renderDiagnostics(store.getSnapshot(), metadata, process.platform));
  });
  ipcMain.handle(ipcChannels.showMainWindow, () => showMainWindow("main"));
  ipcMain.handle(ipcChannels.showSettings, () => showMainWindow("settings"));
}
