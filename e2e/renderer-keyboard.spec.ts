// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { visualSnapshot } from "./visualSnapshot";
import { cleanupApplications, runWithCleanup } from "./applicationCleanup";
import { version } from "../src/shared/version";

// Exercise Chromium's native keyboard defaults with the real built renderer.
// This hidden shell never loads Baseline's main process, scans the host, or
// dispatches real commands. Its profile and IPC intents belong only to the test.
async function withKeyboardFixture(
  route: "main" | "menubar",
  run: (page: Page, intents: () => Promise<string[]>) => Promise<void>
) {
  const appDirectory = process.env.BASELINE_E2E_APP_DIR;
  if (!appDirectory) throw new Error("Use the isolated E2E global setup.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-keyboard-"));
  const state = visualSnapshot();
  state.apps = [
    {
      id: "example",
      bundlePath: "/synthetic/Example.app",
      displayName: "Example",
      localVersion: version("1.0"),
      sourceHint: "homebrew"
    }
  ];
  state.updates = [
    {
      id: "example",
      appID: "example",
      source: "homebrew",
      supportLevel: "supported",
      localVersion: version("1.0"),
      remoteVersion: version("2.0"),
      homebrewToken: "example",
      checkedAt: "2026-10-22T12:00:00.000Z"
    }
  ];
  state.homebrewItems = [
    {
      id: "cask:example",
      token: "example",
      name: "Example",
      kind: "cask",
      appID: "example",
      installedVersion: version("1.0"),
      latestVersion: version("2.0"),
      isOutdated: true
    }
  ];
  state.homebrewDiscoverItems = [];
  state.recentlyUpdated = [];
  state.homebrewRecentlyUpdated = [];
  state.ignoredIDs = [];
  state.ignoredHomebrewItemIDs = [];
  state.searchText = "";
  state.operationFailures = [];
  state.operationFailureDetails = {};
  const preload = path.join(directory, "preload.cjs");
  const main = path.join(directory, "main.cjs");
  await writeFile(
    preload,
    `
    const { contextBridge, ipcRenderer } = require('electron');
    let snapshot = ${JSON.stringify(state)};
    let receive = () => {};
    const record = (name) => ipcRenderer.invoke('fixture:intent', name);
    contextBridge.exposeInMainWorld('baseline', {
      getSnapshot: async () => snapshot,
      getAppMetadata: async () => ({ version: '0.0.0', displayVersion: 'Fixture' }),
      onSnapshotChanged: (listener) => { receive = listener; return () => {}; },
      onSnapshotProgress: () => () => {},
      setSearchText: async (searchText) => { snapshot = { ...snapshot, searchText }; receive(snapshot); },
      refresh: () => record('refresh'),
      showSettings: () => record('settings'),
      openApp: () => record('open'),
      performAppUpdate: () => record('update'),
      toggleIgnoredApp: () => record('ignore'),
      uninstallHomebrewItem: () => record('uninstall')
    });
  `
  );
  await writeFile(
    main,
    `
    const { app, BrowserWindow, ipcMain, session } = require('electron');
    app.setPath('userData', ${JSON.stringify(path.join(directory, "profile"))});
    app.disableHardwareAcceleration();
    app.dock?.hide();
    global.fixtureIntents = [];
    ipcMain.handle('fixture:intent', (_event, name) => { global.fixtureIntents.push(name); });
    app.whenReady().then(async () => {
      session.defaultSession.webRequest.onBeforeRequest((request, done) =>
        done({ cancel: !/^(file|data):/.test(request.url) }));
      const window = new BrowserWindow({ show: false, width: ${route === "menubar" ? 400 : 900},
        height: 640, webPreferences: { preload: ${JSON.stringify(preload)},
          contextIsolation: true, nodeIntegration: false } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await window.loadFile(${JSON.stringify(path.join(appDirectory, ".vite/renderer/main_window/index.html"))},
        { hash: ${JSON.stringify(`/${route}`)} });
    });
  `
  );
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  await runWithCleanup(
    async () => {
      application = await electron.launch({ args: [main], cwd: directory });
      console.log(
        `Keyboard fixture PID ${application.process().pid}: ${application.process().spawnfile}`
      );
      const page = await application.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await expect(page).toHaveTitle("Baseline");
      await expect(page.getByRole("button", { name: "Open app" })).toBeVisible();
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible())
        )
      ).toBe(true);
      await run(page, () =>
        application!.evaluate(
          () => (globalThis as typeof globalThis & { fixtureIntents: string[] }).fixtureIntents
        )
      );
      expect(errors).toEqual([]);
    },
    async () => {
      if (application) await cleanupApplications([application]);
      await rm(directory, { recursive: true, force: true });
    }
  );
}

test("compact tray keeps keyboard focus through toolbar and row actions", async () => {
  await withKeyboardFixture("menubar", async (page, intents) => {
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("textbox")).toBeFocused();
    await page.getByRole("button", { name: "Close Search" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Close Search" })).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(intents).toContain("refresh");
    await page.getByRole("button", { name: "Settings", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(intents).toContain("settings");
    await page.getByRole("button", { name: "Open app" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(intents).toContain("open");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Update", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(intents).toContain("update");
    await page.keyboard.press("Tab");
    const actions = page.getByRole("button", { name: "Actions" });
    await expect(actions).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Ignore" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Uninstall" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(actions).toBeFocused();
    await test.info().attach("compact-keyboard-focus", {
      body: await page.screenshot(),
      contentType: "image/png"
    });
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect.poll(intents).toContain("ignore");
    await expect(actions).toBeFocused();
  });
});

for (const placement of ["inline", "floating"] as const) {
  test(`${placement} Search row menu supports keyboard traversal and activation`, async () => {
    await withKeyboardFixture("main", async (page, intents) => {
      await page.getByRole("button", { name: "Search", exact: true }).focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Search", exact: true });
      await page.getByRole("textbox").fill("example");
      // Control panel height rather than mocking focus or keyboard dispatch.
      await page.addStyleTag({
        content: `.search-palette-results { height: ${placement === "floating" ? 78 : 320}px; }`
      });
      const actions = dialog.getByRole("button", { name: "Actions" });
      await actions.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu");
      const ignore = menu.getByRole("menuitem", { name: "Ignore" });
      const uninstall = menu.getByRole("menuitem", { name: "Uninstall" });
      await expect(ignore).toBeFocused();
      await test.info().attach(`${placement}-menu-keyboard-focus`, {
        body: await page.screenshot(),
        contentType: "image/png"
      });
      expect(await menu.evaluate((element) => Boolean(element.closest(".search-palette")))).toBe(
        placement === "inline"
      );
      await page.keyboard.press("Tab");
      await expect(uninstall).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(ignore).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(uninstall).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(actions).toBeFocused();
      await expect(dialog).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect.poll(intents).toContain("ignore");
      await expect(actions).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(uninstall).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("textbox")).toBeFocused();
      await expect(menu).toHaveCount(0);
      await actions.focus();
      await page.keyboard.press("ArrowDown");
      await expect(ignore).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(actions).toBeFocused();
      await expect(menu).toBeVisible();
      await page.keyboard.press("Shift+Tab");
      await expect(dialog.getByRole("button", { name: "Update", exact: true })).toBeFocused();
      await expect(menu).toHaveCount(0);
      await expect(actions).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Search", exact: true })).toBeFocused();
    });
  });
}
