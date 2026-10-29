// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { _electron as electron, expect, test } from "@playwright/test";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultPersistedSnapshot } from "../src/shared/domain";
import type { ReleaseNotesResult } from "../src/shared/releaseNotes";
import { version } from "../src/shared/version";

let entry: string;
test.beforeAll(async () => {
  const result = await promisify(execFile)(
    process.execPath,
    ["scripts/preview-release-notes.mjs", "--prepare"],
    { cwd: process.cwd(), timeout: 60_000 }
  );
  entry = JSON.parse(result.stdout.trim().split("\n").at(-1)!).entry;
});

test("verifies release-note hovering, cancellation, keyboard, navigation and long content in hidden Electron", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-notes-rendered-"));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let ownedProcess: ChildProcess | undefined;
  try {
    const apps = ["Store Sample", "Publisher Sample", "Offline Sample"].map((displayName, i) => ({
      id: `app:notes-${i}`,
      bundlePath: `/Sample Inventory/${displayName}.app`,
      displayName,
      bundleIdentifier: `org.example.notes-${i}`,
      localVersion: version("1"),
      sourceHint: "unknown" as const
    }));
    const item = {
      id: "formula:notes-sample",
      token: "notes-sample",
      name: "Command Sample",
      kind: "formula",
      installedVersion: version("1"),
      latestVersion: version("2"),
      isOutdated: true,
      formulaIdentity: {
        name: "notes-sample",
        fullName: "notes-sample",
        tap: "homebrew/core",
        oldNames: []
      }
    };
    const snapshot = {
      ...defaultPersistedSnapshot(),
      apps,
      updates: apps.map((app, i) => ({
        id: app.id,
        appID: app.id,
        source: i === 0 ? "appStore" : "sparkle",
        supportLevel: "supported",
        localVersion: app.localVersion,
        remoteVersion: version("2"),
        checkedAt: new Date().toISOString(),
        releaseNotesSummary: "Published store notes",
        releaseNotesURL: "https://example.com/notes/2"
      })),
      homebrewItems: [item]
    };
    const longResult: ReleaseNotesResult = {
      status: "available",
      title: "Store Sample",
      version: "2",
      source: "App Store",
      sourceURL: "https://example.com/notes/2",
      blocks: [
        { type: "heading", text: "Published changes" },
        ...Array.from({ length: 70 }, (_, i) => ({
          type: "paragraph" as const,
          text: `Change ${i + 1}: ${"Useful details and long identifiers. ".repeat(8)}`
        })),
        { type: "paragraph", text: "<script>globalThis.untrustedNoteRan=true</script>" }
      ]
    };
    const fixtures = {
      [apps[0]!.id]: { result: longResult, delayMs: 200 },
      [apps[1]!.id]: {
        result: {
          ...longResult,
          title: "Publisher Sample",
          blocks: [{ type: "paragraph", text: "Publisher notes loaded." }]
        },
        delayMs: 1200
      },
      [apps[2]!.id]: {
        result: {
          status: "error",
          title: "Offline Sample",
          version: "2",
          message: "Publisher temporarily unavailable."
        },
        delayMs: 150
      },
      [item.id]: {
        result: {
          status: "unavailable",
          title: "Command Sample",
          version: "2",
          message: "No version-matched publisher release notes were found."
        }
      }
    };
    await writeFile(path.join(directory, "snapshot.json"), JSON.stringify(snapshot));
    await writeFile(path.join(directory, "notes.json"), JSON.stringify(fixtures));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BASELINE_NOTES_PREVIEW_ROOT: process.cwd(),
      BASELINE_NOTES_PREVIEW_PROFILE: path.join(directory, "profile"),
      BASELINE_NOTES_PREVIEW_SNAPSHOT: path.join(directory, "snapshot.json"),
      BASELINE_NOTES_PREVIEW_FIXTURE_NOTES: path.join(directory, "notes.json"),
      BASELINE_NOTES_PREVIEW_HIDDEN: "1"
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const launchEnv = Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
    application = await electron.launch({ args: [entry], env: launchEnv });
    ownedProcess = application.process();
    console.log(`Owned hidden preview PID ${ownedProcess.pid}: ${entry}`);
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator("h1")).toHaveText("All");
    await expect(page.getByRole("note")).toContainText("Fixture mode");
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
      )
    ).toBe(true);

    const store = page.getByRole("button", { name: "Release notes for Store Sample", exact: true });
    await expect(store.locator("svg.lucide-list-checks")).toHaveCount(1);
    const storeAnchor = page.locator(".release-notes-anchor").filter({ has: store });
    const publisher = page.getByRole("button", {
      name: "Release notes for Publisher Sample",
      exact: true
    });
    const publisherAnchor = page.locator(".release-notes-anchor").filter({ has: publisher });
    const assertInlineNotesButton = async (button: typeof store) => {
      const layout = await button.evaluate((node) => {
        const previous = node.previousElementSibling!;
        const icon = node.getBoundingClientRect();
        const versions = previous.getBoundingClientRect();
        const style = getComputedStyle(node);
        const versionStyle = getComputedStyle(previous);
        return {
          sameColor: style.color === versionStyle.color,
          hitArea: icon.width,
          parent: node.parentElement?.className,
          gap: icon.left - versions.right,
          aligned: Math.abs(icon.top + icon.height / 2 - (versions.top + versions.height / 2))
        };
      });
      expect(layout.parent).toContain("release-notes-version-line");
      expect(layout.sameColor).toBe(true);
      expect(layout.hitArea).toBeGreaterThanOrEqual(24);
      expect(layout.gap).toBeGreaterThanOrEqual(0);
      expect(layout.gap).toBeLessThanOrEqual(8);
      expect(layout.aligned).toBeLessThanOrEqual(3);
    };
    await assertInlineNotesButton(store);
    await storeAnchor.hover();
    await page.waitForTimeout(200);
    await page.locator("h1").hover();
    await page.waitForTimeout(500);
    await expect(page.getByRole("dialog", { name: "Release notes", exact: true })).toHaveCount(0);
    await storeAnchor.hover();
    await page.waitForTimeout(400);
    await expect(page.getByRole("dialog", { name: "Release notes", exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Release notes", exact: true })).toBeVisible({
      timeout: 1500
    });
    await expect(page.getByText("Published changes", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "View source", exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (globalThis as typeof globalThis & { untrustedNoteRan?: boolean }).untrustedNoteRan
      )
    ).toBeUndefined();
    const panel = page.getByRole("dialog", { name: "Release notes", exact: true });
    await panel.hover();
    await page.waitForTimeout(250);
    await expect(panel).toBeVisible();
    const output = process.env.BASELINE_NOTES_PREVIEW_ARTIFACTS ?? test.info().outputDir;
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "desktop-notes.png") });
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    await store.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Close release notes" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(store).toBeFocused();

    await page.getByRole("button", { name: "Search", exact: true }).click();
    const search = page.getByRole("dialog", { name: "Search", exact: true });
    await search.getByPlaceholder("Search", { exact: true }).fill("Store");
    const searchNotes = search.getByRole("button", {
      name: "Release notes for Store Sample",
      exact: true
    });
    await searchNotes.click();
    await expect(page.getByRole("button", { name: "Close release notes" })).toBeFocused();
    await page.keyboard.press("Tab");
    const notesContent = page.getByLabel("Release notes content", { exact: true });
    await expect(notesContent).toBeFocused();
    await page.keyboard.press("PageDown");
    await expect.poll(() => notesContent.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Close release notes" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(search).toBeVisible();
    await expect(searchNotes).toBeFocused();
    await search.getByPlaceholder("Search", { exact: true }).fill("Offline");
    await search
      .getByRole("button", { name: "Release notes for Offline Sample", exact: true })
      .click();
    await expect(page.getByText("Couldn’t load release notes", { exact: true })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(notesContent).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(notesContent).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(search).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);
    await page.evaluate(() => window.baseline.setSearchText(""));

    await publisherAnchor.hover();
    await expect(page.getByText("Loading release notes…")).toBeVisible({ timeout: 3000 });
    await page.getByRole("button", { name: "Release notes for Offline Sample" }).click();
    await expect(page.getByText("Couldn’t load release notes", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByText("Couldn’t load release notes", { exact: true })).toBeVisible();
    await page.waitForTimeout(1400);
    await expect(page.getByText("Publisher notes loaded.")).toHaveCount(0);
    await page
      .locator(".sidebar")
      .getByRole("button", { name: /^Homebrew/ })
      .click();
    await expect(page.getByRole("dialog", { name: "Release notes", exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Release notes for Command Sample", exact: true })
      .click();
    await expect(page.getByText("Release notes unavailable", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Release notes for Command Sample", exact: true })
    ).toHaveCount(0);
    await page.screenshot({ path: path.join(output, "unavailable-notes.png") });
    await page.keyboard.press("Escape");

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setContentSize(440, 560);
    });
    await page.evaluate(() => {
      location.hash = "/menubar";
    });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(440);
    await page.getByRole("button", { name: "Release notes for Store Sample", exact: true }).click();
    await assertInlineNotesButton(
      page.getByRole("button", { name: "Release notes for Store Sample", exact: true })
    );
    await expect(page.getByText("Published changes", { exact: true })).toBeVisible();
    const dimensions = await page
      .getByRole("dialog", { name: "Release notes", exact: true })
      .evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight
        };
      });
    expect(dimensions.left).toBeGreaterThanOrEqual(0);
    expect(dimensions.top).toBeGreaterThanOrEqual(0);
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewportWidth);
    expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.viewportHeight);
    expect(
      await page
        .locator(".release-notes-body")
        .evaluate((node) => node.scrollHeight > node.clientHeight)
    ).toBe(true);
    await page.screenshot({ path: path.join(output, "compact-notes.png") });
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.baseline.performHomebrewUpdate("formula:notes-sample"));
    const current = await page.evaluate(() => window.baseline.getSnapshot());
    expect(current.lastRefreshNoticeMessage).toContain("Read-only preview");
    expect(current.homebrewItems[0]?.installedVersion.raw).toBe("1");
    expect(errors).toEqual([]);
  } finally {
    if (application) {
      await application.close();
      expect(ownedProcess!.exitCode !== null || ownedProcess!.signalCode !== null).toBe(true);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
