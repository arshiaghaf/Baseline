// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { renderDiagnostics } from "../src/shared/diagnostics";
import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewManagedItem,
  UpdateRecord
} from "../src/shared/domain";
import { defaultPersistedSnapshot } from "../src/shared/domain";
import { version } from "../src/shared/version";

function appRecord(patch: Partial<AppRecord>): AppRecord {
  return {
    id: "app:example",
    bundlePath: "/Applications/Example.app",
    displayName: "Example",
    bundleIdentifier: "com.example.app",
    localVersion: version("1.0.0"),
    sourceHint: "unknown",
    ...patch
  };
}

function appUpdate(patch: Partial<UpdateRecord>): UpdateRecord {
  return {
    id: "app:example",
    appID: "app:example",
    source: "sparkle",
    supportLevel: "limited",
    localVersion: version("1.0.0"),
    remoteVersion: version("2.0.0"),
    checkedAt: "2026-06-28T12:00:00.000Z",
    ...patch
  };
}

function snapshot(patch: Partial<BaselineSnapshot> = {}): BaselineSnapshot {
  return {
    ...defaultPersistedSnapshot(),
    isMasInstalled: false,
    isHomebrewInstalled: false,
    isChecking: false,
    isRefreshing: false,
    searchText: "",
    isRunningHomebrewMaintenance: false,
    isHomebrewCommandLocked: false,
    appUpdatingIDs: [],
    appUpdatedPendingRefreshIDs: [],
    homebrewUpdatingItemIDs: [],
    homebrewQueuedItemIDs: [],
    homebrewUninstallingItemIDs: [],
    homebrewUpdatedPendingRefreshItemIDs: [],
    homebrewBatchProgressByItemID: {},
    homebrewBatchFailedItemIDs: [],
    homebrewFallbackProgressByAppID: {},
    homebrewFallbackFailedAppIDs: [],
    homebrewDiscoverItems: [],
    homebrewDiscoverInstallingItemIDs: [],
    homebrewDiscoverInstalledPendingRefreshItemIDs: [],
    homebrewDiscoverFailedItemIDs: [],
    homebrewDiscoverProgressByItemID: {},
    laggingHomebrewCaskTokens: [],
    defaultScanDirectories: ["/Applications"],
    ...patch
  };
}

describe("diagnostics report", () => {
  it("includes update source routing evidence without treating Homebrew as ownership", () => {
    const appStoreApp = appRecord({
      id: "app:store",
      displayName: "Store App",
      sourceHint: "appStore",
      hasAppStoreEvidence: true
    });
    const publisherUpdaterApp = appRecord({
      id: "app:publisher",
      displayName: "Publisher App",
      sourceHint: "sparkle",
      sparkleFeedURL: "https://updates.example.com/appcast.xml"
    });
    const directDownloadApp = appRecord({
      id: "app:direct",
      displayName: "Direct App"
    });
    const homebrewApp = appRecord({
      id: "app:managed",
      displayName: "Managed App",
      sourceHint: "homebrew"
    });
    const linkedCask: HomebrewManagedItem = {
      id: "cask:managed",
      token: "managed",
      name: "Managed App",
      kind: "cask",
      appID: homebrewApp.id,
      presentation: "app",
      installedVersion: version("1.0.0"),
      latestVersion: version("2.0.0"),
      isOutdated: true
    };
    const standaloneCask: HomebrewManagedItem = {
      id: "cask:standalone-tool",
      token: "standalone-tool",
      name: "standalone-tool",
      kind: "cask",
      presentation: "cli",
      installedVersion: version("1.0.0"),
      latestVersion: version("1.0.0"),
      isOutdated: false
    };
    const formula: HomebrewManagedItem = {
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      kind: "formula",
      installedVersion: version("1.0.0"),
      latestVersion: version("1.1.0"),
      isOutdated: true
    };

    const report = renderDiagnostics(
      snapshot({
        apps: [appStoreApp, publisherUpdaterApp, directDownloadApp, homebrewApp],
        updates: [
          appUpdate({ appID: publisherUpdaterApp.id, id: publisherUpdaterApp.id }),
          appUpdate({
            appID: homebrewApp.id,
            id: homebrewApp.id,
            source: "homebrew",
            supportLevel: "supported",
            homebrewToken: linkedCask.token
          }),
          appUpdate({
            appID: directDownloadApp.id,
            id: directDownloadApp.id,
            source: "homebrew",
            supportLevel: "limited",
            homebrewToken: "direct-app"
          })
        ],
        homebrewItems: [linkedCask, standaloneCask, formula],
        isHomebrewInstalled: true
      }),
      { version: "0.2.0", buildNumber: "42" },
      "darwin"
    );

    expect(report).toContain(
      "- Source hints: App Store: 1, In-app updater: 1, Unknown: 1, Homebrew: 1"
    );
    expect(report).toContain("- Update sources: In-app updater: 1, Homebrew: 2");
    expect(report).toContain("- Apps with publisher updater feed: 1");
    expect(report).toContain("- Direct-download candidates without known feed: 1");
    expect(report).toContain("- Homebrew app updates with installed cask link: 1");
    expect(report).toContain("- Homebrew app updates without installed cask link: 1");
    expect(report).toContain("- Homebrew detected: Yes");
    expect(report).toContain("- Formulae: 1");
    expect(report).toContain("- Casks: 2");
    expect(report).toContain("- App-linked casks: 1");
  });
});
