// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { _electron as electron, expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultPersistedSnapshot } from "../src/shared/domain";
import { version } from "../src/shared/version";
import type { E2ECommandControl } from "./commandRunner";
import { cleanupApplications } from "./applicationCleanup";

const profileTestSecret = randomBytes(32).toString("base64url");
const launchedApps = new Set<Awaited<ReturnType<typeof electron.launch>>>();
const userDataDirectories = new Set<string>();

type NativeTrayProbe = {
  tray?: Electron.Tray;
  menu?: Electron.Menu;
  dialogs: Electron.MessageBoxOptions[];
  command: E2ECommandControl;
  selfUpdateChecks: number;
  restoreDockShow?: () => void;
};

test.afterEach(async () => {
  await cleanupApplications(launchedApps, async (app) => {
    await app
      .evaluate(() =>
        (
          globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe }
        ).nativeTrayProbe?.command.finish?.()
      )
      .catch(() => undefined);
  });
  launchedApps.clear();
  await Promise.all(
    [...userDataDirectories].map((directory) => rm(directory, { recursive: true, force: true }))
  );
  userDataDirectories.clear();
});

const expectedBaselineAPI = [
  "acknowledgeProfileStatsReset",
  "chooseDirectory",
  "cleanUpHomebrew",
  "copyDiagnostics",
  "dismissOperationFailure",
  "getAppMetadata",
  "getDiagnostics",
  "getSnapshot",
  "getToolStatus",
  "installHomebrewItem",
  "onHomebrewCommandEvent",
  "onSnapshotChanged",
  "onSnapshotProgress",
  "openApp",
  "openExternal",
  "performAppUpdate",
  "performHomebrewUpdate",
  "performHomebrewUpdateAll",
  "refresh",
  "refreshToolStatus",
  "removeDirectory",
  "setSearchText",
  "setSelectedTab",
  "showMainWindow",
  "showSettings",
  "toggleIgnoredApp",
  "toggleIgnoredHomebrew",
  "uninstallHomebrewItem",
  "updatePreferences"
];

async function launchBaseline(options: { packaged?: boolean; userData?: string } = {}) {
  const appDirectory = process.env.BASELINE_E2E_APP_DIR;
  const executablePath = process.env.BASELINE_E2E_EXECUTABLE;
  if (!appDirectory || !executablePath) {
    throw new Error("Run smoke tests through the isolated E2E global setup.");
  }
  const userData = options.userData ?? (await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-")));
  if (
    path.dirname(await realpath(userData)) !== (await realpath(os.tmpdir())) ||
    !path.basename(userData).startsWith("baseline-e2e-")
  ) {
    throw new Error("Electron smoke tests require a disposable temporary user-data directory.");
  }
  userDataDirectories.add(userData);
  const common = {
    env: {
      ...process.env,
      BASELINE_E2E_PROFILE_SECRET: profileTestSecret,
      BASELINE_SKIP_INITIAL_REFRESH: "1",
      BASELINE_USER_DATA_DIR: userData
    }
  };

  let app;
  if (options.packaged) {
    await access(executablePath);
    app = await electron.launch({ ...common, executablePath });
  } else {
    app = await electron.launch({ ...common, args: [appDirectory] });
  }
  launchedApps.add(app);
  return app;
}

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  const closePromise = app.waitForEvent("close");
  await app
    .evaluate(async ({ app }) => {
      app.quit();
    })
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        /Execution context was destroyed|Target page, context or browser has been closed/u.test(
          error.message
        )
      ) {
        return;
      }
      throw error;
    });
  await closePromise;
  launchedApps.delete(app);
}

