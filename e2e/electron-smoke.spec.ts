// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { _electron as electron, expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultPersistedSnapshot } from "../src/shared/domain";
import { version } from "../src/shared/version";

const profileTestSecret = randomBytes(32).toString("base64url");
const launchedApps = new Set<Awaited<ReturnType<typeof electron.launch>>>();
const userDataDirectories = new Set<string>();

test.afterEach(async () => {
  for (const app of launchedApps) {
    await app.close();
  }
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
        cleanup: snapshot.isHomebrewCleanupLocked
      };
    })
  ).resolves.toEqual({ global: false, cleanup: false });
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
    await page.screenshot({ path: `/tmp/baseline-maintenance-row-${width}.png` });
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

test("reuses the main window without duplicate setup", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  const app = await launchBaseline({ userData });
  const page = await app.firstWindow();
  await expect(page.locator("h1")).toContainText("All");

  const ownMainCloseListenerCount = () =>
    app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]
          ?.rawListeners("close")
          .filter((listener) => listener.name === "handleMainWindowClose").length
    );

  const initialCloseListeners = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) {
      throw new Error("Expected a main window.");
    }
    (globalThis as typeof globalThis & { __baselineLoadCount?: number }).__baselineLoadCount = 0;
    window.webContents.on("did-start-loading", () => {
      const globals = globalThis as typeof globalThis & { __baselineLoadCount?: number };
      globals.__baselineLoadCount = (globals.__baselineLoadCount ?? 0) + 1;
    });
    return window
      .rawListeners("close")
      .filter((listener) => listener.name === "handleMainWindowClose").length;
  });

  await page.evaluate(async () => {
    await window.baseline.showMainWindow();
    await window.baseline.showMainWindow();
  });
  await page.waitForTimeout(250);

  await expect(ownMainCloseListenerCount()).resolves.toBe(initialCloseListeners);
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
  const longVersionFormula = {
    id: "formula:long-version-tool",
    token: "long-version-tool",
    name: "Long Version Tool",
    kind: "formula" as const,
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
        homebrewItems: [longVersionFormula],
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
  const formulaCard = page.locator(".update-card").filter({ hasText: longVersionFormula.name });
  await expect(appCard).toContainText("2026.628.2035");
  await expect(appCard).not.toContainText("2026.625.2148");
  await expect(appCard).not.toContainText("→");
  await expect(formulaCard).toContainText("117.0.5938.132");
  await expect(formulaCard).not.toContainText("116.0.5845.179");
  await expect(formulaCard).not.toContainText("→");

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
