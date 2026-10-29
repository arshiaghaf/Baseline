// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BaselineAPI } from "../src/shared/ipc";
import { ipcChannels } from "../src/shared/ipc";
import type { ReleaseNotesResult } from "../src/shared/releaseNotes";
import { backendIpcRegistrar } from "../src/main/backendIpc";
import { isTrustedBackendSender } from "../src/main/backendIpcAuthorization";
import { publicNotesURL } from "../src/main/releaseNotesFetch";
import { ReleaseNotesService } from "../src/main/releaseNotesService";
import { ReleaseNotesRequests } from "../src/main/releaseNotesRequests";
import { previewSnapshot, publishedSampleSnapshot } from "./snapshot";
import { preparePreviewProfile } from "./profile";

type Fixture = { result?: ReleaseNotesResult; delayMs?: number; error?: string };
const hidden = process.env.BASELINE_NOTES_PREVIEW_HIDDEN === "1";
const fixturePath = process.env.BASELINE_NOTES_PREVIEW_FIXTURE_NOTES;
const route = process.env.BASELINE_NOTES_PREVIEW_ROUTE === "menubar" ? "menubar" : "main";
const root = process.env.BASELINE_NOTES_PREVIEW_ROOT ?? "";
if (!root) throw new Error("Launch this preview through scripts/preview-release-notes.mjs.");
app.name = "Baseline Release Notes Preview";
if (process.platform === "darwin" && hidden) app.setActivationPolicy("prohibited");

const profile = (() => {
  const profile = preparePreviewProfile(
    process.env.BASELINE_NOTES_PREVIEW_PROFILE,
    app.getPath("appData")
  );
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.setPath("logs", path.join(profile, "logs"));
  app.setPath("crashDumps", path.join(profile, "crashDumps"));
  return profile;
})();