test("launches the Electron shell and renders the dashboard", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  const app = await launchBaseline({ userData });
  const runtime = await app.evaluate(() => ({
    electron: process.versions.electron,
    node: process.versions.node
  }));
  expect(runtime.electron?.split(".")[0]).toBe("44");
  expect(runtime.node.split(".")[0]).toBe("24");
  console.log(`Smoke runtime: Electron ${runtime.electron}; Node ${runtime.node}`);

  const page = await app.firstWindow();
  await expect(page).toHaveTitle("Baseline");
  await expect(page.locator("h1")).toContainText("All");
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "All", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apps", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Homebrew", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("h1")).toContainText("All");
  const searchDialog = page.getByRole("dialog", { name: "Search" });
  await expect(searchDialog).toBeVisible();
  const searchField = searchDialog.getByPlaceholder("Search");
  await expect(searchField).toBeVisible();
  await searchField.fill("missing-app");
  await expect(searchDialog.getByText("No matches found.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(searchDialog).not.toBeVisible();
  await expect(page.locator("h1")).toContainText("All");
  await expect.poll(() => page.evaluate(() => typeof window.baseline)).toBe("object");
  await expect(
    page.evaluate(() => typeof (window as Window & { require?: unknown }).require)
  ).resolves.toBe("undefined");
  await expect(page.evaluate(() => Boolean(globalThis.process?.versions?.node))).resolves.toBe(
    false
  );
  await expect(page.evaluate(() => Object.keys(window.baseline).sort())).resolves.toEqual(
    expectedBaselineAPI
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.values(window.baseline).every((value) => typeof value === "function")
      )
    )
    .toBe(true);
  await expect(page.evaluate(() => typeof window.baseline.getSnapshot())).resolves.toBe("object");
  await expect(
    page.evaluate(async () => {
      const snapshot = await window.baseline.getSnapshot();
      return {
        global: snapshot.isHomebrewCommandLocked,
        cleanup: snapshot.isHomebrewCleanupLocked,
        cleaning: snapshot.isCleaningUpHomebrew
      };
    })
  ).resolves.toEqual({ global: false, cleanup: false, cleaning: false });
  await expect
    .poll(() => page.evaluate(async () => (await window.baseline.getSnapshot()).profileStats))
    .toMatchObject({ integrityStatus: "verified", events: [], signature: expect.any(String) });

  await closeApp(app);
});

test("shows explanatory Homebrew cleanup row at narrow and wide Settings sizes", async () => {
  const app = await launchBaseline();
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(() => window.baseline.showSettings());
  await expect(page.locator("h1")).toHaveText("General");
  const cleanUp = page.getByRole("button", { name: "Clean up Homebrew", exact: true });
  await expect(cleanUp).toBeVisible();
  // Startup refresh is skipped; never invoke package commands during this UI check.
  await expect(cleanUp).toBeDisabled();
  const row = page.getByRole("group", { name: "Homebrew cleanup" });
  await expect(row).toContainText("old package versions and cached downloads");
  await expect(row).toContainText("supporting packages that are no longer needed");
  await expect(row).toContainText("including ignored items, and cannot be undone");
  for (const width of [800, 1280]) {
    await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setMinimumSize(600, 600);
      window.setContentSize(width, 900);
    }, width);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    const bounds = await row.boundingBox();
    const buttonBounds = await cleanUp.boundingBox();
    const homebrewBounds = await page
      .locator(".settings-row-status")
      .filter({ has: page.getByText("Homebrew", { exact: true }) })
      .boundingBox();
    const masBounds = await page
      .locator(".settings-row-status")
      .filter({ has: page.getByText("mas", { exact: true }) })
      .boundingBox();
    expect(homebrewBounds!.y + homebrewBounds!.height).toBeLessThanOrEqual(bounds!.y + 1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(masBounds!.y + 1);
    expect(buttonBounds!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    expect(await cleanUp.evaluate((button) => getComputedStyle(button).backgroundColor)).toBe(
      "rgb(255, 59, 48)"
    );
    await page.screenshot({ path: test.info().outputPath(`maintenance-row-${width}.png`) });
  }
  expect(errors).toEqual([]);
  await closeApp(app);
});

test("persists preferences across Electron relaunches", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  const firstApp = await launchBaseline({ userData });
  const firstPage = await firstApp.firstWindow();
  await expect
    .poll(() => firstPage.evaluate(async () => (await window.baseline.getSnapshot()).profileStats))
    .toMatchObject({ integrityStatus: "verified" });
  const firstSignature = await firstPage.evaluate(
    async () => (await window.baseline.getSnapshot()).profileStats.signature
  );

  await firstPage.evaluate(async () => {
    await window.baseline.updatePreferences({
      appearancePreference: "dark",
      autoRefreshEnabled: false,
      refreshIntervalMinutes: 15,
      showMenuBarIcon: false
    });
  });
  await closeApp(firstApp);

  const secondApp = await launchBaseline({ userData });
  const secondPage = await secondApp.firstWindow();
  await expect
    .poll(() => secondPage.evaluate(async () => (await window.baseline.getSnapshot()).profileStats))
    .toMatchObject({ integrityStatus: "verified", signature: firstSignature });
  await expect
    .poll(() => secondPage.evaluate(async () => window.baseline.getSnapshot()))
    .toMatchObject({
      appearancePreference: "dark",
      autoRefreshEnabled: false,
      refreshIntervalMinutes: 15,
      showMenuBarIcon: false
    });

  await closeApp(secondApp);
});

