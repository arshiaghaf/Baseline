// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { _electron as electron, expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultPersistedSnapshot,
  type BaselineSnapshot,
  type MenuTab
} from "../src/shared/domain";
import { ipcChannels } from "../src/shared/ipc";
import { version } from "../src/shared/version";
import { cleanupApplications, runWithCleanup } from "./applicationCleanup";
import {
  attachElectronDiagnostics,
  recordElectronLaunch,
  requestElectronQuit,
  trackElectronLifecycle
} from "./electronLifecycleDiagnostics";
import { visualSnapshot } from "./visualSnapshot";

test.afterEach(async () => attachElectronDiagnostics(test.info()));

const widths = [
  660, 740, 755, 756, 760, 920, 1020, 1027, 1028, 1030, 1280, 1352, 1512, 1536, 1728, 1800, 2048,
  2056, 2304, 2560, 2880, 1030, 760, 1512
];
const screenshotWidths = new Set([
  660, 755, 756, 760, 1020, 1027, 1028, 1030, 1512, 1728, 2304, 2560
]);

async function checkResponsiveLayout(scrollbarMode: "WhenScrolling" | "Always") {
  test.setTimeout(120_000);
  const executablePath = process.env.BASELINE_E2E_EXECUTABLE;
  if (!executablePath) throw new Error("Use the isolated E2E global setup.");
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-layout-"));
  await writeFile(
    path.join(userData, "baseline-snapshot.json"),
    JSON.stringify({ ...defaultPersistedSnapshot(), updateIntroductionDismissed: true })
  );
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const profileSecret = randomBytes(32).toString("base64url");
  const body = async () => {
    recordElectronLaunch(test.info(), executablePath);
    application = await electron.launch({
      executablePath,
      // Cocoa argument-domain preference affects this app process only.
      args: ["-AppleShowScrollBars", scrollbarMode],
      env: {
        ...process.env,
        BASELINE_SKIP_INITIAL_REFRESH: "1",
        BASELINE_USER_DATA_DIR: userData,
        BASELINE_E2E_PROFILE_SECRET: profileSecret
      }
    });
    console.log(`Layout-owned PID ${application.process().pid}: ${executablePath}`);
    trackElectronLifecycle(application, test.info(), profileSecret);
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
      {
        channels: ipcChannels,
        state: (() => {
          const snapshot = visualSnapshot();
          snapshot.apps[1]!.displayName = `A long application name ${"W".repeat(90)}`;
          snapshot.updates[1]!.remoteVersion = version(`2026.${"1234567890".repeat(9)}`);
          snapshot.homebrewItems[1] = { ...snapshot.homebrewItems[1]!, pinned: true };
          snapshot.lastRefreshNoticeMessage = `Some update information may be incomplete. ${"Details ".repeat(35)}`;
          return snapshot;
        })()
      }
    );
    await page.reload();
    await expect(page.getByText("Atlas", { exact: true }).first()).toBeVisible();

    const typography = await page.evaluate(() => {
      const style = (selector: string) => {
        const computed = getComputedStyle(document.querySelector(selector)!);
        return {
          family: computed.fontFamily,
          size: computed.fontSize,
          weight: computed.fontWeight
        };
      };
      return {
        cardName: style(".item-card .row-title strong"),
        cardSource: style(".item-card .row-title span"),
        cardSubtitle: style(".item-card .row-main p"),
        pageHeading: style(".dashboard-topbar h1"),
        sectionLabel: style(".panel-title h2"),
        sidebar: style(".source-list button"),
        warning: style(".content > .notice"),
        devicePixelRatio,
        visualViewportScale: visualViewport?.scale ?? 1
      };
    });
    expect(typography.cardName.size).toBe("14px");
    expect(typography.cardSource.size).toBe("12px");
    expect(typography.cardSubtitle.size).toBe("14px");
    expect(typography.pageHeading.size).toBe("18px");
    expect(typography.sectionLabel.size).toBe("14px");
    expect(typography.sidebar.size).toBe("14px");
    expect(typography.warning.size).toBe("14px");
    await expect(
      page.locator(".item-card .row-title strong").filter({ hasText: "A long application name" })
    ).toHaveAttribute("title", /A long application name/);
    await expect(page.locator(".item-card .version-token[title]").first()).toHaveAttribute(
      "title",
      /2026/
    );

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
        const failureBounds = content
          .querySelector<HTMLElement>(".operation-failures")!
          .getBoundingClientRect();
        const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
        const stackBounds = stack.getBoundingClientRect();
        const noticeBounds = document
          .querySelector<HTMLElement>(".content > .notice")!
          .getBoundingClientRect();
        const gridBounds = grid.getBoundingClientRect();
        const cardBounds = card.getBoundingClientRect();
        const cardActionsOutside = [
          ...grid.querySelectorAll<HTMLElement>(".item-card-actions button")
        ]
          .filter((button) => {
            const bounds = button.getBoundingClientRect();
            const parent = button.closest(".item-card")!.getBoundingClientRect();
            return (
              bounds.width > 0 && (bounds.left < parent.left - 1 || bounds.right > parent.right + 1)
            );
          })
          .map((button) => button.title || button.textContent);
        return {
          viewport: innerWidth,
          dpr: devicePixelRatio,
          sidebar: sidebar.getBoundingClientRect().width,
          content: content.getBoundingClientRect().width,
          stack: stackBounds.width,
          stackLeft: stackBounds.left,
          stackRight: stackBounds.right,
          failureWidth: failureBounds.width,
          failureCenter: (failureBounds.left + failureBounds.right) / 2,
          stackCenter: (stackBounds.left + stackBounds.right) / 2,
          noticeWidth: noticeBounds.width,
          noticeLeft: noticeBounds.left,
          headingLeft: document.querySelector(".dashboard-topbar h1")!.getBoundingClientRect().left,
          columns,
          card: cardBounds.width,
          cardRight: cardBounds.right,
          gridRight: gridBounds.right,
          cardContentOverflow: [...grid.querySelectorAll<HTMLElement>(".item-card")].some(
            (item) => item.scrollWidth > item.clientWidth + 1
          ),
          cardActionsOutside,
          icon: icon.getBoundingClientRect().width,
          horizontalOverflow:
            document.documentElement.scrollWidth > innerWidth ||
            content.scrollWidth > content.clientWidth
        };
      });
      const expectedColumns =
        width <= 740 ? 1 : width >= 900 && width <= 1020 ? 2 : width >= 1280 ? 3 : null;
      if (expectedColumns !== null)
        expect(geometry.columns, `grid columns at ${width}px`).toBe(expectedColumns);
      else {
        expect(geometry.columns, `grid columns at ${width}px`).toBeGreaterThanOrEqual(1);
        expect(geometry.columns, `grid columns at ${width}px`).toBeLessThanOrEqual(3);
      }
      expect(geometry.sidebar).toBe(196);
      expect(geometry.stack).toBeLessThanOrEqual(860);
      expect(geometry.failureWidth).toBeLessThanOrEqual(geometry.stack);
      expect(Math.abs(geometry.failureCenter - geometry.stackCenter)).toBeLessThan(1);
      expect(Math.abs(geometry.stackLeft - geometry.headingLeft)).toBeLessThan(1);
      expect(Math.abs(geometry.noticeLeft - geometry.stackLeft)).toBeLessThan(1);
      expect(geometry.noticeWidth).toBeCloseTo(geometry.stack, 0);
      expect(geometry.icon).toBe(50);
      expect(geometry.card).toBeGreaterThanOrEqual(240);
      expect(geometry.card).toBeCloseTo(
        (geometry.stack - (geometry.columns - 1) * 12) / geometry.columns,
        0
      );
      if (geometry.columns === 3) expect(geometry.card).toBeLessThanOrEqual(292);
      expect(geometry.cardRight).toBeLessThanOrEqual(geometry.gridRight + 1);
      expect(geometry.cardContentOverflow, `card content overflow at ${width}px`).toBe(false);
      expect(geometry.cardActionsOutside).toEqual([]);
      expect(geometry.horizontalOverflow, `horizontal overflow at ${width}px`).toBe(false);
      rows.push(geometry);
      if (screenshotWidths.has(width)) {
        await page.screenshot({ path: test.info().outputPath(`dashboard-${width}.png`) });
      }
    }

    const scrollbarRows: unknown[] = [];
    const gutterStyle = await page.addStyleTag({
      content:
        ".content { overflow-y: scroll; scrollbar-gutter: stable; } .content::-webkit-scrollbar { width: 12px; }"
    });
    for (const width of [660, 1512]) {
      await application.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(width, 900);
      }, width);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      const bounds = await page.evaluate(() => {
        const notice = document.querySelector(".content > .notice")!.getBoundingClientRect();
        const stack = document.querySelector(".content > .stack")!.getBoundingClientRect();
        return {
          gutter:
            (document.querySelector(".content") as HTMLElement).offsetWidth -
            (document.querySelector(".content") as HTMLElement).clientWidth,
          noticeLeft: notice.left,
          noticeWidth: notice.width,
          stackLeft: stack.left,
          stackWidth: stack.width,
          overflow:
            (document.querySelector(".content") as HTMLElement).scrollWidth >
            (document.querySelector(".content") as HTMLElement).clientWidth
        };
      });
      scrollbarRows.push({ width, ...bounds });
      expect(bounds.overflow).toBe(false);
      if (scrollbarMode === "Always") expect(bounds.gutter).toBeGreaterThan(0);
      else expect(bounds.gutter).toBe(0);
      expect(Math.abs(bounds.noticeLeft - bounds.stackLeft)).toBeLessThan(1);
      expect(bounds.noticeWidth).toBeCloseTo(bounds.stackWidth, 0);
    }
    await gutterStyle.evaluate((element) => element.parentNode?.removeChild(element));

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

    for (const width of [660, 1512, 1728, 2560, 760]) {
      await application.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(width, 900);
      }, width);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      for (const section of ["General", "Profile", "Appearance", "Diagnostics"]) {
        await page.locator(".settings-sidebar button").filter({ hasText: section }).click();
        await expect(page.locator(".settings-topbar h1")).toHaveText(section);
        const layout = await page.evaluate(() => {
          const content = document.querySelector<HTMLElement>(".settings-content")!;
          const stack = content.querySelector<HTMLElement>(":scope > .stack")!;
          const heading = document.querySelector<HTMLElement>(".settings-topbar h1")!;
          const topbar = document.querySelector<HTMLElement>(".settings-topbar")!;
          const panelWidths = [...content.querySelectorAll<HTMLElement>(".settings-panel")].map(
            (panel) => panel.getBoundingClientRect().width
          );
          const controlsOutside = [
            ...content.querySelectorAll<HTMLElement>("button, input, select")
          ]
            .filter((control) => {
              const bounds = control.getBoundingClientRect();
              return (
                bounds.width > 0 &&
                bounds.height > 0 &&
                (bounds.left < content.getBoundingClientRect().left - 1 ||
                  bounds.right > content.getBoundingClientRect().right + 1)
              );
            })
            .map((control) => control.outerHTML.slice(0, 120));
          return {
            stackLeft: stack.getBoundingClientRect().left,
            stackWidth: stack.getBoundingClientRect().width,
            headingLeft: heading.getBoundingClientRect().left,
            contentGutter: content.offsetWidth - content.clientWidth,
            topbarOverflow: getComputedStyle(topbar).overflowY,
            compensatedGutter: parseFloat(
              getComputedStyle(topbar).getPropertyValue("--settings-scrollbar-width")
            ),
            panelWidths,
            controlsOutside,
            overflow: content.scrollWidth > content.clientWidth
          };
        });
        expect(layout.stackWidth).toBeLessThanOrEqual(860);
        expect(layout.topbarOverflow).toBe("visible");
        expect(layout.compensatedGutter).toBe(layout.contentGutter);
        expect(Math.abs(layout.stackLeft - layout.headingLeft)).toBeLessThan(1);
        expect(layout.panelWidths.every((panelWidth) => panelWidth <= layout.stackWidth + 1)).toBe(
          true
        );
        expect(layout.controlsOutside).toEqual([]);
        expect(layout.overflow).toBe(false);
        if (section === "Profile" && (width === 660 || width === 1512)) {
          for (const indicator of await page.locator(".profile-topbar-indicators > span").all()) {
            const tooltip = indicator.getByRole("tooltip");
            const isPainted = () =>
              tooltip.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                const header = document.querySelector(".settings-topbar")!.getBoundingClientRect();
                const tooltip = element as HTMLElement;
                const originalPointerEvents = tooltip.style.pointerEvents;
                tooltip.style.pointerEvents = "auto";
                const painted = document.elementFromPoint(
                  bounds.left + bounds.width / 2,
                  Math.max(header.bottom + 2, bounds.top + Math.min(bounds.height / 2, 12))
                );
                tooltip.style.pointerEvents = originalPointerEvents;
                return (
                  bounds.bottom > header.bottom + 4 &&
                  getComputedStyle(element).opacity === "1" &&
                  (painted === element || element.contains(painted))
                );
              });
            await indicator.hover();
            await expect.poll(isPainted).toBe(true);
            await indicator.focus();
            await page.keyboard.press("Shift+Tab");
            await page.keyboard.press("Tab");
            await expect(indicator).toBeFocused();
            await page.mouse.move(0, 0);
            await expect.poll(isPainted).toBe(true);
          }
        }
        if (width === 660 || width === 2560) {
          await page.screenshot({
            path: test.info().outputPath(`settings-${section.toLowerCase()}-${width}.png`)
          });
        }
      }
    }

    await page.evaluate(() => {
      window.location.hash = "/main";
    });
    await expect(page.locator(".content > .notice")).toBeVisible();
    const errorSnapshot = {
      ...visualSnapshot(),
      snapshotRevision: 10_000,
      searchText: "Beacon",
      refreshErrorMessage: `This refresh failed. Please try again. ${"Details ".repeat(35)}`
    };
    await application.evaluate(
      ({ BrowserWindow }, { channels, state }) => {
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send(channels.snapshotChanged, state);
      },
      { channels: ipcChannels, state: errorSnapshot }
    );
    await expect(page.locator(".content > .notice.danger")).toBeVisible();
    for (const width of [660, 1728]) {
      await application.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(width, 900);
      }, width);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      const bounds = await page.evaluate(() => {
        const notice = document.querySelector(".content > .notice.danger")!.getBoundingClientRect();
        const stack = document.querySelector(".content > .stack")!.getBoundingClientRect();
        return {
          noticeLeft: notice.left,
          noticeWidth: notice.width,
          stackLeft: stack.left,
          stackWidth: stack.width
        };
      });
      expect(Math.abs(bounds.noticeLeft - bounds.stackLeft)).toBeLessThan(1);
      expect(bounds.noticeWidth).toBeCloseTo(bounds.stackWidth, 0);
    }

    await page.keyboard.press("Meta+f");
    await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
    for (const width of [660, 2560]) {
      await application.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(width, 900);
      }, width);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      const search = await page.evaluate(() => {
        const dialog = document.querySelector<HTMLElement>(".search-palette")!;
        const title = dialog.querySelector<HTMLElement>(".row-title strong")!;
        const source = dialog.querySelector<HTMLElement>(".row-title span")!;
        const subtitle = dialog.querySelector<HTMLElement>(".row-main p")!;
        const bounds = dialog.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          titleSize: getComputedStyle(title).fontSize,
          sourceSize: getComputedStyle(source).fontSize,
          subtitleSize: getComputedStyle(subtitle).fontSize,
          horizontalOverflow: dialog.scrollWidth > dialog.clientWidth
        };
      });
      expect(search.left).toBeGreaterThanOrEqual(0);
      expect(search.right).toBeLessThanOrEqual(width);
      expect(search.titleSize).toBe("14px");
      expect(search.sourceSize).toBe("12px");
      expect(search.subtitleSize).toBe("14px");
      expect(search.horizontalOverflow).toBe(false);
    }

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
          scrollbarMode,
          scrollbarRows,
          typography,
          rows
        },
        null,
        2
      )
    );
  };
  await runWithCleanup(body, async () => {
    if (application) await cleanupApplications([application], requestElectronQuit);
    await rm(userData, { recursive: true, force: true });
  });
}

