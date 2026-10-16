// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { _electron as electron, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BaselineSnapshot, MenuTab } from "../src/shared/domain";
import { ipcChannels } from "../src/shared/ipc";
import { cleanupApplications } from "./applicationCleanup";
import { visualSnapshot, visualTime } from "./visualSnapshot";

type VisualProbe = { tray?: Electron.Tray };
const launchArguments = ["--disable-gpu", "--force-color-profile=srgb"];
const sizes = {
  main: { narrow: { width: 660, height: 760 }, wide: { width: 1280, height: 900 } },
  tray: { narrow: { width: 360, height: 560 }, wide: { width: 440, height: 640 } }
} as const;

for (const surface of ["main", "tray"] as const) {
  for (const size of ["narrow", "wide"] as const) {
    for (const theme of ["light", "dark"] as const) {
      for (const motion of ["no-preference", "reduce"] as const) {
        const name = `${surface}-${size}-${theme}-${motion}`;
        test(name, async () => {
          const testInfo = test.info();
          expect(process.platform, "Visual lane requires macOS").toBe("darwin");
          expect(process.arch, "Visual lane requires Apple Silicon").toBe("arm64");
          const macOS = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
            encoding: "utf8"
          }).trim();
          expect(macOS.split(".")[0], "Visual lane requires macOS 27").toBe("27");
          const executablePath = process.env.BASELINE_E2E_EXECUTABLE;
          if (!executablePath) throw new Error("Use the isolated E2E global setup.");
          const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-visual-"));
          let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
          try {
            application = await electron.launch({
              executablePath,
              args: launchArguments,
              locale: "en-US",
              timezoneId: "UTC",
              env: {
                ...process.env,
                TZ: "UTC",
                BASELINE_SKIP_INITIAL_REFRESH: "1",
                BASELINE_USER_DATA_DIR: userData,
                BASELINE_E2E_PROFILE_SECRET: randomBytes(32).toString("base64url")
              }
            });
            console.log(`Visual-owned PID ${application.process().pid}: ${executablePath}`);
            const main = await application.firstWindow();
            const errors: string[] = [];
            const observeErrors = (page: import("@playwright/test").Page) =>
              page.on("pageerror", (error) => errors.push(error.message));
            observeErrors(main);
            application.context().on("page", observeErrors);
            await expect(main.locator("h1")).toHaveText("All");
            await application.evaluate(({ Tray }) => {
              const probe: VisualProbe = {};
              (globalThis as typeof globalThis & { visualProbe?: VisualProbe }).visualProbe = probe;
              const original = Tray.prototype.setTitle;
              Tray.prototype.setTitle = function (title, options) {
                probe.tray = this;
                if (options) original.call(this, title, options);
                else original.call(this, title);
              };
            });
            // Exercise the app's real tray update/open path before installing data fixtures.
            await main.evaluate(
              (appearancePreference) => window.baseline.updatePreferences({ appearancePreference }),
              theme
            );
            await application.evaluate(
              ({ ipcMain, BrowserWindow, nativeTheme }, { channels, state, theme }) => {
                let snapshot: BaselineSnapshot = { ...state, appearancePreference: theme };
                const publish = (patch: Partial<BaselineSnapshot>) => {
                  snapshot = {
                    ...snapshot,
                    ...patch,
                    snapshotRevision: (snapshot.snapshotRevision ?? 0) + 1
                  };
                  for (const window of BrowserWindow.getAllWindows())
                    window.webContents.send(channels.snapshotChanged, snapshot);
                };
                const handlers: Record<string, (...args: unknown[]) => unknown> = {
                  [channels.getSnapshot]: () => snapshot,
                  [channels.getAppMetadata]: () => ({
                    version: "0.7.1",
                    buildNumber: "70100",
                    displayVersion: "0.7.1 (70100)"
                  }),
                  [channels.getToolStatus]: () => ({
                    isChecking: false,
                    isMasInstalled: true,
                    isHomebrewInstalled: true
                  }),
                  [channels.getDiagnostics]: () => "Fixture diagnostics: no host data.",
                  [channels.setSearchText]: (searchText) =>
                    publish({ searchText: searchText as string }),
                  [channels.setSelectedTab]: (selectedTab) =>
                    publish({ selectedTab: selectedTab as MenuTab }),
                  [channels.updatePreferences]: (patch) => {
                    publish(patch as Partial<BaselineSnapshot>);
                    nativeTheme.themeSource = snapshot.appearancePreference;
                  }
                };
                // Unexpected intents fail instead of reaching host operations or opening URLs.
                const events = new Set<string>([
                  channels.snapshotChanged,
                  channels.snapshotProgress,
                  channels.homebrewCommandEvent
                ]);
                const navigation = new Set<string>([
                  channels.showMainWindow,
                  channels.showSettings
                ]);
                for (const channel of Object.values(channels)) {
                  if (events.has(channel) || navigation.has(channel)) continue;
                  ipcMain.removeHandler(channel);
                  ipcMain.handle(channel, (_event, ...args: unknown[]) => {
                    const handler = handlers[channel];
                    if (!handler) throw new Error(`Unexpected visual-test intent: ${channel}`);
                    return handler(...args);
                  });
                }
                nativeTheme.themeSource = theme;
                publish({});
              },
              { channels: ipcChannels, state: visualSnapshot(), theme }
            );

            let page = main;
            if (surface === "tray") {
              const nextPage = application.context().waitForEvent("page");
              await application.evaluate(() => {
                const tray = (globalThis as typeof globalThis & { visualProbe?: VisualProbe })
                  .visualProbe?.tray;
                if (!tray) throw new Error("Expected the app's native tray.");
                tray.emit("click");
              });
              page = await nextPage;
              await expect(page).toHaveURL(/#\/menubar$/);
            }
            // Media and fixed wall time precede the reload's initial React effects.
            // setFixedTime leaves timers/requestAnimationFrame running for readiness.
            await page.emulateMedia({ colorScheme: theme, reducedMotion: motion });
            await page.clock.setFixedTime(new Date(visualTime));
            await page.reload();
            const ciLane = testInfo.config.metadata.visualLane === "xcode-27";
            const bounds = {
              ...sizes[surface][size],
              ...(ciLane && surface === "main"
                ? { width: size === "wide" ? 1000 : 660, height: 640 }
                : {})
            };
            const geometry = await application.evaluate(
              ({ BrowserWindow, screen }, { route, bounds, ciLane }) => {
                const window = BrowserWindow.getAllWindows().find((window) =>
                  window.webContents.getURL().endsWith(route)
                );
                if (!window) throw new Error(`Missing native window ${route}`);
                const display = screen.getPrimaryDisplay();
                // CI's desktop cannot fit the local 760/900-height windows.
                // Fixed content bounds remain inside its work area; never adapt
                // a requested viewport to whatever dimensions happen to fit.
                const requestedContentBounds = ciLane
                  ? { x: display.workArea.x, y: display.workArea.y + 32, ...bounds }
                  : undefined;
                if (requestedContentBounds) {
                  window.show();
                  window.setContentBounds(requestedContentBounds);
                } else {
                  window.setContentSize(bounds.width, bounds.height);
                  window.show();
                }
                return {
                  requestedContentBounds,
                  contentBounds: window.getContentBounds(),
                  windowBounds: window.getBounds(),
                  primaryDisplayID: display.id,
                  primaryWorkArea: display.workArea,
                  displays: screen.getAllDisplays().map((display) => ({
                    id: display.id,
                    label: display.label,
                    bounds: display.bounds,
                    workArea: display.workArea,
                    scaleFactor: display.scaleFactor,
                    rotation: display.rotation
                  }))
                };
              },
              { route: surface === "main" ? "#/main" : "#/menubar", bounds, ciLane }
            );
            const renderer = await page.evaluate(async () => {
              await document.fonts.ready;
              return {
                viewport: { width: innerWidth, height: innerHeight },
                deviceScaleFactor: devicePixelRatio,
                userAgent: navigator.userAgent,
                locale: navigator.language,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                fontFamily: getComputedStyle(document.documentElement).fontFamily,
                fontStatus: document.fonts.status
              };
            });
            const environment = {
              macOS,
              kernel: os.release(),
              arch: process.arch,
              launchArguments,
              requestedViewport: bounds,
              geometry,
              visualLane: testInfo.config.metadata.visualLane,
              macOSBuild: execFileSync("/usr/bin/sw_vers", ["-buildVersion"], {
                encoding: "utf8"
              }).trim(),
              renderer,
              runtime: await application.evaluate(() => process.versions),
              gpuFeatureStatus: await application.evaluate(({ app }) => app.getGPUFeatureStatus())
            };
            // The list reporter does not persist body-only attachments. Keep
            // early metadata on disk even when a dimension assertion fails.
            const environmentPath = testInfo.outputPath("render-environment.json");
            await writeFile(
              environmentPath,
              JSON.stringify(
                {
                  ...environment,
                  provenance: JSON.parse(process.env.BASELINE_VISUAL_PROVENANCE ?? "null")
                },
                null,
                2
              )
            );
            await testInfo.attach("render-environment", {
              path: environmentPath,
              contentType: "application/json"
            });
            if (testInfo.config.updateSnapshots !== "none") {
              await writeFile(
                path.join(
                  testInfo.config.metadata.visualBaselineDirectory as string,
                  `environment-${name}.json`
                ),
                `${JSON.stringify(environment, null, 2)}\n`
              );
            }
            if (geometry.requestedContentBounds) {
              const requested = geometry.requestedContentBounds;
              const area = geometry.primaryWorkArea;
              expect(requested.x, "CI content left fits work area").toBeGreaterThanOrEqual(area.x);
              expect(requested.y, "CI content top fits work area").toBeGreaterThanOrEqual(area.y);
              expect(
                requested.x + requested.width,
                "CI content right fits work area"
              ).toBeLessThanOrEqual(area.x + area.width);
              expect(
                requested.y + requested.height,
                "CI content bottom fits work area"
              ).toBeLessThanOrEqual(area.y + area.height);
              expect(geometry.contentBounds).toEqual(geometry.requestedContentBounds);
            }
            await expect
              .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
              .toEqual(bounds);
            await expect
              .poll(() =>
                page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)
              )
              .toBe(motion === "reduce");
            await expect
              .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
              .toBe(theme === "dark");
            const shot = async (state: string) => {
              await page.mouse.move(0, 0);
              await page.evaluate(async () => {
                await document.fonts.ready;
                await Promise.all([...document.images].map((image) => image.decode()));
                // Parking the pointer can cancel a hover transition. Settle both
                // finished and canceled animations before waiting for paint.
                await Promise.allSettled(
                  document
                    .getAnimations()
                    .filter(
                      (animation) => animation.effect?.getComputedTiming().iterations !== Infinity
                    )
                    .map((animation) => animation.finished)
                );
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
                );
              });
              // Temporary, one-case CI diagnostic. Keep the assertion first so
              // frame sampling cannot turn a failing comparison into a pass.
              const phase = process.env.BASELINE_VISUAL_PROBE_PHASE;
              if (!phase || name !== "tray-narrow-light-reduce" || state !== "search") {
                await expect(page).toHaveScreenshot(`${name}-${state}.png`);
                return;
              }
              expect(ciLane).toBe(true);
              expect(["capture", "repeat"]).toContain(phase);
              const directory = path.join(
                process.cwd(),
                "ci-toolbar-probe",
                `${phase}-${testInfo.repeatEachIndex}`
              );
              await mkdir(directory, { recursive: true });
              const measure = () =>
                page.evaluate(() => {
                  const selectors = [
                    "html",
                    "body",
                    ".app-shell.compact",
                    ".popover-titlebar",
                    ".topbar-actions",
                    ".toolbar-search",
                    ".toolbar-search-field",
                    ".toolbar-search input",
                    'button[title="Settings"]',
                    'button[title="Settings"] svg',
                    'button[title="Settings"] svg path'
                  ];
                  return {
                    performanceTime: performance.now(),
                    dpr: devicePixelRatio,
                    fonts: document.fonts.status,
                    activeElement: document.activeElement?.outerHTML,
                    elements: selectors.map((selector) => {
                      const element = document.querySelector(selector);
                      if (!element) return { selector, missing: true };
                      const style = getComputedStyle(element);
                      return {
                        selector,
                        rect: element.getBoundingClientRect().toJSON(),
                        style: Object.fromEntries(
                          [
                            // Avoid adding utility candidates to Tailwind's
                            // automatic scan of test files.
                            "trans" + "form",
                            "transform-origin",
                            "opacity",
                            "color",
                            "background-color",
                            "filter",
                            "backdrop-" + "filter",
                            "fill",
                            "stroke",
                            "stroke-width",
                            "font-family",
                            "font-size",
                            "line-height",
                            "transition",
                            "animation",
                            "will-change"
                          ].map((property) => [property, style.getPropertyValue(property)])
                        )
                      };
                    }),
                    animations: document.getAnimations().map((animation) => ({
                      state: animation.playState,
                      currentTime: animation.currentTime,
                      timing: animation.effect?.getComputedTiming()
                    }))
                  };
                });
              const before = await measure();
              expect(before.dpr, "Probe preserves native CI DPR1").toBe(1);
              const assertionStarted = performance.now();
              let assertionError: unknown;
              try {
                await expect(page).toHaveScreenshot(`${name}-${state}.png`);
              } catch (error) {
                assertionError = error;
              }
              const assertionEnded = performance.now();
              let samplingError: unknown;
              try {
                await writeFile(
                  path.join(directory, "assertion.json"),
                  JSON.stringify(
                    {
                      screenshot: `${name}-${state}.png`,
                      before,
                      after: await measure(),
                      hostStartMs: assertionStarted,
                      hostEndMs: assertionEnded,
                      durationMs: assertionEnded - assertionStarted,
                      error: assertionError ? String(assertionError) : null
                    },
                    null,
                    2
                  )
                );
                // These are next-rAF-paced samples, not consecutive display
                // frames: awaiting capture can skip intervening frames.
                for (let frame = 0; frame < 8; frame++) {
                  const rafTime = await page.evaluate(
                    () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
                  );
                  const before = await measure();
                  const started = performance.now();
                  await page.screenshot({
                    path: path.join(directory, `frame-${frame}.png`),
                    animations: "disabled",
                    caret: "hide",
                    scale: "css"
                  });
                  const ended = performance.now();
                  await writeFile(
                    path.join(directory, `frame-${frame}.json`),
                    JSON.stringify(
                      {
                        screenshot: `frame-${frame}.png`,
                        rafTime,
                        before,
                        after: await measure(),
                        hostStartMs: started,
                        hostEndMs: ended,
                        durationMs: ended - started
                      },
                      null,
                      2
                    )
                  );
                }
              } catch (error) {
                samplingError = error;
                console.error("Toolbar probe sampling failed:", error);
              }
              // Diagnostic failure must never replace the strict comparison's
              // original failure, and neither failure is treated as a pass.
              if (assertionError) throw assertionError;
              if (samplingError) throw samplingError;
            };
            const tab = async (selectedTab: MenuTab) => {
              await page.evaluate(
                (selectedTab) => window.baseline.setSelectedTab(selectedTab),
                selectedTab
              );
              await expect
                .poll(() =>
                  page.evaluate(async () => (await window.baseline.getSnapshot()).selectedTab)
                )
                .toBe(selectedTab);
              const heading = {
                all: /Updates/,
                apps: /^Available/,
                homebrew: /^Outdated/,
                installed: /^Installed Apps/,
                ignored: /^Ignored Apps and Homebrew/
              }[selectedTab];
              await expect(page.locator(".content .panel-title").first()).toContainText(heading);
            };
            await expect(page.getByText("Atlas", { exact: true }).first()).toBeVisible();
            await shot("all");
            await page.locator(".operation-failure summary").click();
            await expect(page.getByLabel("Command output")).toContainText("connection timed out");
            await shot("failure-details");
            await page.getByRole("button", { name: "Report issue", exact: true }).click();
            await expect(
              page.getByRole("dialog", { name: "Report issue", exact: true })
            ).toBeVisible();
            await shot("report-dialog");
            await page
              .getByRole("dialog")
              .getByRole("button", { name: "Cancel", exact: true })
              .click();
            await page.locator(".operation-failure summary").click();
            if (surface === "main") {
              for (const selectedTab of ["apps", "homebrew", "installed", "ignored"] as const) {
                await tab(selectedTab);
                await shot(selectedTab);
              }
            }
            await page.getByRole("button", { name: "Search", exact: true }).click();
            const search = page.getByPlaceholder("Search", { exact: true });
            await search.fill("Grove");
            await expect(page.getByText("Grove", { exact: true })).toBeVisible();
            await shot("search");
            await page.getByRole("button", { name: "Install", exact: true }).click();
            await expect(
              page.getByRole("dialog", { name: "Install Grove?", exact: true })
            ).toBeVisible();
            await shot("install-dialog");
            await page
              .getByRole("dialog")
              .getByRole("button", { name: "Cancel", exact: true })
              .click();
            if (surface === "main") {
              await page.getByRole("button", { name: "Search", exact: true }).click();
              await search.fill("Cedar");
            } else {
              // Compact search dismisses on outside clicks in the original app.
              // Use the normal outdated cask row to exercise its real action menu.
              await page.evaluate(() => window.baseline.setSearchText(""));
              await expect(search).toHaveAttribute("aria-hidden", "true");
            }
            const cedar = page
              .locator("article")
              .filter({ has: page.getByText("Cedar", { exact: true }) });
            await cedar.getByRole("button", { name: "Actions", exact: true }).click();
            await expect(
              page.getByRole("menuitem", { name: "Uninstall", exact: true })
            ).toBeVisible();
            await shot("row-menu");
            await page.getByRole("menuitem", { name: "Uninstall", exact: true }).click();
            await expect(
              page.getByRole("dialog", { name: "Uninstall Cedar?", exact: true })
            ).toBeVisible();
            await shot("uninstall-dialog");
            await page
              .getByRole("dialog")
              .getByRole("button", { name: "Cancel", exact: true })
              .click();

            if (surface === "main") {
              await page.evaluate(() => window.baseline.showSettings());
              await expect(page.locator("h1")).toHaveText("General");
              await shot("settings-general");
              for (const section of ["Profile", "Appearance", "Diagnostics"]) {
                await page.getByRole("button", { name: section, exact: true }).click();
                await expect(page.locator("h1")).toHaveText(section);
                await shot(`settings-${section.toLowerCase()}`);
              }
            }
            expect(errors).toEqual([]);
          } finally {
            if (application) await cleanupApplications([application]);
            await rm(userData, { recursive: true, force: true });
          }
        });
      }
    }
  }
}