test("keeps hidden-Dock settings reachable across close, reopen, and relaunch", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  const firstApp = await launchBaseline({ packaged: true, userData });
  const page = await firstApp.firstWindow();
  await expect(page.locator("h1")).toContainText("All");
  expect(await firstApp.evaluate(({ app }) => app.dock?.isVisible())).toBe(true);
  await page.evaluate(() => window.baseline.showSettings());
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("switch", { name: "Show Dock icon", exact: true }).click();
  await expect.poll(() => firstApp.evaluate(({ app }) => app.dock?.isVisible())).toBe(false);
  await expect
    .poll(() => page.evaluate(() => window.baseline.getSnapshot()))
    .toMatchObject({
      showDockIcon: false,
      showMenuBarIcon: true
    });
  const windowID = await firstApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Expected a main window.");
    window.close();
    return window.id;
  });
  expect(
    await firstApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())
  ).toBe(false);
  // The same main-process Settings action is used by the tray and preload.
  await page.evaluate(async () => {
    await window.baseline.showSettings();
    await window.baseline.showSettings();
  });
  expect(await firstApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.id)).toBe(
    windowID
  );
  await expect(page.getByRole("switch", { name: "Show Dock icon", exact: true })).not.toBeChecked();
  expect(await firstApp.evaluate(({ app }) => app.dock?.isVisible())).toBe(false);

  await page.evaluate(async () => {
    // Exercise a pending native Dock-show promise followed by another hide.
    await Promise.all([
      window.baseline.updatePreferences({ showDockIcon: true }),
      window.baseline.updatePreferences({ showDockIcon: false })
    ]);
  });
  await expect.poll(() => firstApp.evaluate(({ app }) => app.dock?.isVisible())).toBe(false);
  await closeApp(firstApp);

  const secondApp = await launchBaseline({ packaged: true, userData });
  const secondPage = await secondApp.firstWindow();
  await expect(secondPage.locator("h1")).toContainText("All");
  await expect.poll(() => secondApp.evaluate(({ app }) => app.dock?.isVisible())).toBe(false);
  await secondPage.evaluate(() => window.baseline.updatePreferences({ showMenuBarIcon: false }));
  await expect.poll(() => secondApp.evaluate(({ app }) => app.dock?.isVisible())).toBe(true);
  await expect
    .poll(() => secondPage.evaluate(() => window.baseline.getSnapshot()))
    .toMatchObject({
      showDockIcon: true,
      showMenuBarIcon: false
    });
  await secondApp.evaluate(({ app, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
    app.emit("activate");
  });
  expect(
    await secondApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())
  ).toBe(true);
  await closeApp(secondApp);
});