for (const scrollbarMode of ["WhenScrolling", "Always"] as const) {
  test(`dashboard cards fit narrow windows and scaled-display viewports (${scrollbarMode})`, async () => {
    await checkResponsiveLayout(scrollbarMode);
  });
}

test("narrow operation notice wraps and compact confirmation keeps keyboard focus", async () => {
  const executablePath = process.env.BASELINE_E2E_EXECUTABLE;
  if (!executablePath) throw new Error("Use the isolated E2E global setup.");
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-failure-layout-"));
  await writeFile(
    path.join(userData, "baseline-snapshot.json"),
    JSON.stringify({ ...defaultPersistedSnapshot(), updateIntroductionDismissed: true })
  );
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const profileSecret = randomBytes(32).toString("base64url");
  const body = async () => {
    recordElectronLaunch(test.info(), executablePath);
    application = await electron.launch({
      executablePath,
      env: {
        ...process.env,
        BASELINE_SKIP_INITIAL_REFRESH: "1",
        BASELINE_USER_DATA_DIR: userData,
        BASELINE_E2E_PROFILE_SECRET: profileSecret
      }
    });
    trackElectronLifecycle(application, test.info(), profileSecret);
    const page = await application.firstWindow();
    const snapshot = visualSnapshot();
    snapshot.apps[0]!.displayName = `A long app name ${"W".repeat(90)}`;
    await application.evaluate(
      ({ ipcMain, BrowserWindow }, { channels, state }) => {
        let snapshot: BaselineSnapshot = state;
        ipcMain.removeHandler(channels.getSnapshot);
        ipcMain.handle(channels.getSnapshot, () => snapshot);
        ipcMain.removeHandler(channels.setSearchText);
        ipcMain.handle(channels.setSearchText, (_event, searchText: string) => {
          snapshot = {
            ...snapshot,
            searchText,
            snapshotRevision: (snapshot.snapshotRevision ?? 0) + 1
          };
          for (const window of BrowserWindow.getAllWindows())
            window.webContents.send(channels.snapshotChanged, snapshot);
        });
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send(channels.snapshotChanged, state);
      },
      { channels: ipcChannels, state: snapshot }
    );
    await page.reload();
    for (const [route, width, height] of [
      ["main", 660, 620],
      ["menubar", 440, 560]
    ] as const) {
      await page.setViewportSize({ width, height });
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      await page.evaluate((next) => {
        window.location.hash = `#/${next}`;
      }, route);
      const summary = page.locator(".operation-failure summary").first();
      await expect(summary).toBeVisible();
      await expect(summary).toContainText("W".repeat(90));
      const geometry = await summary.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const label = element
          .querySelector<HTMLElement>(".failure-disclosure-label")!
          .getBoundingClientRect();
        return {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowWrap: getComputedStyle(element).overflowWrap,
          labelRight: label.right,
          right: bounds.right,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: innerWidth
        };
      });
      expect(geometry.overflowWrap).toBe("anywhere");
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
      expect(geometry.labelRight).toBeLessThanOrEqual(geometry.right + 1);
      expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
      await page.screenshot({ path: test.info().outputPath(`failure-${route}-${width}.png`) });
    }
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const search = page.locator(".toolbar-search input");
    await search.fill("Beacon");
    const searchGrid = page.locator(".compact .card-grid").first();
    await expect(searchGrid).toBeVisible();
    expect(
      await searchGrid.evaluate(
        (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length
      )
    ).toBe(1);
    const compactLayout = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>(".compact .item-card")!;
      const content = document.querySelector<HTMLElement>(".compact .content")!;
      return {
        nameSize: getComputedStyle(card.querySelector(".row-title strong")!).fontSize,
        subtitleSize: getComputedStyle(card.querySelector(".row-main p")!).fontSize,
        cardOverflow: card.scrollWidth > card.clientWidth,
        contentOverflow: content.scrollWidth > content.clientWidth
      };
    });
    expect(compactLayout).toEqual({
      nameSize: "14px",
      subtitleSize: "14px",
      cardOverflow: false,
      contentOverflow: false
    });
    await search.fill("grove");
    await page.getByRole("button", { name: "Install", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Install Grove?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(page.locator(".action-surface")).toHaveAttribute("inert", "");
    await page.keyboard.type("z");
    await expect(search).toHaveValue("grove");
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Install Grove" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(search).toBeFocused();
  };
  await runWithCleanup(body, async () => {
    if (application) await cleanupApplications([application], requestElectronQuit);
    await rm(userData, { recursive: true, force: true });
  });
});
