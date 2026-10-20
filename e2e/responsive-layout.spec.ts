// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { _electron as electron, expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BaselineSnapshot, MenuTab } from "../src/shared/domain";
import { ipcChannels } from "../src/shared/ipc";
import { cleanupApplications } from "./applicationCleanup";
import { visualSnapshot } from "./visualSnapshot";

const widths = [
  660, 740, 755, 756, 760, 920, 1020, 1027, 1028, 1030, 1280, 1352, 1512, 1536, 1728, 1800, 2048,
  2056, 2304, 2560, 2880
];
const screenshotWidths = new Set([
  660, 755, 756, 760, 1020, 1027, 1028, 1030, 1512, 1728, 2304, 2560
]);

test("dashboard cards fit narrow windows and scaled-display viewports", async () => {
  test.setTimeout(120_000);
  const executablePath = process.env.BASELINE_E2E_EXECUTABLE;
  if (!executablePath) throw new Error("Use the isolated E2E global setup.");
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-layout-"));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({
      executablePath,
      env: {
        ...process.env,
        BASELINE_SKIP_INITIAL_REFRESH: "1",
        BASELINE_USER_DATA_DIR: userData,
        BASELINE_E2E_PROFILE_SECRET: randomBytes(32).toString("base64url")
      }
    });
    console.log(`Layout-owned PID ${application.process().pid}: ${executablePath}`);
    const page = await application.firstWindow();
    await expect(page.locator("h1")).toHaveText("All");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await application.evaluate(
      ({ ipcMain, BrowserWindow }, { channels, state }) => {
        let snapshot: BaselineSnapshot = state;
        const publish = (patch: Partial<BaselineSnapshot>) => {
          snapshot = {
            ...snapshot,
            ...patch,
            snapshotRevision: (snapshot.snapshotRevision ?? 0) + 1
          };
          for (const window of BrowserWindow.getAllWindows())
            window.webContents.send(channels.snapshotChanged, snapshot);
        };
        ipcMain.removeHandler(channels.getSnapshot);
        ipcMain.handle(channels.getSnapshot, () => snapshot);
        ipcMain.removeHandler(channels.setSelectedTab);
        ipcMain.handle(channels.setSelectedTab, (_event, tab: MenuTab) =>
          publish({ selectedTab: tab })
        );
        publish({});
      },
      { channels: ipcChannels, state: visualSnapshot() }
    );
    await page.reload();
    await expect(page.getByText("Atlas", { exact: true }).first()).toBeVisible();

    const display = await application.evaluate(({ screen }) => screen.getPrimaryDisplay());
    const rows: unknown[] = [];
    for (const width of widths) {
      await application.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(width, 900);
      }, width);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      const geometry = await page.evaluate(() => {
        const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
        const content = document.querySelector<HTMLElement>(".content")!;
        const stack = content.querySelector<HTMLElement>(":scope > .stack")!;
        const grid = content.querySelector<HTMLElement>(".update-grid")!;
        const card = grid.querySelector<HTMLElement>(".item-card")!;
        const icon = card.querySelector<HTMLElement>(".app-icon")!;
        const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
        const stackBounds = stack.getBoundingClientRect();
        const gridBounds = grid.getBoundingClientRect();
        const cardBounds = card.getBoundingClientRect();
        return {
          viewport: innerWidth,
          dpr: devicePixelRatio,
          sidebar: sidebar.getBoundingClientRect().width,
          content: content.getBoundingClientRect().width,
          stack: stackBounds.width,
          stackLeft: stackBounds.left,
          stackRight: stackBounds.right,
          headingLeft: document.querySelector(".dashboard-topbar h1")!.getBoundingClientRect().left,
          columns,
          card: cardBounds.width,
          cardRight: cardBounds.right,
          gridRight: gridBounds.right,
          cardContentOverflow: card.scrollWidth > card.clientWidth + 1,
          icon: icon.getBoundingClientRect().width,
          horizontalOverflow:
            document.documentElement.scrollWidth > innerWidth ||
            content.scrollWidth > content.clientWidth
        };
      });
      const expectedColumns = width < 756 ? 1 : width < 1028 ? 2 : 3;
      expect(geometry.columns, `grid columns at ${width}px`).toBe(expectedColumns);
      expect(geometry.sidebar).toBe(196);
      expect(geometry.stack).toBeLessThanOrEqual(900);
      expect(Math.abs(geometry.stackLeft - geometry.headingLeft)).toBeLessThan(1);
      expect(geometry.icon).toBe(50);
      expect(geometry.card).toBeGreaterThanOrEqual(240);
      expect(geometry.card).toBeCloseTo(
        (geometry.stack - (geometry.columns - 1) * 12) / geometry.columns,
        0
      );
      if (geometry.columns === 3) expect(geometry.card).toBeLessThanOrEqual(292);
      expect(geometry.cardRight).toBeLessThanOrEqual(geometry.gridRight + 1);
      expect(geometry.cardContentOverflow, `card content overflow at ${width}px`).toBe(false);
      expect(geometry.horizontalOverflow, `horizontal overflow at ${width}px`).toBe(false);
      rows.push(geometry);
      if (screenshotWidths.has(width)) {
        await page.screenshot({ path: test.info().outputPath(`dashboard-${width}.png`) });
      }
    }

    for (const tab of ["apps", "homebrew", "installed", "ignored"] as const) {
      await page.evaluate((tab) => window.baseline.setSelectedTab(tab), tab);
      await expect
        .poll(() => page.evaluate(async () => (await window.baseline.getSnapshot()).selectedTab))
        .toBe(tab);
      await expect(page.locator(".content .card-grid").first()).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`${tab}-wide.png`) });
    }
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(660, 760)
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(660);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            getComputedStyle(document.querySelector(".ignored-grid")!).gridTemplateColumns.split(
              " "
            ).length
        )
      )
      .toBe(1);
    await page.screenshot({ path: test.info().outputPath("ignored-narrow.png") });
    await page.evaluate(() => window.baseline.showSettings());
    await expect(page.locator("h1")).toHaveText("General");
    await page.screenshot({ path: test.info().outputPath("settings-narrow.png") });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1728, 1000)
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1728);
    await page.screenshot({ path: test.info().outputPath("settings-wide.png") });

    expect(errors).toEqual([]);
    await writeFile(
      test.info().outputPath("layout-matrix.json"),
      JSON.stringify(
        {
          display: {
            label: display.label,
            bounds: display.bounds,
            workArea: display.workArea,
            scaleFactor: display.scaleFactor
          },
          rows
        },
        null,
        2
      )
    );
  } finally {
    if (application) await cleanupApplications([application]);
    await rm(userData, { recursive: true, force: true });
  }
});