test("routes native tray events with the Dock hidden and protects a running update from Quit", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  await writeFile(
    path.join(userData, "baseline-snapshot.json"),
    JSON.stringify({
      ...defaultPersistedSnapshot(),
      autoRefreshEnabled: false,
      showDockIcon: false,
      apps: [
        {
          id: "fixture-app",
          bundlePath: "/Applications/Fixture Utility.app",
          displayName: "Fixture Utility",
          localVersion: version("1"),
          sourceHint: "appStore"
        }
      ],
      updates: [
        {
          id: "fixture-app",
          appID: "fixture-app",
          source: "appStore",
          supportLevel: "supported",
          localVersion: version("1"),
          remoteVersion: version("2"),
          appStoreItemID: 123,
          updateURL: "https://example.com/update",
          checkedAt: "2026-10-10T00:00:00.000Z"
        }
      ]
    })
  );
  const application = await launchBaseline({ packaged: true, userData });
  const page = await application.firstWindow();
  await expect(page.locator("h1")).toContainText("All");
  application.on("console", (message) => console.log(`Native tray diagnostic: ${message.text()}`));
  await application.evaluate(({ app, BrowserWindow, Tray, dialog, shell }) => {
    const observeWindow = (window: Electron.BrowserWindow) => {
      const record = (event: string) =>
        console.log(JSON.stringify({ event, url: window.webContents.getURL(), time: Date.now() }));
      window.on("ready-to-show", () => record("ready-to-show"));
      window.on("show", () => record("show"));
      window.on("hide", () => record("hide"));
      window.on("focus", () => record("focus"));
      window.on("blur", () => record("blur"));
    };
    BrowserWindow.getAllWindows().forEach(observeWindow);
    app.on("browser-window-created", (_event, window) => observeWindow(window));
    console.log(
      JSON.stringify({
        mainWindow: BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
          url: window.webContents.getURL()
        })),
        dockVisible: app.dock?.isVisible()
      })
    );
    const probe: NativeTrayProbe = { dialogs: [], selfUpdateChecks: 0, command: { commands: [] } };
    (globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe }).nativeTrayProbe =
      probe;
    const setTitle = Tray.prototype.setTitle;
    Tray.prototype.setTitle = function (title, options) {
      probe.tray = this;
      if (options) setTitle.call(this, title, options);
      else setTitle.call(this, title);
    };
    // Inspect the real native Menu without showing a blocking OS popup in CI.
    Tray.prototype.popUpContextMenu = function (menu) {
      probe.menu = menu;
    };
    dialog.showMessageBox = (async (...args: unknown[]) => {
      probe.dialogs.push(args.at(-1) as Electron.MessageBoxOptions);
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    globalThis.fetch = async () => {
      ++probe.selfUpdateChecks;
      return new Response(
        JSON.stringify({
          tag_name: app.getVersion(),
          html_url: "https://github.com/arshiaghaf/Baseline/releases/latest"
        }),
        { status: 200 }
      );
    };
    shell.openExternal = async () => undefined;
  });
  // A normal snapshot captures the existing native Tray through its status update.
  await page.evaluate(() => window.baseline.updatePreferences({ appearancePreference: "dark" }));
  await application.evaluate(() => {
    const probe = (globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe })
      .nativeTrayProbe;
    if (!probe?.tray) throw new Error("Expected the native Tray.");
    probe.tray.emit("click");
  });
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (window) => window.webContents.getURL().endsWith("#/menubar") && window.isVisible()
        )
      )
    )
    .toBe(true);
  await application.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe })
      .nativeTrayProbe!;
    probe.tray!.emit("click");
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith("#/main"))!
      .close();
    probe.tray!.emit("right-click");
    const settings = probe.menu?.items.find((item) => item.label === "Settings");
    if (!settings) throw new Error("Expected Settings in the native menu.");
    settings.click(settings, undefined, {} as Electron.KeyboardEvent);
    settings.click(settings, undefined, {} as Electron.KeyboardEvent);
  });
  await expect(page.locator("h1")).toContainText("General");
  expect(await application.evaluate(({ app }) => app.dock?.isVisible())).toBe(false);
  expect(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().endsWith("#/menubar"))
        ?.isVisible()
    )
  ).toBe(false);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  for (const width of [660, 1020]) {
    await application.evaluate(({ BrowserWindow }, width) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().endsWith("#/settings"))!
        .setSize(width, 760);
    }, width);
    await expect(page.getByRole("switch", { name: "Show Dock icon", exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`dock-menu-settings-${width}.png`) });
  }
  await application.evaluate(() => {
    const probe = (globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe })
      .nativeTrayProbe!;
    const check = probe.menu!.items.find((item) => item.label === "Check for Updates")!;
    check.click(check, undefined, {} as Electron.KeyboardEvent);
    check.click(check, undefined, {} as Electron.KeyboardEvent);
  });
  await expect
    .poll(() =>
      application.evaluate(() =>
        (
          globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe }
        ).nativeTrayProbe?.dialogs.map((dialog) => dialog.message)
      )
    )
    .toContain("Baseline is up to date");
  expect(
    await application.evaluate(
      () =>
        (globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe }).nativeTrayProbe
          ?.selfUpdateChecks
    )
  ).toBe(1);
  await page.evaluate(() => {
    void window.baseline.performAppUpdate("fixture-app");
  });
  await expect
    .poll(() => page.evaluate(async () => (await window.baseline.getSnapshot()).appUpdatingIDs))
    .toContain("fixture-app");
  await application.evaluate(() => {
    const probe = (globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe })
      .nativeTrayProbe!;
    const quit = probe.menu!.items.find((item) => item.label === "Quit")!;
    quit.click(quit, undefined, {} as Electron.KeyboardEvent);
    quit.click(quit, undefined, {} as Electron.KeyboardEvent);
  });
  await expect
    .poll(() =>
      application.evaluate(() =>
        (
          globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe }
        ).nativeTrayProbe?.dialogs.map((dialog) => dialog.message)
      )
    )
    .toContain("An app or Homebrew operation is still running");
  expect((await page.evaluate(() => window.baseline.getSnapshot())).appUpdatingIDs).toContain(
    "fixture-app"
  );
  await application.evaluate(() =>
    (globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe }).nativeTrayProbe!
      .command.finish!()
  );
  await expect
    .poll(() => page.evaluate(async () => (await window.baseline.getSnapshot()).appUpdatingIDs))
    .toEqual([]);

  // A rejected native Dock restore must leave a usable recovery tray, even
  // though the user has just switched the menu-bar preference off.
  await application.evaluate(({ app }) => {
    if (!app.dock) throw new Error("Expected the native Dock API.");
    const showDock = app.dock.show.bind(app.dock);
    const probe = (globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe })
      .nativeTrayProbe!;
    probe.restoreDockShow = () => {
      app.dock!.show = showDock;
    };
    app.dock.show = async () => {
      throw new Error("Synthetic Dock restore failure");
    };
  });
  await page.evaluate(() => window.baseline.updatePreferences({ showMenuBarIcon: false }));
  expect((await page.evaluate(() => window.baseline.getSnapshot())).showMenuBarIcon).toBe(false);
  expect(await application.evaluate(({ app }) => app.dock?.isVisible())).toBe(false);
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith("#/settings"))!
      .close();
    (
      globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe }
    ).nativeTrayProbe!.tray!.emit("click");
  });
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (window) => window.webContents.getURL().endsWith("#/menubar") && window.isVisible()
        )
      )
    )
    .toBe(true);
  await application.evaluate(() => {
    const probe = (globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe })
      .nativeTrayProbe!;
    probe.tray!.emit("click");
    probe.tray!.emit("right-click");
    const settings = probe.menu!.items.find((item) => item.label === "Settings")!;
    settings.click(settings, undefined, {} as Electron.KeyboardEvent);
    probe.restoreDockShow!();
  });
  await expect(page.locator("h1")).toContainText("Appearance");
  expect(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().endsWith("#/settings"))
        ?.isVisible()
    )
  ).toBe(true);
  await page.evaluate(() => window.baseline.updatePreferences({ appearancePreference: "light" }));
  await expect.poll(() => application.evaluate(({ app }) => app.dock?.isVisible())).toBe(true);
  expect((await page.evaluate(() => window.baseline.getSnapshot())).showMenuBarIcon).toBe(false);
  const closed = application.waitForEvent("close");
  await application
    .evaluate(() => {
      const probe = (globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe })
        .nativeTrayProbe!;
      const quit = probe.menu!.items.find((item) => item.label === "Quit")!;
      quit.click(quit, undefined, {} as Electron.KeyboardEvent);
    })
    .catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        !/Execution context was destroyed|Target page, context or browser has been closed/u.test(
          error.message
        )
      )
        throw error;
    });
  await closed;
  launchedApps.delete(application);
});