async function start(): Promise<void> {
  await app.whenReady();

  let snapshot = process.env.BASELINE_NOTES_PREVIEW_SNAPSHOT
    ? previewSnapshot(
        JSON.parse(await readFile(process.env.BASELINE_NOTES_PREVIEW_SNAPSHOT, "utf8"))
      )
    : await publishedSampleSnapshot();
  const fixture: Record<string, Fixture> | undefined = fixturePath
    ? JSON.parse(await readFile(fixturePath, "utf8"))
    : undefined;
  const service = new ReleaseNotesService({ getSnapshot: () => snapshot });
  const notes = new ReleaseNotesRequests(
    fixture
      ? {
          getNotes: async (target, { signal }) => {
            const entry = fixture[target.id];
            if (!entry)
              return { status: "unavailable", title: "Release notes", version: target.version };
            await new Promise<void>((resolve, reject) => {
              const abort = () => {
                clearTimeout(timer);
                reject(new DOMException("Cancelled", "AbortError"));
              };
              const timer = setTimeout(
                () => {
                  signal.removeEventListener("abort", abort);
                  resolve();
                },
                Math.min(30_000, Math.max(0, entry.delayMs ?? 0))
              );
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            });
            if (entry.error) throw new Error(entry.error);
            return (
              entry.result ?? {
                status: "unavailable",
                title: "Release notes",
                version: target.version
              }
            );
          }
        }
      : service
  );
  const renderer = path.join(root, ".vite", "renderer", "main_window", "index.html");
  const documentURL = pathToFileURL(renderer).href;
  const window = new BrowserWindow({
    width: route === "menubar" ? 440 : 1042,
    height: route === "menubar" ? 560 : 759,
    minWidth: 360,
    minHeight: 400,
    show: false,
    title: "Baseline Release Notes Preview — read only",
    webPreferences: {
      preload: path.join(root, ".vite", "build", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  const senderID = window.webContents.id;
  window.webContents.once("destroyed", () => notes.close(senderID));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    target.hash = "";
    if (target.href !== documentURL) event.preventDefault();
  });
  const publish = () => {
    snapshot = { ...snapshot, snapshotRevision: (snapshot.snapshotRevision ?? 0) + 1 };
    window.webContents.send(ipcChannels.snapshotChanged, snapshot);
  };
  const blocked = () => {
    snapshot.lastRefreshNoticeMessage =
      "Read-only preview: app and package actions are disabled. No installed apps or packages have changed.";
    publish();
  };
  const handle = backendIpcRegistrar(ipcMain, (event) => {
    if (!isTrustedBackendSender(event, [window.webContents], documentURL))
      throw new Error("Untrusted preview caller");
  });
  type Method = Exclude<keyof BaselineAPI, "onSnapshotChanged" | "onSnapshotProgress">;
  for (const method of Object.keys(ipcChannels) as Array<keyof typeof ipcChannels>) {
    if (method === "snapshotChanged" || method === "snapshotProgress") continue;
    handle(method as Method, async (event, ...args: unknown[]) => {
      switch (method) {
        case "getSnapshot":
          return snapshot;
        case "getAppMetadata":
          return { version: "preview", displayVersion: "Release notes preview" };
        case "getToolStatus":
          return { isHomebrewInstalled: true, isMasInstalled: false, isChecking: false };
        case "permissionGuide":
          return {
            message: "This isolated preview uses sample inventory and needs no app permissions."
          };
        case "getReleaseNotes":
          return notes.get(event.sender.id, args[0] as Parameters<typeof notes.get>[1]);
        case "cancelReleaseNotes":
          return notes.cancel(event.sender.id, args[0] as string);
        case "setSelectedTab":
          snapshot.selectedTab = args[0] as typeof snapshot.selectedTab;
          publish();
          return;
        case "setSearchText":
          snapshot.searchText = args[0] as string;
          publish();
          return;
        case "updatePreferences": {
          const patch = args[0] as Record<string, unknown>;
          if (["system", "light", "dark"].includes(String(patch.appearancePreference)))
            nativeTheme.themeSource = patch.appearancePreference as "system" | "light" | "dark";
          snapshot = previewSnapshot({ ...snapshot, ...patch });
          publish();
          return;
        }
        case "openExternal": {
          const url = publicNotesURL(args[0] as string);
          if (!url || hidden) return false;
          await shell.openExternal(url.href);
          return true;
        }
        case "getDiagnostics":
          return "Read-only release-notes preview. No installed inventory or credentials are accessed.";
        case "getHomebrewInstalledContext":
          return undefined;
        case "showMainWindow":
          await window.loadFile(renderer, { hash: "/main" });
          return;
        case "showSettings":
          blocked();
          return;
        default:
          blocked();
          return;
      }
    });
  }
  window.webContents.on("did-finish-load", () => {
    void window.webContents.insertCSS(
      ".app-shell,.app-content-surface{height:calc(100vh - 28px)!important}#notes-preview-banner{position:fixed;bottom:0;left:0;right:0;height:28px;display:flex;align-items:center;justify-content:center;background:#173c61;color:white;font:12px -apple-system,sans-serif;z-index:100000;pointer-events:none}"
    );
    void window.webContents.executeJavaScript(
      `(() => { const banner=document.createElement('div'); banner.id='notes-preview-banner'; banner.setAttribute('role','note'); banner.textContent=${JSON.stringify(fixture ? "Fixture mode · sample inventory · app and package actions disabled" : "Read-only preview · sample inventory · app and package actions disabled")}; document.body.append(banner); })()`
    );
  });
  await window.loadFile(renderer, { hash: `/${route}` });
  console.log(
    JSON.stringify({
      previewPID: process.pid,
      profile,
      hidden,
      fixtureMode: Boolean(fixture),
      sampleApps: snapshot.apps.length,
      sampleHomebrew: snapshot.homebrewItems.length
    })
  );
  if (!hidden) window.show();
  app.on("window-all-closed", () => app.quit());
}
void start().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
