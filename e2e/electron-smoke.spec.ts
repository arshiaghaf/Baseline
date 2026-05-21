// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { _electron as electron, expect, test } from "@playwright/test";
import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const expectedBaselineAPI = [
  "chooseDirectory",
  "copyDiagnostics",
  "getAppMetadata",
  "getDiagnostics",
  "getSnapshot",
  "getToolStatus",
  "installHomebrewItem",
  "onHomebrewCommandEvent",
  "onSnapshotChanged",
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
  const userData = options.userData ?? (await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-")));
  const common = {
    env: {
      ...process.env,
      BASELINE_SKIP_INITIAL_REFRESH: "1",
      BASELINE_USER_DATA_DIR: userData
    }
  };

  if (!options.packaged) {
    return electron.launch({ ...common, args: ["."] });
  }

  const executablePath = path.join(
    process.cwd(),
    "out",
    `Baseline-darwin-${process.arch}`,
    "Baseline.app",
    "Contents",
    "MacOS",
    "Baseline"
  );
  await access(executablePath);
  return electron.launch({ ...common, executablePath });
}

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  await Promise.all([
    app.waitForEvent("close"),
    app.evaluate(async ({ app }) => {
      app.quit();
    })
  ]);
}

test("launches the Electron shell and renders the dashboard", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  const app = await launchBaseline({ userData });

  const page = await app.firstWindow();
  await expect(page).toHaveTitle("Baseline");
  await expect(page.locator("h1")).toContainText("All");
  await expect(page.getByRole("button", { name: /^All\s+\d+$/u })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Apps\s+\d+$/u })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Homebrew\s+\d+$/u })).toBeVisible();
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

  await closeApp(app);
});

test("persists preferences across Electron relaunches", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  const firstApp = await launchBaseline({ userData });
  const firstPage = await firstApp.firstWindow();

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
    .poll(() => secondPage.evaluate(async () => window.baseline.getSnapshot()))
    .toMatchObject({
      appearancePreference: "dark",
      autoRefreshEnabled: false,
      refreshIntervalMinutes: 15,
      showMenuBarIcon: false
    });

  await closeApp(secondApp);
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