test("opens a keyboard-usable popover over another app's full-screen Space", async () => {
  test.skip(process.platform !== "darwin", "macOS full-screen Spaces behavior");
  const application = await launchBaseline({ packaged: true });
  const page = await application.firstWindow();
  await expect(page.locator("h1")).toContainText("All");
  await application.evaluate(({ Tray }) => {
    const probe: NativeTrayProbe = { dialogs: [], selfUpdateChecks: 0, command: { commands: [] } };
    (globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe }).nativeTrayProbe =
      probe;
    const setTitle = Tray.prototype.setTitle;
    Tray.prototype.setTitle = function (title, options) {
      probe.tray = this;
      if (options) setTitle.call(this, title, options);
      else setTitle.call(this, title);
    };
  });
  await page.evaluate(() => window.baseline.updatePreferences({ autoRefreshEnabled: false }));

  const fixtureData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  userDataDirectories.add(fixtureData);
  const fixtureScript = path.join(fixtureData, "fullscreen-fixture.cjs");
  await writeFile(
    fixtureScript,
    `const { app, BrowserWindow } = require("electron");
app.setPath("userData", ${JSON.stringify(fixtureData)});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ title: "Full-screen fixture", show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await window.loadURL("data:text/html,<body style='background:steelblue'>Full-screen fixture</body>");
  window.show();
});
app.on("window-all-closed", () => app.quit());
`
  );
  const observer = process.env.BASELINE_E2E_NATIVE_OBSERVER;
  if (!observer) throw new Error("Expected the native window observer from E2E preflight.");
  const nativeState = async () => {
    const { stdout } = await promisify(execFile)(observer);
    return JSON.parse(stdout) as { frontmostPID: number; onScreenWindowIDs: number[] };
  };
  const fixture = await electron.launch({
    executablePath: path.join(
      process.cwd(),
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    ),
    args: [fixtureScript]
  });
  launchedApps.add(fixture);
  await fixture.firstWindow();
  try {
    const fixtureWindowID = await fixture.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      await new Promise<void>((resolve) => {
        window.once("enter-full-screen", () => resolve());
        window.setFullScreen(true);
        window.focus();
      });
      return Number(window.getMediaSourceId().split(":")[1]);
    });
    await expect.poll(async () => (await nativeState()).frontmostPID).toBe(fixture.process().pid);
    const popoverOpened = application.waitForEvent("window");
    await application.evaluate(() => {
      (
        globalThis as typeof globalThis & { nativeTrayProbe?: NativeTrayProbe }
      ).nativeTrayProbe!.tray!.emit("click");
    });
    const popover = await popoverOpened;
    await expect(popover.getByRole("button", { name: "Search", exact: true })).toBeVisible();
    const popoverWindowID = await application.evaluate(({ BrowserWindow }) =>
      Number(
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().endsWith("#/menubar"))!
          .getMediaSourceId()
          .split(":")[1]
      )
    );
    await expect.poll(nativeState).toMatchObject({
      frontmostPID: fixture.process().pid,
      onScreenWindowIDs: expect.arrayContaining([fixtureWindowID, popoverWindowID])
    });
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().endsWith("#/menubar"))!
          .isFocused()
      )
    ).toBe(true);
    await popover.getByRole("button", { name: "Search", exact: true }).click();
    await popover.getByRole("textbox").press("f");
    await expect(popover.getByRole("textbox")).toHaveValue("f");
    expect((await nativeState()).frontmostPID).toBe(fixture.process().pid);
    await popover.evaluate(() => window.baseline.showSettings());
    await expect(page.locator("h1")).toContainText("General");
    await expect
      .poll(async () => (await nativeState()).frontmostPID)
      .toBe(application.process().pid);
  } finally {
    await cleanupApplications([fixture, application]);
    launchedApps.delete(fixture);
    launchedApps.delete(application);
  }
});

test("recovers a saved configuration with both app icons hidden", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  await writeFile(
    path.join(userData, "baseline-snapshot.json"),
    JSON.stringify({
      ...defaultPersistedSnapshot(),
      showDockIcon: false,
      showMenuBarIcon: false
    })
  );
  const application = await launchBaseline({ packaged: true, userData });
  const page = await application.firstWindow();
  await expect(page.locator("h1")).toContainText("All");
  await expect.poll(() => application.evaluate(({ app }) => app.dock?.isVisible())).toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.baseline.getSnapshot()))
    .toMatchObject({
      showDockIcon: true,
      showMenuBarIcon: false
    });
  await closeApp(application);
});

test("reuses the main window without duplicate setup", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  const app = await launchBaseline({ userData });
  const page = await app.firstWindow();
  await expect(page.locator("h1")).toContainText("All");

  const initialWindow = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Expected a main window.");
    (globalThis as typeof globalThis & { __baselineLoadCount?: number }).__baselineLoadCount = 0;
    window.webContents.on("did-start-loading", () => {
      const globals = globalThis as typeof globalThis & { __baselineLoadCount?: number };
      globals.__baselineLoadCount = (globals.__baselineLoadCount ?? 0) + 1;
    });
    window.hide();
    return {
      id: window.id,
      webContentsID: window.webContents.id,
      closeListeners: window.listenerCount("close")
    };
  });
  expect(initialWindow.closeListeners).toBeGreaterThan(0);

  await page.evaluate(async () => {
    await window.baseline.showMainWindow();
    await window.baseline.showMainWindow();
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          id: window.id,
          webContentsID: window.webContents.id,
          closeListeners: window.listenerCount("close"),
          visible: window.isVisible()
        }))
      )
    )
    .toEqual([{ ...initialWindow, visible: true }]);
  await expect(
    app.evaluate(
      () => (globalThis as typeof globalThis & { __baselineLoadCount?: number }).__baselineLoadCount
    )
  ).resolves.toBe(0);

  await closeApp(app);
});

test("reopens settings after renderer-side back navigation", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  const app = await launchBaseline({ userData });
  const page = await app.firstWindow();
  await expect(page.locator("h1")).toContainText("All");

  await page.evaluate(async () => {
    await window.baseline.showSettings();
  });
  await expect(page.locator("h1")).toContainText("General");

  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(page.locator("h1")).toContainText("All");

  await page.evaluate(async () => {
    await window.baseline.showSettings();
  });
  await expect(page.locator("h1")).toContainText("General");

  await closeApp(app);
});

test("renders long update versions inside Electron update cards", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  const longVersionApp = {
    id: "app:long-version",
    bundlePath: "/Applications/Long Version.app",
    displayName: "Long Version App",
    bundleIdentifier: "com.example.long-version",
    localVersion: version("2026.625.2148"),
    sourceHint: "unknown" as const
  };
  const longVersionCask = {
    id: "cask:long-version-tool",
    token: "long-version-tool",
    name: "Long Version Tool",
    kind: "cask" as const,
    fullToken: "long-version-tool",
    tap: "homebrew/cask",
    installedVersion: version("116.0.5845.179"),
    latestVersion: version("117.0.5938.132"),
    isOutdated: true
  };

  await writeFile(
    path.join(userData, "baseline-snapshot.json"),
    `${JSON.stringify(
      {
        ...defaultPersistedSnapshot("2026-04-30T12:00:00.000Z"),
        apps: [longVersionApp],
        updates: [
          {
            id: longVersionApp.id,
            appID: longVersionApp.id,
            source: "appStore",
            supportLevel: "supported",
            localVersion: version("2026.625.2148"),
            remoteVersion: version("2026.628.2035"),
            checkedAt: "2026-04-30T12:00:00.000Z"
          }
        ],
        homebrewItems: [longVersionCask],
        showMenuBarIcon: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const app = await launchBaseline({ userData });
  const page = await app.firstWindow();
  await expect(page.locator("h1")).toContainText("All");
  await expect(page.locator(".update-card")).toHaveCount(2);

  const appCard = page.locator(".update-card").filter({ hasText: longVersionApp.displayName });
  const caskCard = page.locator(".update-card").filter({ hasText: longVersionCask.name });
  await expect(appCard).toContainText("2026.628.2035");
  await expect(appCard).not.toContainText("2026.625.2148");
  await expect(appCard).not.toContainText("→");
  await expect(caskCard).toContainText("117.0.5938.132");
  await expect(caskCard).not.toContainText("116.0.5845.179");
  await expect(caskCard).not.toContainText("→");

  const versionLineMetrics = await page
    .locator(".update-card .item-card-main p")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        text: node.textContent?.trim()
      }))
    );
  expect(versionLineMetrics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: "2026.628.2035" }),
      expect.objectContaining({ text: "117.0.5938.132" })
    ])
  );
  expect(versionLineMetrics.every((metrics) => metrics.scrollWidth <= metrics.clientWidth)).toBe(
    true
  );

  await closeApp(app);
});

test("launches the packaged Electron app after build", async () => {
  const app = await launchBaseline({ packaged: true });
  const page = await app.firstWindow();

  await expect(page).toHaveTitle("Baseline");
  await expect(page.locator("h1")).toContainText("All");
  await expect
    .poll(() => page.evaluate(async () => window.baseline.getSnapshot()))
    .toMatchObject({
      selectedTab: "all",
      isRefreshing: false
    });

  await closeApp(app);
});

test("retains sanitized operation failures across Electron relaunch and dismisses them", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  await writeFile(
    path.join(userData, "baseline-snapshot.json"),
    JSON.stringify({
      ...defaultPersistedSnapshot(),
      autoRefreshEnabled: false,
      showMenuBarIcon: false,
      homebrewItems: [
        {
          id: "formula:example-tool",
          token: "example-tool",
          name: "Example Tool",
          kind: "formula",
          installedVersion: version("1"),
          isOutdated: false
        }
      ],
      operationFailures: [
        {
          id: "install:formula:example-tool",
          entityID: "formula:example-tool",
          operation: "install",
          reason: "network",
          status: 1,
          occurredAt: "2026-04-30T12:00:00.000Z",
          output: "PRIVATE_FIXTURE_OUTPUT"
        }
      ]
    })
  );
  const firstApp = await launchBaseline({ userData });
  const firstPage = await firstApp.firstWindow();
  await firstPage.locator(".operation-failure summary").click();
  await expect(
    firstPage.getByText("The download could not reach its server.", { exact: false })
  ).toBeVisible();
  await expect(firstPage.locator("body")).not.toContainText("PRIVATE_FIXTURE_OUTPUT");
  await expect
    .poll(() =>
      firstPage.evaluate(async () => (await window.baseline.getSnapshot()).operationFailures)
    )
    .toEqual([
      {
        id: "install:formula:example-tool",
        entityID: "formula:example-tool",
        operation: "install",
        reason: "network",
        status: 1,
        occurredAt: "2026-04-30T12:00:00.000Z"
      }
    ]);
  await closeApp(firstApp);

  const secondApp = await launchBaseline({ userData });
  const secondPage = await secondApp.firstWindow();
  await secondPage.locator(".operation-failure summary").click();
  await expect(
    secondPage.getByText("The download could not reach its server.", { exact: false })
  ).toBeVisible();
  await expect(
    secondPage.getByRole("button", { name: "Dismiss failure for Example Tool" })
  ).toBeVisible();
  await secondPage.evaluate(async () => {
    await window.baseline.dismissOperationFailure("install:formula:example-tool");
  });
  await expect
    .poll(() =>
      secondPage.evaluate(async () => (await window.baseline.getSnapshot()).operationFailures)
    )
    .toEqual([]);
  await closeApp(secondApp);

  const thirdApp = await launchBaseline({ userData });
  const thirdPage = await thirdApp.firstWindow();
  await expect(
    thirdPage.getByText("The download could not reach its server.", { exact: false })
  ).toHaveCount(0);
  await expect
    .poll(() =>
      thirdPage.evaluate(async () => (await window.baseline.getSnapshot()).operationFailures)
    )
    .toEqual([]);
  await closeApp(thirdApp);
});

test("keeps persisted pinned packages visible without update actions", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  await writeFile(
    path.join(userData, "baseline-snapshot.json"),
    JSON.stringify({
      ...defaultPersistedSnapshot(),
      autoRefreshEnabled: false,
      showMenuBarIcon: false,
      selectedTab: "installed",
      homebrewItems: [
        {
          id: "formula:pinned-tool",
          token: "pinned-tool",
          name: "Pinned Tool",
          kind: "formula",
          formulaIdentity: {
            name: "pinned-tool",
            fullName: "example/tools/pinned-tool",
            tap: "example/tools",
            oldNames: []
          },
          installedVersion: version("1"),
          latestVersion: version("2"),
          isOutdated: true,
          pinned: true
        },
        {
          id: "cask:pinned-package",
          token: "pinned-package",
          name: "Pinned Package",
          kind: "cask",
          fullToken: "pinned-package",
          tap: "homebrew/cask",
          installedVersion: version("1"),
          latestVersion: version("2"),
          isOutdated: true,
          pinned: true
        }
      ]
    })
  );
  const app = await launchBaseline({ userData });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Installed", exact: true }).click();
  await expect(page.locator("h1")).toContainText("Installed");
  await expect(page.getByText("Pinned in Homebrew", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update Brews", exact: true })).toHaveCount(0);
  await closeApp(app);
});

test("keeps an unpinned app update visible beside a pinned cask sibling", async () => {
  for (const reverse of [false, true]) {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
    const appID = "/Applications/Shared Utility.app";
    const owner = {
      id: "cask:shared-utility",
      token: "shared-utility",
      fullToken: "shared-utility",
      tap: "homebrew/cask",
      name: "Shared Utility",
      kind: "cask",
      appID,
      installedVersion: version("1"),
      latestVersion: version("2"),
      isOutdated: true,
      pinned: false
    };
    const sibling = {
      ...owner,
      id: "cask:sibling-utility",
      token: "sibling-utility",
      fullToken: "sibling-utility",
      pinned: true
    };
    await writeFile(
      path.join(userData, "baseline-snapshot.json"),
      JSON.stringify({
        ...defaultPersistedSnapshot(),
        autoRefreshEnabled: false,
        showMenuBarIcon: false,
        apps: [
          {
            id: appID,
            bundlePath: appID,
            displayName: "Shared Utility",
            bundleIdentifier: "com.example.shared",
            localVersion: version("1"),
            sourceHint: "homebrew"
          }
        ],
        updates: [
          {
            id: appID,
            appID,
            source: "homebrew",
            supportLevel: "supported",
            localVersion: version("1"),
            remoteVersion: version("2"),
            homebrewToken: "shared-utility",
            checkedAt: "2026-10-10T00:00:00.000Z"
          }
        ],
        homebrewItems: reverse ? [owner, sibling] : [sibling, owner]
      })
    );
    const application = await launchBaseline({ userData });
    const page = await application.firstWindow();
    await page.locator("button").filter({ hasText: /^Apps/ }).click();
    await expect(page.getByRole("button", { name: "Update", exact: true })).toHaveCount(1);
    await expect(page.getByText("Pinned in Homebrew", { exact: true })).toHaveCount(0);
    await closeApp(application);
  }
});

test("shows the installed suite pin for every owned app", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  const apps = ["Primary Utility", "Helper Utility"].map((name) => ({
    id: `/Applications/${name}.app`,
    bundlePath: `/Applications/${name}.app`,
    displayName: name,
    localVersion: version("1"),
    sourceHint: "homebrew"
  }));
  await writeFile(
    path.join(userData, "baseline-snapshot.json"),
    JSON.stringify({
      ...defaultPersistedSnapshot(),
      autoRefreshEnabled: false,
      showMenuBarIcon: false,
      apps,
      updates: apps.map((app) => ({
        id: app.id,
        appID: app.id,
        source: "homebrew",
        supportLevel: "limited",
        localVersion: version("1"),
        remoteVersion: version("2"),
        homebrewToken: "utility-suite",
        checkedAt: "2026-10-10T00:00:00.000Z"
      })),
      homebrewItems: [
        {
          id: "cask:utility-suite",
          token: "utility-suite",
          fullToken: "utility-suite",
          tap: "homebrew/cask",
          kind: "cask",
          name: "Utility Suite",
          appID: apps[0]!.id,
          caskMetadata: {
            token: "utility-suite",
            fullToken: "utility-suite",
            tap: "homebrew/cask",
            name: "Utility Suite",
            version: version("2"),
            appBundleNames: ["primary utility.app", "helper utility.app"],
            bundleIdentifiers: [],
            presentation: "app"
          },
          installedVersion: version("1"),
          latestVersion: version("2"),
          isOutdated: true,
          pinned: true
        }
      ]
    })
  );
  const application = await launchBaseline({ userData });
  try {
    const page = await application.firstWindow();
    await page.locator("button").filter({ hasText: /^Apps/ }).click();
    await expect(page.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
    await page
      .locator("button")
      .filter({ hasText: /^Installed/ })
      .click();
    await expect(page.getByText("Pinned in Homebrew", { exact: true })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
  } finally {
    await closeApp(application);
  }
});
