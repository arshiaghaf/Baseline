// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  defaultPersistedSnapshot,
  profileStatsSignatureVersion
} from "../src/shared/domain";
import { SnapshotPersistence } from "../src/main/persistence";
import {
  mergeHomebrewRecentlyUpdatedRecords,
  preservePreviousHomebrewOutdatedState,
  UpdateStore
} from "../src/main/updateStore";
import type {
  AppRecord,
  HomebrewCaskIndex,
  HomebrewManagedItem,
  PersistedSnapshot,
  ProfileStats
} from "../src/shared/domain";
import { version } from "../src/shared/version";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { force: true, recursive: true })));
  tempDirs = [];
});

function homebrewItem(
  patch: Partial<HomebrewManagedItem> & Pick<HomebrewManagedItem, "id" | "token" | "name">
): HomebrewManagedItem {
  return {
    kind: "formula",
    installedVersion: version("1.0.0"),
    isOutdated: false,
    ...patch
  };
}

function appRecord(
  patch: Pick<AppRecord, "bundlePath" | "displayName" | "localVersion"> & Partial<AppRecord>
): AppRecord {
  return {
    id: patch.bundlePath,
    sourceHint: "unknown",
    ...patch
  };
}

function caskIndexForSelfUpdatingApp(latestVersion: ReturnType<typeof version>): HomebrewCaskIndex {
  const entry = {
    token: "self-updating-app",
    version: latestVersion,
    presentation: "app" as const,
    bundleIdentifiers: ["com.example.selfupdating"],
    appBundleNames: ["self updating app.app"]
  };
  return {
    byToken: { "self-updating-app": entry },
    byBundleIdentifier: { "com.example.selfupdating": entry },
    byAppBundleName: { "self updating app.app": [entry] }
  };
}

describe("update store helpers", () => {
  it("records Homebrew formulas and casks whose installed version advanced", () => {
    const now = "2026-04-30T12:00:00.000Z";
    const records = mergeHomebrewRecentlyUpdatedRecords(
      [],
      [
        homebrewItem({ id: "formula:ripgrep", token: "ripgrep", name: "ripgrep" }),
        homebrewItem({
          id: "cask:visual-studio-code",
          token: "visual-studio-code",
          name: "Visual Studio Code",
          kind: "cask",
          installedVersion: version("1.99.0")
        })
      ],
      [
        homebrewItem({
          id: "formula:ripgrep",
          token: "ripgrep",
          name: "ripgrep",
          installedVersion: version("1.1.0")
        }),
        homebrewItem({
          id: "cask:visual-studio-code",
          token: "visual-studio-code",
          name: "Visual Studio Code",
          kind: "cask",
          installedVersion: version("1.100.0")
        })
      ],
      now,
      { currentDate: new Date("2026-05-01T12:00:00.000Z") }
    );

    expect(records).toEqual([
      expect.objectContaining({
        itemID: "cask:visual-studio-code",
        kind: "cask",
        fromVersion: version("1.99.0"),
        toVersion: version("1.100.0")
      }),
      expect.objectContaining({
        itemID: "formula:ripgrep",
        kind: "formula",
        fromVersion: version("1.0.0"),
        toVersion: version("1.1.0")
      })
    ]);
  });

  it("keeps the newest Homebrew recent record per item", () => {
    const records = mergeHomebrewRecentlyUpdatedRecords(
      [
        {
          id: "formula:ripgrep",
          itemID: "formula:ripgrep",
          token: "ripgrep",
          kind: "formula",
          displayName: "ripgrep",
          fromVersion: version("1.0.0"),
          toVersion: version("1.1.0"),
          updatedAt: new Date().toISOString()
        }
      ],
      [homebrewItem({ id: "formula:ripgrep", token: "ripgrep", name: "ripgrep" })],
      [
        homebrewItem({
          id: "formula:ripgrep",
          token: "ripgrep",
          name: "ripgrep",
          installedVersion: version("1.2.0")
        })
      ],
      new Date().toISOString()
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.toVersion).toEqual(version("1.2.0"));
  });

  it("drops stale Homebrew recent records when the current installed version no longer matches", () => {
    const records = mergeHomebrewRecentlyUpdatedRecords(
      [
        {
          id: "cask:managed-tool",
          itemID: "cask:managed-tool",
          token: "managed-tool",
          kind: "cask",
          displayName: "Managed Tool",
          fromVersion: version("2.0.0"),
          toVersion: version("3.0.0"),
          updatedAt: new Date().toISOString()
        }
      ],
      [
        homebrewItem({
          id: "cask:managed-tool",
          token: "managed-tool",
          name: "Managed Tool",
          kind: "cask",
          installedVersion: version("2.0.0")
        })
      ],
      [
        homebrewItem({
          id: "cask:managed-tool",
          token: "managed-tool",
          name: "Managed Tool",
          kind: "cask",
          installedVersion: version("1.0.0")
        })
      ],
      new Date().toISOString()
    );

    expect(records).toHaveLength(0);
  });

  it("keeps previous Homebrew outdated state when outdated detection is unreliable", () => {
    const current = [
      homebrewItem({
        id: "formula:ripgrep",
        token: "ripgrep",
        name: "ripgrep",
        installedVersion: version("14.0.0"),
        isOutdated: false
      })
    ];
    const previous = [
      homebrewItem({
        id: "formula:ripgrep",
        token: "ripgrep",
        name: "ripgrep",
        installedVersion: version("14.0.0"),
        latestVersion: version("14.1.0"),
        isOutdated: true
      })
    ];

    expect(
      preservePreviousHomebrewOutdatedState(current, previous, { formula: false, cask: true })[0]
    ).toMatchObject({
      latestVersion: version("14.1.0"),
      isOutdated: true
    });
    expect(
      preservePreviousHomebrewOutdatedState(current, previous, { formula: true, cask: false })[0]
        ?.isOutdated
    ).toBe(false);
  });

  it("does not preserve stale cask state when only formula outdated detection fails", () => {
    const current = [
      homebrewItem({
        id: "formula:ripgrep",
        token: "ripgrep",
        name: "ripgrep",
        installedVersion: version("14.0.0"),
        isOutdated: false
      }),
      homebrewItem({
        id: "cask:notion",
        token: "notion",
        name: "Notion",
        kind: "cask",
        installedVersion: version("4.1.0"),
        isOutdated: false
      })
    ];
    const previous = [
      homebrewItem({
        id: "formula:ripgrep",
        token: "ripgrep",
        name: "ripgrep",
        installedVersion: version("14.0.0"),
        latestVersion: version("14.1.0"),
        isOutdated: true
      }),
      homebrewItem({
        id: "cask:notion",
        token: "notion",
        name: "Notion",
        kind: "cask",
        installedVersion: version("4.0.0"),
        latestVersion: version("4.1.0"),
        isOutdated: true
      })
    ];

    const reconciled = preservePreviousHomebrewOutdatedState(current, previous, {
      formula: false,
      cask: true
    });

    expect(reconciled.find((item) => item.id === "formula:ripgrep")?.isOutdated).toBe(true);
    expect(reconciled.find((item) => item.id === "cask:notion")?.isOutdated).toBe(false);
  });

  it("persists resolved additional scan directories", async () => {
    let userData = "";
    const store = await makeStore({
      onUserData: (directory) => {
        userData = directory;
      }
    });
    const firstDirectory = path.join(userData, "Apps");
    const nestedDirectory = path.join(userData, "Apps", "..", "More Apps");

    await store.addDirectory(firstDirectory);
    await store.addDirectory(firstDirectory);
    await store.addDirectory(nestedDirectory);

    const resolvedFirst = path.resolve(firstDirectory);
    const resolvedNested = path.resolve(nestedDirectory);
    expect(store.getSnapshot().additionalDirectories).toEqual([resolvedFirst, resolvedNested]);
    await expect(new SnapshotPersistence(userData).load()).resolves.toMatchObject({
      additionalDirectories: [resolvedFirst, resolvedNested]
    });

    await store.removeDirectory(path.join(userData, "More Apps", "."));

    expect(store.getSnapshot().additionalDirectories).toEqual([resolvedFirst]);
    await expect(new SnapshotPersistence(userData).load()).resolves.toMatchObject({
      additionalDirectories: [resolvedFirst]
    });
  });

  it("persists the started using date through store saves", async () => {
    let userData = "";
    const startedUsingAt = "2026-06-01T12:00:00.000Z";
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        profileStats: {
          ...defaultPersistedSnapshot().profileStats,
          startedUsingAt
        }
      },
      onUserData: (directory) => {
        userData = directory;
      }
    });

    await store.updatePreferences({ showMenuBarIcon: false });

    await expect(new SnapshotPersistence(userData).load()).resolves.toMatchObject({
      profileStats: {
        startedUsingAt
      }
    });
  });

  it("scans default directories before additional directories", async () => {
    const scannedDirectories: string[][] = [];
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        additionalDirectories: ["/Users/example/Extra Apps"]
      },
      clients: {
        scanner: {
          scanApplications: async (directories) => {
            scannedDirectories.push(directories);
            return [];
          }
        }
      }
    });

    await store.refresh(false);

    expect(store.getSnapshot().defaultScanDirectories).toEqual([
      "/Applications",
      path.join(os.homedir(), "Applications")
    ]);
    expect(scannedDirectories[0]).toEqual([
      "/Applications",
      path.join(os.homedir(), "Applications"),
      "/Users/example/Extra Apps"
    ]);
  });

  it("passes Homebrew metadata update mode only for full refresh", async () => {
    const inventoryOptions: Array<{ updateMetadata?: boolean }> = [];
    const store = await makeStore({
      clients: {
        homebrewInventory: {
          fetchInventory: async (options) => {
            inventoryOptions.push(options ?? {});
            return {
              items: [],
              outdatedDetectionSucceeded: true,
              outdatedDetectionSucceededByKind: { formula: true, cask: true }
            };
          }
        }
      }
    });

    await store.refresh(false);
    await store.refresh(true);

    expect(inventoryOptions).toEqual([{ updateMetadata: true }, { updateMetadata: false }]);
  });

  it("skips Homebrew inventory and warnings when Homebrew is absent", async () => {
    const previousItem = homebrewItem({
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      installedVersion: version("14.0.0"),
      latestVersion: version("14.1.0"),
      isOutdated: true
    });
    const fetchInventory = vi.fn(async () => ({
      items: [],
      outdatedDetectionSucceeded: false,
      outdatedDetectionSucceededByKind: { formula: false, cask: false },
      warning: "Homebrew outdated status could not be read reliably."
    }));
    const runBrewCommand = vi.fn(async () => ({
      success: false,
      status: null,
      output: ""
    }));
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        homebrewItems: [previousItem]
      },
      runBrewCommand,
      clients: {
        homebrewInventory: { fetchInventory }
      }
    });

    await store.refreshToolStatus();
    await store.refresh(false);

    const snapshot = store.getSnapshot();
    expect(snapshot.isHomebrewInstalled).toBe(false);
    expect(fetchInventory).not.toHaveBeenCalled();
    expect(snapshot.homebrewItems).toEqual([]);
    expect(snapshot.lastRefreshNoticeMessage).toBeUndefined();
    expect(runBrewCommand).toHaveBeenCalledTimes(2);
    expect(runBrewCommand).toHaveBeenNthCalledWith(1, ["--version"]);
    expect(runBrewCommand).toHaveBeenNthCalledWith(2, ["--version"]);
  });

  it("rechecks Homebrew availability during refresh after Homebrew was absent", async () => {
    const installedItem = homebrewItem({
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      installedVersion: version("14.1.0")
    });
    const fetchInventory = vi.fn(async () => ({
      items: [installedItem],
      outdatedDetectionSucceeded: true,
      outdatedDetectionSucceededByKind: { formula: true, cask: true }
    }));
    let brewVersionChecks = 0;
    const runBrewCommand = vi.fn(async (command: string[]) => {
      if (command[0] === "--version") {
        brewVersionChecks += 1;
        return {
          success: brewVersionChecks >= 3,
          status: brewVersionChecks >= 3 ? 0 : null,
          output: ""
        };
      }
      return { success: true, status: 0, output: "" };
    });
    const store = await makeStore({
      runBrewCommand,
      clients: {
        homebrewInventory: { fetchInventory }
      }
    });

    await store.refreshToolStatus();
    await store.refresh(false);

    expect(store.getSnapshot().isHomebrewInstalled).toBe(false);
    expect(fetchInventory).not.toHaveBeenCalled();

    await store.refresh(false);

    expect(store.getSnapshot().isHomebrewInstalled).toBe(true);
    expect(fetchInventory).toHaveBeenCalledWith({ updateMetadata: true });
    expect(store.getSnapshot().homebrewItems).toEqual([installedItem]);
    expect(runBrewCommand).toHaveBeenCalledTimes(3);
  });

  it("refreshes Homebrew inventory after a successful install when Homebrew was previously absent", async () => {
    const installedItem = homebrewItem({
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      installedVersion: version("14.1.0")
    });
    const fetchInventory = vi.fn(async () => ({
      items: [installedItem],
      outdatedDetectionSucceeded: true,
      outdatedDetectionSucceededByKind: { formula: true, cask: true }
    }));
    let brewVersionChecks = 0;
    const runBrewCommand = vi.fn(async (command: string[]) => {
      if (command[0] === "--version") {
        brewVersionChecks += 1;
        return {
          success: brewVersionChecks >= 2,
          status: brewVersionChecks >= 2 ? 0 : null,
          output: ""
        };
      }
      return { success: true, status: 0, output: "" };
    });
    const store = await makeStore({
      runBrewCommand,
      clients: {
        homebrewInventory: { fetchInventory }
      }
    });

    await store.refreshToolStatus();
    await store.installHomebrewItem({
      id: "formula:ripgrep",
      kind: "formula",
      token: "ripgrep",
      displayName: "ripgrep",
      presentation: "formula",
      version: version("14.1.0")
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.isHomebrewInstalled).toBe(true);
    expect(fetchInventory).toHaveBeenCalledWith({ updateMetadata: true });
    expect(snapshot.homebrewItems).toEqual([installedItem]);
    expect(snapshot.homebrewDiscoverInstallingItemIDs).toEqual([]);
    expect(snapshot.homebrewDiscoverInstalledPendingRefreshItemIDs).toEqual([]);
  });

  it("does not let an older overlapping full refresh overwrite a newer snapshot", async () => {
    const olderApp = appRecord({
      bundlePath: "/Applications/Refresh Race.app",
      displayName: "Refresh Race",
      localVersion: version("1.0.0")
    });
    const newerApp = appRecord({
      bundlePath: "/Applications/Refresh Race.app",
      displayName: "Refresh Race",
      localVersion: version("2.0.0")
    });
    const scanResolutions: Array<(apps: AppRecord[]) => void> = [];
    const store = await makeStore({
      clients: {
        scanner: {
          scanApplications: () =>
            new Promise<AppRecord[]>((resolve) => {
              scanResolutions.push(resolve);
            })
        }
      }
    });

    const firstRefresh = store.refresh(false);
    const secondRefresh = store.refresh(false);

    expect(scanResolutions).toHaveLength(2);
    scanResolutions[1]?.([newerApp]);
    await secondRefresh;

    expect(store.getSnapshot().apps).toEqual([newerApp]);

    scanResolutions[0]?.([olderApp]);
    await firstRefresh;

    expect(store.getSnapshot().apps).toEqual([newerApp]);
  });

  it("does not let an older refresh overwrite state after later lookup work", async () => {
    const olderApp = appRecord({
      bundlePath: "/Applications/Refresh Lookup Race.app",
      displayName: "Refresh Lookup Race",
      bundleIdentifier: "com.example.refresh-lookup-race",
      localVersion: version("1.0.0")
    });
    const newerApp = {
      ...olderApp,
      localVersion: version("2.0.0")
    };
    const completedLookup = { type: "completed" as const };
    let scanCount = 0;
    let lookupCount = 0;
    let markFirstLookupStarted: () => void = () => undefined;
    let resolveFirstLookup: (value: typeof completedLookup) => void = () => undefined;
    const firstLookupStarted = new Promise<void>((resolve) => {
      markFirstLookupStarted = resolve;
    });
    const store = await makeStore({
      clients: {
        scanner: {
          scanApplications: async () => {
            scanCount += 1;
            return scanCount === 1 ? [olderApp] : [newerApp];
          }
        },
        appStore: {
          lookupOutcome: () => {
            lookupCount += 1;
            if (lookupCount === 1) {
              markFirstLookupStarted();
              return new Promise<typeof completedLookup>((resolve) => {
                resolveFirstLookup = resolve;
              });
            }
            return Promise.resolve(completedLookup);
          }
        }
      }
    });

    const firstRefresh = store.refresh(false);
    await firstLookupStarted;
    const secondRefresh = store.refresh(false);

    await secondRefresh;

    expect(store.getSnapshot().apps).toEqual([newerApp]);

    resolveFirstLookup(completedLookup);
    await firstRefresh;

    expect(store.getSnapshot().apps).toEqual([newerApp]);
  });

  it("surfaces GitHub release self-update availability during refresh", async () => {
    const lookup = vi.fn(async (currentVersion: ReturnType<typeof version>, checkedAt: string) => ({
      available: true,
      currentVersion,
      latestVersion: version("0.2.0"),
      releaseURL: "https://github.com/arshiaghaf/Baseline/releases/latest",
      checkedAt
    }));
    const store = await makeStore({
      currentAppVersion: "0.1.0",
      clients: {
        selfUpdate: { lookup }
      }
    });

    await store.refresh(false);

    expect(lookup).toHaveBeenCalledWith(version("0.1.0"), expect.any(String));
    expect(store.getSnapshot().selfUpdate).toMatchObject({
      available: true,
      currentVersion: version("0.1.0"),
      latestVersion: version("0.2.0"),
      releaseURL: "https://github.com/arshiaghaf/Baseline/releases/latest"
    });
  });

  it("preserves App Store, Sparkle, then Homebrew update source precedence", async () => {
    const precedenceApp = appRecord({
      bundlePath: "/Applications/Precedence.app",
      displayName: "Precedence",
      bundleIdentifier: "com.example.precedence",
      sparkleFeedURL: "https://updates.example.com/appcast.xml",
      localVersion: version("1.0.0")
    });
    const clients = {
      scanner: { scanApplications: async () => [precedenceApp] },
      homebrew: {
        fetchIndex: async () => emptyHomebrewCaskIndex,
        lookupUpdate: () => ({
          remoteVersion: version("2.0.0"),
          token: "precedence"
        }),
        searchCasks: () => []
      }
    };
    const storeWithAppStore = await makeStore({
      clients: {
        ...clients,
        appStore: {
          lookupOutcome: async () => ({
            type: "completed",
            value: {
              remoteVersion: version("4.0.0"),
              updateURL: "https://apps.apple.com/app/example",
              appStoreItemID: 123
            }
          })
        },
        sparkle: {
          lookupOutcome: async () => ({
            type: "completed",
            value: {
              remoteVersion: version("3.0.0"),
              updateURL: "https://updates.example.com/download"
            }
          })
        }
      }
    });

    await storeWithAppStore.refresh(false);
    expect(storeWithAppStore.getSnapshot().updates[0]).toMatchObject({
      source: "appStore",
      remoteVersion: version("4.0.0")
    });

    const storeWithSparkle = await makeStore({
      clients: {
        ...clients,
        appStore: { lookupOutcome: async () => ({ type: "completed" }) },
        sparkle: {
          lookupOutcome: async () => ({
            type: "completed",
            value: {
              remoteVersion: version("3.0.0"),
              updateURL: "https://updates.example.com/download"
            }
          })
        }
      }
    });

    await storeWithSparkle.refresh(false);
    expect(storeWithSparkle.getSnapshot().updates[0]).toMatchObject({
      source: "sparkle",
      remoteVersion: version("3.0.0")
    });

    const storeWithHomebrew = await makeStore({
      clients: {
        ...clients,
        appStore: { lookupOutcome: async () => ({ type: "completed" }) },
        sparkle: { lookupOutcome: async () => ({ type: "completed" }) }
      }
    });

    await storeWithHomebrew.refresh(false);
    expect(storeWithHomebrew.getSnapshot().updates[0]).toMatchObject({
      source: "homebrew",
      remoteVersion: version("2.0.0"),
      homebrewToken: "precedence"
    });
  });

  it("does not create Homebrew fallback updates for Sparkle-origin apps without installed cask ownership", async () => {
    const sparkleApp = appRecord({
      bundlePath: "/Applications/Sparkle App.app",
      displayName: "Sparkle App",
      bundleIdentifier: "com.example.sparkle-app",
      sparkleFeedURL: "https://updates.example.com/appcast.xml",
      sourceHint: "sparkle",
      localVersion: version("1.0.0")
    });
    const homebrewCaskEntry = {
      token: "sparkle-app",
      version: version("2.0.0"),
      homepageURL: "https://formulae.brew.sh/cask/sparkle-app",
      presentation: "app" as const,
      bundleIdentifiers: ["com.example.sparkle-app"],
      appBundleNames: ["sparkle app.app"]
    };
    const homebrewIndex = {
      byToken: { "sparkle-app": homebrewCaskEntry },
      byBundleIdentifier: { "com.example.sparkle-app": homebrewCaskEntry },
      byAppBundleName: { "sparkle app.app": [homebrewCaskEntry] }
    };
    const lookupUpdate = vi.fn(() => ({
      remoteVersion: version("2.0.0"),
      token: "sparkle-app",
      homepageURL: "https://formulae.brew.sh/cask/sparkle-app"
    }));
    const clients = {
      scanner: { scanApplications: async () => [sparkleApp] },
      appStore: { lookupOutcome: async () => ({ type: "completed" as const }) },
      sparkle: { lookupOutcome: async () => ({ type: "completed" as const }) },
      homebrew: {
        fetchIndex: async () => homebrewIndex,
        lookupUpdate,
        searchCasks: () => []
      }
    };
    const unmanagedStore = await makeStore({ clients });

    await unmanagedStore.refresh(false);

    expect(lookupUpdate).toHaveBeenCalled();
    expect(unmanagedStore.getSnapshot().updates).toEqual([]);

    const managedStore = await makeStore({
      clients: {
        ...clients,
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: "cask:sparkle-app",
                token: "sparkle-app",
                name: "Sparkle App",
                kind: "cask",
                installedVersion: version("1.0.0"),
                latestVersion: version("2.0.0"),
                isOutdated: true
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });

    await managedStore.refresh(false);

    expect(managedStore.getSnapshot().updates[0]).toMatchObject({
      source: "homebrew",
      remoteVersion: version("2.0.0"),
      homebrewToken: "sparkle-app"
    });
    expect(managedStore.getSnapshot().homebrewItems[0]).toMatchObject({
      id: "cask:sparkle-app",
      appID: sparkleApp.id,
      presentation: "app"
    });
  });

  it("only enables iOS App Store lookup for installed iOS-on-Mac apps", async () => {
    const iOSAppOnMac = appRecord({
      bundlePath: "/Applications/App Store iPad App.app",
      displayName: "App Store iPad App",
      bundleIdentifier: "com.example.ipad-app",
      localVersion: version("1.0.0"),
      sourceHint: "appStore",
      isIOSAppOnMac: true,
      hasAppStoreEvidence: true
    });
    const sideloadedIOSAppOnMac = appRecord({
      bundlePath: "/Applications/Sideloaded iPad App.app",
      displayName: "Sideloaded iPad App",
      bundleIdentifier: "com.example.sideloaded-ipad-app",
      sourceHint: "unknown",
      localVersion: version("1.0.0"),
      isIOSAppOnMac: true,
      hasAppStoreEvidence: false
    });
    const nativeMacApp = appRecord({
      bundlePath: "/Applications/Native Mac App.app",
      displayName: "Native Mac App",
      bundleIdentifier: "com.example.native-mac-app",
      sourceHint: "appStore",
      localVersion: version("1.0.0")
    });
    const lookupOutcome = vi.fn(async () => ({ type: "completed" as const }));
    const store = await makeStore({
      clients: {
        scanner: {
          scanApplications: async () => [iOSAppOnMac, sideloadedIOSAppOnMac, nativeMacApp]
        },
        appStore: { lookupOutcome }
      }
    });

    await store.refresh(false);

    expect(lookupOutcome).toHaveBeenNthCalledWith(
      1,
      iOSAppOnMac.bundleIdentifier,
      iOSAppOnMac.localVersion,
      { includeIOSAppStoreSoftware: true }
    );
    expect(lookupOutcome).toHaveBeenNthCalledWith(
      2,
      sideloadedIOSAppOnMac.bundleIdentifier,
      sideloadedIOSAppOnMac.localVersion,
      { includeIOSAppStoreSoftware: false }
    );
    expect(lookupOutcome).toHaveBeenNthCalledWith(
      3,
      nativeMacApp.bundleIdentifier,
      nativeMacApp.localVersion,
      { includeIOSAppStoreSoftware: false }
    );
  });

  it("does not mark apps recently updated when a lookup miss leaves the local version unchanged", async () => {
    const unchangedApp = appRecord({
      bundlePath: "/Applications/Lookup Miss.app",
      displayName: "Lookup Miss",
      bundleIdentifier: "com.example.lookup-miss",
      localVersion: version("1.0.0")
    });
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        apps: [unchangedApp],
        updates: [
          {
            id: unchangedApp.id,
            appID: unchangedApp.id,
            source: "sparkle",
            supportLevel: "supported",
            localVersion: version("1.0.0"),
            remoteVersion: version("2.0.0"),
            updateURL: "https://updates.example.com/download",
            checkedAt: "2026-05-20T12:00:00.000Z"
          }
        ]
      },
      clients: {
        scanner: { scanApplications: async () => [unchangedApp] }
      }
    });

    await store.refresh(false);

    expect(store.getSnapshot().updates).toEqual([]);
    expect(store.getSnapshot().recentlyUpdated).toEqual([]);
  });

  it("preserves Sparkle build-only update versions through update and recent history", async () => {
    const installedApp = appRecord({
      bundlePath: "/Applications/Build Only.app",
      displayName: "Build Only",
      bundleIdentifier: "com.example.build-only",
      sparkleFeedURL: "https://updates.example.com/appcast.xml",
      localVersion: version("1.0"),
      bundleVersion: version("100")
    });
    const refreshedApp = {
      ...installedApp,
      bundleVersion: version("101")
    };
    let scanCount = 0;
    const store = await makeStore({
      clients: {
        scanner: {
          scanApplications: async () => {
            scanCount += 1;
            return scanCount === 1 ? [installedApp] : [refreshedApp];
          }
        },
        appStore: { lookupOutcome: async () => ({ type: "completed" }) },
        sparkle: {
          lookupOutcome: async () =>
            scanCount === 1
              ? {
                  type: "completed",
                  value: {
                    remoteVersion: version("1.0"),
                    remoteBuildVersion: version("101"),
                    updateURL: "https://updates.example.com/download"
                  }
                }
              : { type: "completed" }
        }
      }
    });

    await store.refresh(false);

    expect(store.getSnapshot().updates[0]).toMatchObject({
      source: "sparkle",
      localVersion: version("1.0"),
      remoteVersion: version("1.0"),
      localBuildVersion: version("100"),
      remoteBuildVersion: version("101")
    });

    await store.refresh(false);

    expect(store.getSnapshot().updates).toEqual([]);
    expect(store.getSnapshot().recentlyUpdated[0]).toMatchObject({
      source: "sparkle",
      fromVersion: version("1.0"),
      toVersion: version("1.0"),
      fromBuildVersion: version("100"),
      toBuildVersion: version("101")
    });
  });

  it("surfaces unreliable Homebrew outdated detection and preserves previous outdated items", async () => {
    const previousItem = homebrewItem({
      id: "formula:ripgrep",
      token: "ripgrep",
      name: "ripgrep",
      installedVersion: version("14.0.0"),
      latestVersion: version("14.1.0"),
      isOutdated: true
    });
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        homebrewItems: [previousItem]
      },
      clients: {
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: "formula:ripgrep",
                token: "ripgrep",
                name: "ripgrep",
                installedVersion: version("14.0.0"),
                isOutdated: false
              })
            ],
            outdatedDetectionSucceeded: false,
            outdatedDetectionSucceededByKind: { formula: false, cask: true },
            warning: "Homebrew outdated status could not be read reliably."
          })
        }
      }
    });

    await store.refresh(false);

    const snapshot = store.getSnapshot();
    expect(snapshot.homebrewItems[0]).toMatchObject({
      latestVersion: version("14.1.0"),
      isOutdated: true
    });
    expect(snapshot.lastRefreshNoticeMessage).toContain("could not be read reliably");
  });

  it("clears stale cask updates when the installed app self-updated to the latest version", async () => {
    const selfUpdatingApp = appRecord({
      bundlePath: "/Applications/Self Updating App.app",
      displayName: "Self Updating App",
      bundleIdentifier: "com.example.selfupdating",
      localVersion: version("1.2026.119.1")
    });
    const store = await makeStore({
      clients: {
        scanner: { scanApplications: async () => [selfUpdatingApp] },
        homebrew: {
          fetchIndex: async () => caskIndexForSelfUpdatingApp(version("1.2026.119.1")),
          lookupUpdate: () => undefined,
          searchCasks: () => []
        },
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: "cask:self-updating-app",
                token: "self-updating-app",
                name: "self-updating-app",
                kind: "cask",
                installedVersion: version("1.2026.98.2"),
                latestVersion: version("1.2026.119.1"),
                isOutdated: true
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });

    await store.refresh(false);

    const item = store
      .getSnapshot()
      .homebrewItems.find((candidate) => candidate.id === "cask:self-updating-app");
    expect(item).toMatchObject({
      installedVersion: version("1.2026.119.1"),
      isOutdated: false
    });
    expect(item?.latestVersion).toBeUndefined();
  });

  it("matches package-backed casks through uninstall metadata before comparing versions", async () => {
    const packageBackedApp = appRecord({
      bundlePath: "/Applications/Package Backed.app",
      displayName: "Package Backed",
      bundleIdentifier: "com.example.pkgbacked",
      localVersion: version("1.3.0"),
      iconDataURL: "data:image/png;base64,package-backed"
    });
    const entry = {
      token: "pkg-backed-app",
      version: version("1.2.0"),
      presentation: "app" as const,
      bundleIdentifiers: [],
      inferredBundleIdentifiers: ["com.example.pkgbacked"],
      appBundleNames: ["package backed.app"]
    };
    const store = await makeStore({
      clients: {
        scanner: { scanApplications: async () => [packageBackedApp] },
        homebrew: {
          fetchIndex: async () => ({
            byToken: { "pkg-backed-app": entry },
            byBundleIdentifier: { "com.example.pkgbacked": entry },
            byAppBundleName: { "package backed.app": [entry] }
          }),
          lookupUpdate: () => undefined,
          searchCasks: () => []
        },
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: "cask:pkg-backed-app",
                token: "pkg-backed-app",
                name: "pkg-backed-app",
                kind: "cask",
                installedVersion: version("1.1.0"),
                latestVersion: version("1.2.0"),
                isOutdated: true
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });

    await store.refresh(false);

    const item = store
      .getSnapshot()
      .homebrewItems.find((candidate) => candidate.id === "cask:pkg-backed-app");
    expect(item).toMatchObject({
      name: "Package Backed",
      installedVersion: version("1.3.0"),
      iconDataURL: "data:image/png;base64,package-backed",
      isOutdated: false
    });
    expect(item?.latestVersion).toBeUndefined();
  });

  it("falls back to app names when inferred quit metadata points at a helper", async () => {
    const helperApp = appRecord({
      bundlePath: "/Applications/Package Backed Helper.app",
      displayName: "Package Backed Helper",
      bundleIdentifier: "com.example.pkgbacked.helper",
      localVersion: version("1.4.0"),
      iconDataURL: "data:image/png;base64,helper"
    });
    const packageBackedApp = appRecord({
      bundlePath: "/Applications/Package Backed.app",
      displayName: "Package Backed",
      bundleIdentifier: "com.example.pkgbacked",
      localVersion: version("1.3.0"),
      iconDataURL: "data:image/png;base64,package-backed"
    });
    const entry = {
      token: "pkg-backed-app",
      version: version("1.2.0"),
      presentation: "app" as const,
      bundleIdentifiers: [],
      inferredBundleIdentifiers: ["com.example.pkgbacked.helper"],
      appBundleNames: ["package backed.app"]
    };
    const store = await makeStore({
      clients: {
        scanner: { scanApplications: async () => [helperApp, packageBackedApp] },
        homebrew: {
          fetchIndex: async () => ({
            byToken: { "pkg-backed-app": entry },
            byBundleIdentifier: {},
            byAppBundleName: { "package backed.app": [entry] }
          }),
          lookupUpdate: () => undefined,
          searchCasks: () => []
        },
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: "cask:pkg-backed-app",
                token: "pkg-backed-app",
                name: "pkg-backed-app",
                kind: "cask",
                installedVersion: version("1.1.0"),
                latestVersion: version("1.2.0"),
                isOutdated: true
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });

    await store.refresh(false);

    const item = store
      .getSnapshot()
      .homebrewItems.find((candidate) => candidate.id === "cask:pkg-backed-app");
    expect(item).toMatchObject({
      name: "Package Backed",
      installedVersion: version("1.3.0"),
      iconDataURL: "data:image/png;base64,package-backed",
      isOutdated: false
    });
    expect(item?.latestVersion).toBeUndefined();
  });

  it("uses the app bundle version for self-updated casks that still have a newer cask release", async () => {
    const selfUpdatingApp = appRecord({
      bundlePath: "/Applications/Self Updating App.app",
      displayName: "Self Updating App",
      bundleIdentifier: "com.example.selfupdating",
      localVersion: version("1.2026.119.1")
    });
    const store = await makeStore({
      clients: {
        scanner: { scanApplications: async () => [selfUpdatingApp] },
        homebrew: {
          fetchIndex: async () => caskIndexForSelfUpdatingApp(version("1.2026.130.1")),
          lookupUpdate: () => undefined,
          searchCasks: () => []
        },
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: "cask:self-updating-app",
                token: "self-updating-app",
                name: "self-updating-app",
                kind: "cask",
                installedVersion: version("1.2026.98.2"),
                latestVersion: version("1.2026.130.1"),
                isOutdated: true
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });

    await store.refresh(false);

    const item = store
      .getSnapshot()
      .homebrewItems.find((candidate) => candidate.id === "cask:self-updating-app");
    expect(item).toMatchObject({
      installedVersion: version("1.2026.119.1"),
      latestVersion: version("1.2026.130.1"),
      isOutdated: true
    });
  });

  it("does not use loose name matches to change cask installed versions", async () => {
    const sameNameApp = appRecord({
      bundlePath: "/Applications/Self Updating App.app",
      displayName: "Self Updating App",
      bundleIdentifier: "com.example.unrelated",
      localVersion: version("1.2026.119.1"),
      iconDataURL: "data:image/png;base64,icon"
    });
    const store = await makeStore({
      clients: {
        scanner: { scanApplications: async () => [sameNameApp] },
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: "cask:self-updating-app",
                token: "self-updating-app",
                name: "self-updating-app",
                kind: "cask",
                installedVersion: version("1.2026.98.2"),
                latestVersion: version("1.2026.119.1"),
                isOutdated: true
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });

    await store.refresh(false);

    const item = store
      .getSnapshot()
      .homebrewItems.find((candidate) => candidate.id === "cask:self-updating-app");
    expect(item).toMatchObject({
      installedVersion: version("1.2026.98.2"),
      latestVersion: version("1.2026.119.1"),
      isOutdated: true,
      iconDataURL: "data:image/png;base64,icon"
    });
  });

  it("preserves proven cask app links when current cask metadata is unavailable", async () => {
    const selfUpdatingApp = appRecord({
      bundlePath: "/Applications/Self Updating App.app",
      displayName: "Self Updating App",
      bundleIdentifier: "com.example.selfupdating",
      localVersion: version("1.2026.119.1")
    });
    const store = await makeStore({
      clients: {
        scanner: { scanApplications: async () => [selfUpdatingApp] },
        homebrew: {
          fetchIndex: vi
            .fn()
            .mockResolvedValueOnce(caskIndexForSelfUpdatingApp(version("1.2026.119.1")))
            .mockResolvedValue(emptyHomebrewCaskIndex),
          lookupUpdate: () => undefined,
          searchCasks: () => []
        },
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: "cask:self-updating-app",
                token: "self-updating-app",
                name: "self-updating-app",
                kind: "cask",
                installedVersion: version("1.2026.98.2"),
                latestVersion: version("1.2026.119.1"),
                isOutdated: true
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });

    await store.refresh(false);
    await store.refresh(false);

    const item = store
      .getSnapshot()
      .homebrewItems.find((candidate) => candidate.id === "cask:self-updating-app");
    expect(item).toMatchObject({
      appID: selfUpdatingApp.id,
      presentation: "app",
      name: "self-updating-app",
      installedVersion: version("1.2026.98.2")
    });
  });

  it("preserves cask presentation when current cask metadata is unavailable", async () => {
    const entry = {
      token: "standalone-tool",
      version: version("1.0.0"),
      presentation: "cli" as const,
      bundleIdentifiers: [],
      appBundleNames: []
    };
    const store = await makeStore({
      clients: {
        homebrew: {
          fetchIndex: vi
            .fn()
            .mockResolvedValueOnce({
              byToken: { "standalone-tool": entry },
              byBundleIdentifier: {},
              byAppBundleName: {}
            })
            .mockResolvedValue(emptyHomebrewCaskIndex),
          lookupUpdate: () => undefined,
          searchCasks: () => []
        },
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: "cask:standalone-tool",
                token: "standalone-tool",
                name: "standalone-tool",
                kind: "cask",
                presentation: "cask",
                installedVersion: version("1.0.0")
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });

    await store.refresh(false);
    await store.refresh(false);

    expect(
      store.getSnapshot().homebrewItems.find((candidate) => candidate.id === "cask:standalone-tool")
    ).toMatchObject({
      presentation: "cli"
    });
  });

  it("does not use app bundle-name matches when cask and app bundle identifiers conflict", async () => {
    const sameNameApp = appRecord({
      bundlePath: "/Applications/Self Updating App.app",
      displayName: "Self Updating App",
      bundleIdentifier: "com.example.unrelated",
      localVersion: version("1.2026.119.1"),
      iconDataURL: "data:image/png;base64,icon"
    });
    const store = await makeStore({
      clients: {
        scanner: { scanApplications: async () => [sameNameApp] },
        homebrew: {
          fetchIndex: async () => caskIndexForSelfUpdatingApp(version("1.2026.119.1")),
          lookupUpdate: () => undefined,
          searchCasks: () => []
        },
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: "cask:self-updating-app",
                token: "self-updating-app",
                name: "self-updating-app",
                kind: "cask",
                installedVersion: version("1.2026.98.2"),
                latestVersion: version("1.2026.119.1"),
                isOutdated: true
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });

    await store.refresh(false);

    const item = store
      .getSnapshot()
      .homebrewItems.find((candidate) => candidate.id === "cask:self-updating-app");
    expect(item).toMatchObject({
      installedVersion: version("1.2026.98.2"),
      latestVersion: version("1.2026.119.1"),
      isOutdated: true,
      iconDataURL: undefined
    });
  });

  it("validates update-matched apps against cask metadata before changing cask versions", async () => {
    const sameNameApp = appRecord({
      bundlePath: "/Applications/Self Updating App.app",
      displayName: "Self Updating App",
      bundleIdentifier: "com.example.unrelated",
      localVersion: version("1.2026.119.1"),
      iconDataURL: "data:image/png;base64,icon"
    });
    const store = await makeStore({
      clients: {
        scanner: { scanApplications: async () => [sameNameApp] },
        homebrew: {
          fetchIndex: async () => caskIndexForSelfUpdatingApp(version("1.2026.119.1")),
          lookupUpdate: () => ({
            remoteVersion: version("1.2026.119.1"),
            token: "self-updating-app"
          }),
          searchCasks: () => []
        },
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: "cask:self-updating-app",
                token: "self-updating-app",
                name: "self-updating-app",
                kind: "cask",
                installedVersion: version("1.2026.98.2"),
                latestVersion: version("1.2026.119.1"),
                isOutdated: true
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });

    await store.refresh(false);

    const item = store
      .getSnapshot()
      .homebrewItems.find((candidate) => candidate.id === "cask:self-updating-app");
    expect(item).toMatchObject({
      installedVersion: version("1.2026.98.2"),
      latestVersion: version("1.2026.119.1"),
      isOutdated: true,
      iconDataURL: undefined
    });
  });

  it("suppresses duplicate Homebrew cask uninstall dispatches while running", async () => {
    const runBrewCommand = vi.fn(
      async (_args: string[], onOutputLine: (line: string) => void = () => undefined) => {
        onOutputLine("Error: still running");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { success: false, status: 1, output: "Error: still running" };
      }
    );
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        homebrewItems: [
          homebrewItem({
            id: "cask:notion",
            token: "notion",
            name: "Notion",
            kind: "cask"
          })
        ]
      },
      runBrewCommand
    });

    await Promise.all([
      store.uninstallHomebrewItem("cask:notion"),
      store.uninstallHomebrewItem("cask:notion")
    ]);

    expect(runBrewCommand).toHaveBeenCalledTimes(1);
    expect(runBrewCommand).toHaveBeenCalledWith(
      ["uninstall", "--cask", "notion"],
      expect.any(Function)
    );
    expect(store.getSnapshot().refreshErrorMessage).toContain("Error: still running");
  });

  it("updates only non-ignored Homebrew items in a batch run", async () => {
    const runBrewCommand = vi.fn<
      NonNullable<ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"]>
    >(async () => ({
      success: true,
      status: 0,
      output: ""
    }));
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        ignoredHomebrewItemIDs: ["formula:ignored-formula", "cask:ignored-cask"],
        homebrewItems: [
          homebrewItem({
            id: "formula:ripgrep",
            token: "ripgrep",
            name: "ripgrep",
            kind: "formula",
            latestVersion: version("14.1.0"),
            isOutdated: true
          }),
          homebrewItem({
            id: "formula:ignored-formula",
            token: "ignored-formula",
            name: "ignored-formula",
            kind: "formula",
            latestVersion: version("2.0.0"),
            isOutdated: true
          }),
          homebrewItem({
            id: "cask:visual-studio-code",
            token: "visual-studio-code",
            name: "Visual Studio Code",
            kind: "cask",
            latestVersion: version("1.100.0"),
            isOutdated: true
          }),
          homebrewItem({
            id: "cask:ignored-cask",
            token: "ignored-cask",
            name: "Ignored Cask",
            kind: "cask",
            latestVersion: version("3.0.0"),
            isOutdated: true
          })
        ]
      },
      runBrewCommand
    });

    await store.performHomebrewUpdateAll();

    expect(runBrewCommand.mock.calls.map(([command]) => command)).toEqual([
      ["update"],
      ["upgrade", "ripgrep"],
      ["upgrade", "--cask", "--greedy", "visual-studio-code"],
      ["autoremove"],
      ["cleanup"]
    ]);
    expect(store.getSnapshot().profileStats.events).toEqual([
      expect.objectContaining({
        type: "homebrewUpdate",
        targetID: "formula:ripgrep",
        displayName: "ripgrep",
        channel: "homebrew"
      }),
      expect.objectContaining({
        type: "homebrewUpdate",
        targetID: "cask:visual-studio-code",
        displayName: "Visual Studio Code",
        channel: "homebrew"
      })
    ]);
  });

  it("excludes hidden app-backed casks from batch Homebrew updates", async () => {
    const ignoredApp = appRecord({
      bundlePath: "/Applications/Managed.app",
      displayName: "Managed",
      bundleIdentifier: "com.example.managed",
      localVersion: version("1.0.0")
    });
    const runBrewCommand = vi.fn<
      NonNullable<ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"]>
    >(async () => ({
      success: true,
      status: 0,
      output: ""
    }));
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        apps: [ignoredApp],
        ignoredIDs: [ignoredApp.id],
        homebrewItems: [
          homebrewItem({
            id: "cask:managed",
            token: "managed",
            name: "Managed",
            kind: "cask",
            appID: ignoredApp.id,
            installedVersion: version("1.0.0"),
            latestVersion: version("2.0.0"),
            isOutdated: true
          }),
          homebrewItem({
            id: "formula:ripgrep",
            token: "ripgrep",
            name: "ripgrep",
            kind: "formula",
            installedVersion: version("14.0.0"),
            latestVersion: version("14.1.0"),
            isOutdated: true
          })
        ]
      },
      runBrewCommand
    });

    await store.performHomebrewUpdateAll();

    expect(runBrewCommand.mock.calls.map(([command]) => command)).toEqual([
      ["update"],
      ["upgrade", "ripgrep"],
      ["autoremove"],
      ["cleanup"]
    ]);
  });

  it("uses a caller-provided visible Homebrew batch scope", async () => {
    const app = appRecord({
      bundlePath: "/Applications/Managed.app",
      displayName: "Managed",
      bundleIdentifier: "com.example.managed",
      localVersion: version("1.0.0")
    });
    const runBrewCommand = vi.fn<
      NonNullable<ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"]>
    >(async () => ({
      success: true,
      status: 0,
      output: ""
    }));
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        apps: [app],
        updates: [
          {
            id: app.id,
            appID: app.id,
            source: "homebrew",
            supportLevel: "supported",
            localVersion: version("1.0.0"),
            remoteVersion: version("2.0.0"),
            homebrewToken: "managed-cli",
            checkedAt: "2026-04-30T12:00:00.000Z"
          }
        ],
        homebrewItems: [
          homebrewItem({
            id: "cask:managed-cli",
            token: "managed-cli",
            name: "Managed CLI",
            kind: "cask",
            installedVersion: version("1.0.0"),
            latestVersion: version("2.0.0"),
            isOutdated: true
          }),
          homebrewItem({
            id: "formula:ripgrep",
            token: "ripgrep",
            name: "ripgrep",
            kind: "formula",
            installedVersion: version("14.0.0"),
            latestVersion: version("14.1.0"),
            isOutdated: true
          }),
          homebrewItem({
            id: "formula:fd",
            token: "fd",
            name: "fd",
            kind: "formula",
            installedVersion: version("9.0.0"),
            latestVersion: version("10.0.0"),
            isOutdated: true
          })
        ]
      },
      runBrewCommand
    });

    await store.performHomebrewUpdateAll(["cask:managed-cli", "formula:ripgrep"]);

    expect(runBrewCommand.mock.calls.map(([command]) => command)).toEqual([
      ["update"],
      ["upgrade", "ripgrep"],
      ["upgrade", "--cask", "--greedy", "managed-cli"],
      ["autoremove"],
      ["cleanup"]
    ]);
  });

  it("excludes ignored app-backed casks from caller-provided Homebrew batch scopes", async () => {
    const ignoredApp = appRecord({
      bundlePath: "/Applications/Managed.app",
      displayName: "Managed",
      bundleIdentifier: "com.example.managed",
      localVersion: version("1.0.0")
    });
    const runBrewCommand = vi.fn<
      NonNullable<ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"]>
    >(async () => ({
      success: true,
      status: 0,
      output: ""
    }));
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        apps: [ignoredApp],
        ignoredIDs: [ignoredApp.id],
        homebrewItems: [
          homebrewItem({
            id: "cask:managed-cli",
            token: "managed-cli",
            name: "Managed CLI",
            kind: "cask",
            appID: ignoredApp.id,
            installedVersion: version("1.0.0"),
            latestVersion: version("2.0.0"),
            isOutdated: true
          }),
          homebrewItem({
            id: "formula:ripgrep",
            token: "ripgrep",
            name: "ripgrep",
            kind: "formula",
            installedVersion: version("14.0.0"),
            latestVersion: version("14.1.0"),
            isOutdated: true
          })
        ]
      },
      runBrewCommand
    });

    await store.performHomebrewUpdateAll(["cask:managed-cli", "formula:ripgrep"]);

    expect(runBrewCommand.mock.calls.map(([command]) => command)).toEqual([
      ["update"],
      ["upgrade", "ripgrep"],
      ["autoremove"],
      ["cleanup"]
    ]);
  });

  it("does not run Homebrew maintenance when every outdated item is ignored", async () => {
    const runBrewCommand = vi.fn<
      NonNullable<ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"]>
    >(async () => ({
      success: true,
      status: 0,
      output: ""
    }));
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        ignoredHomebrewItemIDs: ["formula:ripgrep"],
        homebrewItems: [
          homebrewItem({
            id: "formula:ripgrep",
            token: "ripgrep",
            name: "ripgrep",
            kind: "formula",
            latestVersion: version("14.1.0"),
            isOutdated: true
          })
        ]
      },
      runBrewCommand
    });

    await store.performHomebrewUpdateAll();

    expect(runBrewCommand).not.toHaveBeenCalled();
  });

  it("uses mas for App Store updates and falls back to safe external routes on failure", async () => {
    const app = appRecord({
      bundlePath: "/Applications/App Store Managed.app",
      displayName: "App Store Managed",
      bundleIdentifier: "com.example.appstore",
      localVersion: version("1.0.0")
    });
    const persisted = {
      ...defaultPersistedSnapshot(),
      apps: [app],
      updates: [
        {
          id: app.id,
          appID: app.id,
          source: "appStore" as const,
          supportLevel: "supported" as const,
          localVersion: version("1.0.0"),
          remoteVersion: version("2.0.0"),
          updateURL: "https://apps.apple.com/app/example",
          appStoreItemID: 123,
          checkedAt: "2026-05-20T12:00:00.000Z"
        }
      ]
    };
    const successfulMas = vi.fn(async () => ({ success: true, status: 0, output: "" }));
    const successfulStore = await makeStore({ persisted, runMasCommand: successfulMas });

    await successfulStore.performAppUpdate(app.id);

    expect(successfulMas).toHaveBeenCalledWith(["upgrade", "123"]);
    expect(successfulStore.getSnapshot().profileStats.events).toEqual([
      expect.objectContaining({
        type: "appUpdate",
        targetID: app.id,
        displayName: "App Store Managed",
        channel: "appStore"
      })
    ]);

    const failingMas = vi.fn(async () => ({ success: false, status: 1, output: "" }));
    const openedExternalURLs: string[] = [];
    const fallbackStore = await makeStore({
      persisted,
      runMasCommand: failingMas,
      openExternalURL: async (url) => {
        openedExternalURLs.push(url);
        return true;
      }
    });

    await fallbackStore.performAppUpdate(app.id);

    expect(failingMas).toHaveBeenCalledWith(["upgrade", "123"]);
    expect(openedExternalURLs).toEqual(["https://apps.apple.com/app/example"]);
    expect(fallbackStore.getSnapshot().profileStats.events).toEqual([]);
  });

  it("blocks unsafe external URLs before invoking the platform opener", async () => {
    const openExternalURL = vi.fn(async () => true);
    const store = await makeStore({ openExternalURL });

    await expect(store.openExternal("http://updates.example.com/download")).resolves.toBe(false);

    expect(openExternalURL).not.toHaveBeenCalled();
    expect(store.getSnapshot().refreshErrorMessage).toBe("Blocked an unsafe external link.");
  });

  it("routes Homebrew-backed app updates through validated cask upgrade commands", async () => {
    const app = appRecord({
      bundlePath: "/Applications/Homebrew Managed.app",
      displayName: "Homebrew Managed",
      bundleIdentifier: "com.example.homebrew",
      localVersion: version("1.0.0")
    });
    const runBrewCommand = vi.fn(async () => ({ success: true, status: 0, output: "" }));
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        apps: [app],
        updates: [
          {
            id: app.id,
            appID: app.id,
            source: "homebrew",
            supportLevel: "limited",
            localVersion: version("1.0.0"),
            remoteVersion: version("2.0.0"),
            homebrewToken: "homebrew-managed",
            checkedAt: "2026-05-20T12:00:00.000Z"
          }
        ],
        homebrewItems: [
          homebrewItem({
            id: "cask:homebrew-managed",
            token: "homebrew-managed",
            name: "Homebrew Managed",
            kind: "cask",
            installedVersion: version("1.0.0"),
            latestVersion: version("2.0.0"),
            isOutdated: true
          })
        ]
      },
      runBrewCommand
    });

    await store.performAppUpdate(app.id);

    expect(runBrewCommand).toHaveBeenCalledWith(
      ["upgrade", "--cask", "homebrew-managed"],
      expect.any(Function)
    );
    expect(store.getSnapshot().profileStats.events).toEqual([
      expect.objectContaining({
        type: "appUpdate",
        targetID: app.id,
        displayName: "Homebrew Managed",
        channel: "homebrew"
      })
    ]);
  });

  it("routes Homebrew-backed app updates through installed casks even when cask outdated metadata is missing", async () => {
    const app = appRecord({
      bundlePath: "/Applications/Homebrew Managed.app",
      displayName: "Homebrew Managed",
      bundleIdentifier: "com.example.homebrew",
      localVersion: version("1.0.0")
    });
    const runBrewCommand = vi.fn(async () => ({ success: true, status: 0, output: "" }));
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        apps: [app],
        updates: [
          {
            id: app.id,
            appID: app.id,
            source: "homebrew",
            supportLevel: "limited",
            localVersion: version("1.0.0"),
            remoteVersion: version("2.0.0"),
            homebrewToken: "homebrew-managed",
            updateURL: "https://formulae.brew.sh/cask/homebrew-managed",
            checkedAt: "2026-05-20T12:00:00.000Z"
          }
        ],
        homebrewItems: [
          homebrewItem({
            id: "cask:homebrew-managed",
            token: "homebrew-managed",
            name: "Homebrew Managed",
            kind: "cask",
            installedVersion: version("1.0.0"),
            isOutdated: false
          })
        ]
      },
      runBrewCommand
    });

    await store.performAppUpdate(app.id);

    expect(runBrewCommand).toHaveBeenCalledWith(
      ["upgrade", "--cask", "homebrew-managed"],
      expect.any(Function)
    );
  });

  it("uses external fallback for unmanaged Homebrew-backed app updates", async () => {
    const app = appRecord({
      bundlePath: "/Applications/Manual Homebrew Match.app",
      displayName: "Manual Homebrew Match",
      bundleIdentifier: "com.example.manual-homebrew-match",
      localVersion: version("1.0.0")
    });
    const fallbackURL = "https://formulae.brew.sh/cask/manual-homebrew-match";
    const openExternalURL = vi.fn(async () => true);
    const openAppBundle = vi.fn(async () => undefined);
    const runBrewCommand = vi.fn(async () => ({ success: true, status: 0, output: "" }));
    const store = await makeStore({
      openExternalURL,
      openAppBundle,
      runBrewCommand,
      clients: {
        scanner: { scanApplications: async () => [app] },
        homebrew: {
          fetchIndex: async () => emptyHomebrewCaskIndex,
          lookupUpdate: () => ({
            remoteVersion: version("2.0.0"),
            token: "manual-homebrew-match",
            homepageURL: fallbackURL
          }),
          searchCasks: () => []
        },
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: "formula:manual-homebrew-match",
                token: "manual-homebrew-match",
                name: "manual-homebrew-match",
                kind: "formula",
                installedVersion: version("1.0.0"),
                latestVersion: version("2.0.0"),
                isOutdated: true
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });

    await store.refresh(false);
    expect(store.getSnapshot().updates[0]).toMatchObject({
      source: "homebrew",
      homebrewToken: "manual-homebrew-match",
      updateURL: fallbackURL
    });

    await store.performAppUpdate(app.id);

    expect(runBrewCommand).not.toHaveBeenCalled();
    expect(openExternalURL).toHaveBeenCalledWith(fallbackURL);
    expect(openAppBundle).not.toHaveBeenCalled();
  });

  it("does not route stale token-only Homebrew updates through Homebrew for Sparkle-origin apps", async () => {
    const app = appRecord({
      bundlePath: "/Applications/Sparkle Managed.app",
      displayName: "Sparkle Managed",
      bundleIdentifier: "com.example.sparkle-managed",
      sparkleFeedURL: "https://updates.example.com/appcast.xml",
      sourceHint: "sparkle",
      localVersion: version("1.0.0")
    });
    const caskItem = homebrewItem({
      id: "cask:sparkle-managed",
      token: "sparkle-managed",
      name: "Sparkle Managed",
      kind: "cask",
      installedVersion: version("1.0.0"),
      latestVersion: version("2.0.0"),
      isOutdated: true
    });
    const persisted = {
      ...defaultPersistedSnapshot(),
      apps: [app],
      updates: [
        {
          id: app.id,
          appID: app.id,
          source: "homebrew" as const,
          supportLevel: "limited" as const,
          localVersion: version("1.0.0"),
          remoteVersion: version("2.0.0"),
          homebrewToken: "sparkle-managed",
          updateURL: "https://formulae.brew.sh/cask/sparkle-managed",
          checkedAt: "2026-05-20T12:00:00.000Z"
        }
      ],
      homebrewItems: [caskItem]
    };
    const runBrewCommand = vi.fn(async () => ({ success: true, status: 0, output: "" }));
    const openExternalURL = vi.fn(async () => true);
    const openAppBundle = vi.fn(async () => undefined);
    const staleFallbackStore = await makeStore({
      persisted,
      runBrewCommand,
      openExternalURL,
      openAppBundle
    });

    await staleFallbackStore.performAppUpdate(app.id);

    expect(runBrewCommand).not.toHaveBeenCalled();
    expect(openExternalURL).not.toHaveBeenCalled();
    expect(openAppBundle).toHaveBeenCalledWith(app.bundlePath);

    const linkedBrewCommand = vi.fn(async () => ({ success: true, status: 0, output: "" }));
    const linkedStore = await makeStore({
      persisted: {
        ...persisted,
        homebrewItems: [{ ...caskItem, appID: app.id }]
      },
      runBrewCommand: linkedBrewCommand
    });

    await linkedStore.performAppUpdate(app.id);

    expect(linkedBrewCommand).toHaveBeenCalledWith(
      ["upgrade", "--cask", "sparkle-managed"],
      expect.any(Function)
    );
  });

  it("derives external fallback URLs for persisted Homebrew-backed app updates without URLs", async () => {
    const app = appRecord({
      bundlePath: "/Applications/Persisted Homebrew Match.app",
      displayName: "Persisted Homebrew Match",
      bundleIdentifier: "com.example.persisted-homebrew-match",
      localVersion: version("1.0.0")
    });
    const openExternalURL = vi.fn(async () => true);
    const openAppBundle = vi.fn(async () => undefined);
    const runBrewCommand = vi.fn(async () => ({ success: true, status: 0, output: "" }));
    const store = await makeStore({
      openExternalURL,
      openAppBundle,
      runBrewCommand,
      persisted: {
        ...defaultPersistedSnapshot(),
        apps: [app],
        updates: [
          {
            id: app.id,
            appID: app.id,
            source: "homebrew",
            supportLevel: "limited",
            localVersion: version("1.0.0"),
            remoteVersion: version("2.0.0"),
            homebrewToken: "persisted-homebrew-match",
            checkedAt: "2026-05-20T12:00:00.000Z"
          }
        ]
      }
    });

    await store.performAppUpdate(app.id);

    expect(runBrewCommand).not.toHaveBeenCalled();
    expect(openExternalURL).toHaveBeenCalledWith(
      "https://formulae.brew.sh/cask/persisted-homebrew-match"
    );
    expect(openAppBundle).not.toHaveBeenCalled();
  });

  it("rejects unsafe Homebrew-backed app update tokens", async () => {
    const app = appRecord({
      bundlePath: "/Applications/Unsafe Managed.app",
      displayName: "Unsafe Managed",
      bundleIdentifier: "com.example.unsafe",
      localVersion: version("1.0.0")
    });
    const runBrewCommand = vi.fn(async () => ({ success: true, status: 0, output: "" }));
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        apps: [app],
        updates: [
          {
            id: app.id,
            appID: app.id,
            source: "homebrew",
            supportLevel: "limited",
            localVersion: version("1.0.0"),
            remoteVersion: version("2.0.0"),
            homebrewToken: "--unsafe-token",
            checkedAt: "2026-05-20T12:00:00.000Z"
          }
        ]
      },
      runBrewCommand
    });

    await store.performAppUpdate(app.id);

    expect(runBrewCommand).not.toHaveBeenCalled();
    expect(store.getSnapshot().refreshErrorMessage).toContain("Blocked unsafe Homebrew token");
  });

  it("rejects unsafe direct Homebrew update tokens", async () => {
    const runBrewCommand = vi.fn(async () => ({ success: true, status: 0, output: "" }));
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        homebrewItems: [
          homebrewItem({
            id: "cask:unsafe",
            token: "../unsafe",
            name: "Unsafe",
            kind: "cask",
            latestVersion: version("2.0.0"),
            isOutdated: true
          })
        ]
      },
      runBrewCommand
    });

    await store.performHomebrewUpdate("cask:unsafe");

    expect(runBrewCommand).not.toHaveBeenCalled();
  });

  it("rejects Homebrew uninstall for formula and unsafe cask tokens", async () => {
    const runBrewCommand = vi.fn(async () => ({ success: true, status: 0, output: "" }));
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        homebrewItems: [
          homebrewItem({
            id: "formula:ripgrep",
            token: "ripgrep",
            name: "ripgrep",
            kind: "formula"
          }),
          homebrewItem({
            id: "cask:bad",
            token: "--bad",
            name: "Bad",
            kind: "cask"
          })
        ]
      },
      runBrewCommand
    });

    await store.uninstallHomebrewItem("formula:ripgrep");
    await store.uninstallHomebrewItem("cask:bad");

    expect(runBrewCommand).not.toHaveBeenCalled();
    expect(store.getSnapshot().refreshErrorMessage).toContain("Blocked unsafe Homebrew token");
  });

  it("clears Homebrew failed marker after a successful retry", async () => {
    const itemID = "formula:libgpg-error";
    const runBrewCommand = vi.fn(
      async (_args: string[], onOutputLine: (line: string) => void = () => undefined) => {
        if (runBrewCommand.mock.calls.length === 1) {
          onOutputLine("Error: libgpg-error failed");
          return { success: false, status: 1, output: "Error: libgpg-error failed" };
        }
        onOutputLine("Pouring libgpg-error--1.61.arm64_tahoe.bottle.tar.gz");
        onOutputLine("🍺  /opt/homebrew/Cellar/libgpg-error/1.61: 50 files, 1.9MB");
        return { success: true, status: 0, output: "" };
      }
    );
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        homebrewItems: [
          homebrewItem({
            id: itemID,
            token: "libgpg-error",
            name: "libgpg-error",
            kind: "formula",
            installedVersion: version("1.60"),
            latestVersion: version("1.61"),
            isOutdated: true
          })
        ]
      },
      runBrewCommand,
      clients: {
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: itemID,
                token: "libgpg-error",
                name: "libgpg-error",
                kind: "formula",
                installedVersion: version("1.60"),
                latestVersion: version("1.61"),
                isOutdated: true
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      }
    });

    await store.performHomebrewUpdate(itemID);
    expect(store.getSnapshot().homebrewBatchFailedItemIDs).toContain(itemID);

    await store.performHomebrewUpdate(itemID);
    const snapshot = store.getSnapshot();
    expect(snapshot.homebrewBatchFailedItemIDs).not.toContain(itemID);
    expect(snapshot.refreshErrorMessage).toBeUndefined();
  });

  it("returns failed Homebrew item updates to retryable state after a short delay", async () => {
    const itemID = "formula:retryable";
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        homebrewItems: [
          homebrewItem({
            id: itemID,
            token: "retryable",
            name: "retryable",
            kind: "formula",
            installedVersion: version("1.0.0"),
            latestVersion: version("1.1.0"),
            isOutdated: true
          })
        ]
      },
      clients: {
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [
              homebrewItem({
                id: itemID,
                token: "retryable",
                name: "retryable",
                kind: "formula",
                installedVersion: version("1.0.0"),
                latestVersion: version("1.1.0"),
                isOutdated: true
              })
            ],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        }
      },
      runBrewCommand: async (_args, onOutputLine = () => undefined) => {
        onOutputLine("Pouring retryable--1.1.0.arm64_tahoe.bottle.tar.gz");
        return { success: false, status: 1, output: "Error: update failed" };
      }
    });

    vi.useFakeTimers();
    try {
      await store.performHomebrewUpdate(itemID);

      expect(store.getSnapshot().homebrewBatchFailedItemIDs).toContain(itemID);

      vi.advanceTimersByTime(3999);
      expect(store.getSnapshot().homebrewBatchFailedItemIDs).toContain(itemID);

      vi.advanceTimersByTime(1);
      expect(store.getSnapshot().homebrewBatchFailedItemIDs).not.toContain(itemID);
      expect(store.getSnapshot().homebrewBatchProgressByItemID[itemID]).toBeUndefined();
      expect(store.getSnapshot().homebrewItems.find((item) => item.id === itemID)?.isOutdated).toBe(
        true
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns failed Homebrew Discover installs to retryable state after a short delay", async () => {
    const item = {
      id: "cask:retryable-discover",
      kind: "cask" as const,
      token: "retryable-discover",
      displayName: "Retryable Discover",
      presentation: "app" as const,
      version: version("1.0.0")
    };
    const store = await makeStore({
      runBrewCommand: async (_args, onOutputLine = () => undefined) => {
        onOutputLine("Downloading retryable-discover");
        return { success: false, status: 1, output: "Error: install failed" };
      }
    });

    vi.useFakeTimers();
    try {
      await store.installHomebrewItem(item);

      expect(store.getSnapshot().homebrewDiscoverFailedItemIDs).toContain(item.id);

      vi.advanceTimersByTime(4000);
      expect(store.getSnapshot().homebrewDiscoverFailedItemIDs).not.toContain(item.id);
      expect(store.getSnapshot().homebrewDiscoverProgressByItemID[item.id]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not record profile stats when refresh detects an external app update", async () => {
    const installedApp = appRecord({
      bundlePath: "/Applications/Profiled App.app",
      displayName: "Profiled App",
      localVersion: version("1.0.0")
    });
    const refreshedApp = {
      ...installedApp,
      localVersion: version("2.0.0")
    };
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        apps: [installedApp],
        updates: [
          {
            id: installedApp.id,
            appID: installedApp.id,
            source: "sparkle",
            supportLevel: "limited",
            localVersion: version("1.0.0"),
            remoteVersion: version("2.0.0"),
            checkedAt: "2026-06-01T12:00:00.000Z"
          }
        ]
      },
      clients: {
        scanner: { scanApplications: async () => [refreshedApp] }
      }
    });

    await store.refresh(false);
    await store.refresh(false);

    expect(store.getSnapshot().profileStats.events).toEqual([]);
  });

  it("records profile stats for successful Homebrew Discover installs", async () => {
    const store = await makeStore();

    await store.installHomebrewItem({
      id: "formula:bat",
      kind: "formula",
      token: "bat",
      displayName: "bat",
      version: version("1.0.0")
    });

    expect(store.getSnapshot().profileStats.events).toEqual([
      expect.objectContaining({
        type: "homebrewInstall",
        targetID: "formula:bat",
        displayName: "bat",
        channel: "homebrew"
      })
    ]);
  });

  it("preserves profile stats from concurrent successful actions", async () => {
    let resolveFirstSeal: (() => void) | undefined;
    let resolveFirstSealStarted: (() => void) | undefined;
    const firstSealStarted = new Promise<void>((resolve) => {
      resolveFirstSealStarted = resolve;
    });
    let sealCount = 0;
    const profileStatsIntegrity = {
      verifyOrInitialize: vi.fn(async (stats) => ({
        ...stats,
        integrityStatus: "verified" as const
      })),
      seal: vi.fn(async (stats: ProfileStats) => {
        sealCount += 1;
        if (sealCount === 1) {
          resolveFirstSealStarted?.();
          await new Promise<void>((resolve) => {
            resolveFirstSeal = resolve;
          });
        }
        return { ...stats, signature: `sealed-${sealCount}` };
      })
    };
    const store = await makeStore({ profileStatsIntegrity });

    const firstInstall = store.installHomebrewItem({
      id: "formula:bat",
      kind: "formula",
      token: "bat",
      displayName: "bat",
      version: version("1.0.0")
    });
    await firstSealStarted;

    const secondInstall = store.installHomebrewItem({
      id: "formula:fd",
      kind: "formula",
      token: "fd",
      displayName: "fd",
      version: version("1.0.0")
    });
    await Promise.resolve();
    expect(profileStatsIntegrity.seal).toHaveBeenCalledTimes(1);

    resolveFirstSeal?.();
    await Promise.all([firstInstall, secondInstall]);

    expect(
      store.getSnapshot().profileStats.events.map((event) => ({
        type: event.type,
        targetID: event.targetID,
        displayName: event.displayName
      }))
    ).toEqual([
      { type: "homebrewInstall", targetID: "formula:fd", displayName: "fd" },
      { type: "homebrewInstall", targetID: "formula:bat", displayName: "bat" }
    ]);
  });

  it("does not persist unsigned profile stats events when sealing is unavailable", async () => {
    const profileStatsIntegrity = {
      verifyOrInitialize: vi.fn(async (stats) => ({
        ...stats,
        integrityStatus: "verified" as const
      })),
      seal: vi.fn(async (stats) => ({ ...stats, integrityStatus: "unavailable" as const }))
    };
    const store = await makeStore({ profileStatsIntegrity });

    await store.installHomebrewItem({
      id: "formula:bat",
      kind: "formula",
      token: "bat",
      displayName: "bat",
      version: version("1.0.0")
    });

    expect(store.getSnapshot().profileStats.integrityStatus).toBe("unavailable");
    expect(store.getSnapshot().profileStats.events).toEqual([]);
  });

  it("does not seal populated unsigned profile stats history after a successful action", async () => {
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        profileStats: {
          ...defaultPersistedSnapshot().profileStats,
          signature: undefined,
          integrityStatus: "unavailable",
          events: [
            {
              id: "appUpdate:edited",
              type: "appUpdate",
              targetID: "app:edited",
              displayName: "Edited",
              channel: "appStore",
              occurredAt: "2026-06-01T12:00:00.000Z"
            }
          ]
        }
      }
    });

    await store.installHomebrewItem({
      id: "formula:bat",
      kind: "formula",
      token: "bat",
      displayName: "bat",
      version: version("1.0.0")
    });

    expect(store.getSnapshot().profileStats.integrityStatus).toBe("resetAfterTamper");
    expect(store.getSnapshot().profileStats.events).toEqual([
      expect.objectContaining({
        type: "homebrewInstall",
        targetID: "formula:bat",
        displayName: "bat",
        channel: "homebrew"
      })
    ]);
  });

  it("preserves profile stats events recorded while launch verification is pending", async () => {
    let resolveVerification: (() => void) | undefined;
    const profileStatsIntegrity = {
      verifyOrInitialize: vi.fn(
        async (stats) =>
          new Promise<ProfileStats>((resolve) => {
            resolveVerification = () =>
              resolve({
                ...stats,
                integrityStatus: "verified" as const,
                signature: "initial-sealed"
              });
          })
      ),
      seal: vi.fn(async (stats) => ({
        ...stats,
        integrityStatus: stats.integrityStatus,
        signature: "sealed"
      }))
    };
    const store = await makeStore({ profileStatsIntegrity });

    const verificationTask = store.verifyProfileStatsIntegrity();
    await Promise.resolve();
    const installTask = store.installHomebrewItem({
      id: "formula:bat",
      kind: "formula",
      token: "bat",
      displayName: "bat",
      version: version("1.0.0")
    });
    await Promise.resolve();
    resolveVerification?.();
    await Promise.all([verificationTask, installTask]);

    expect(store.getSnapshot().profileStats.events).toEqual([
      expect.objectContaining({
        type: "homebrewInstall",
        targetID: "formula:bat",
        displayName: "bat",
        channel: "homebrew"
      })
    ]);
  });

  it("resets profile stats when the local integrity seal fails", async () => {
    const profileStatsIntegrity = {
      verifyOrInitialize: vi.fn(async () => ({
        ...defaultPersistedSnapshot().profileStats,
        createdAt: "2026-06-05T12:00:00.000Z",
        integrityStatus: "resetAfterTamper" as const,
        signature: "sealed"
      })),
      seal: vi.fn(async (stats) => ({ ...stats, signature: "sealed" }))
    };
    const store = await makeStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        profileStats: {
          createdAt: "2026-06-01T12:00:00.000Z",
          startedUsingAt: "2026-05-15T12:00:00.000Z",
          signatureVersion: profileStatsSignatureVersion,
          integrityStatus: "pending",
          signature: "edited",
          events: [
            {
              id: "appUpdate:edited",
              type: "appUpdate",
              targetID: "app:edited",
              displayName: "Edited",
              channel: "appStore",
              occurredAt: "2026-06-02T12:00:00.000Z"
            }
          ]
        }
      },
      profileStatsIntegrity
    });

    await store.verifyProfileStatsIntegrity();

    expect(store.getSnapshot().profileStats.events).toEqual([]);
    expect(store.getSnapshot().profileStats.integrityStatus).toBe("resetAfterTamper");
  });

  it("does not run Discover installs when Homebrew is unavailable", async () => {
    const item = {
      id: "cask:missing-brew-discover",
      kind: "cask" as const,
      token: "missing-brew-discover",
      displayName: "Missing Brew Discover",
      presentation: "app" as const,
      version: version("1.0.0")
    };
    const runBrewCommand = vi.fn(async () => ({ success: false, status: null, output: "" }));
    const store = await makeStore({ runBrewCommand });

    await store.refreshToolStatus();
    await store.installHomebrewItem(item);

    const snapshot = store.getSnapshot();
    expect(runBrewCommand).toHaveBeenCalledTimes(2);
    expect(runBrewCommand).toHaveBeenNthCalledWith(1, ["--version"]);
    expect(runBrewCommand).toHaveBeenNthCalledWith(2, ["--version"]);
    expect(snapshot.isHomebrewInstalled).toBe(false);
    expect(snapshot.homebrewDiscoverInstallingItemIDs).not.toContain(item.id);
    expect(snapshot.homebrewDiscoverFailedItemIDs).not.toContain(item.id);
    expect(snapshot.refreshErrorMessage).toBe(
      "Homebrew is not installed. Install Homebrew to install Discover items."
    );
  });
});

async function makeStore({
  persisted = defaultPersistedSnapshot(),
  clients = {},
  runBrewCommand = async () => ({ success: true, status: 0, output: "" }),
  runMasCommand = async () => ({ success: true, status: 0, output: "" }),
  openExternalURL = async () => true,
  openAppBundle = async () => undefined,
  profileStatsIntegrity = {
    verifyOrInitialize: async (stats) => ({ ...stats, integrityStatus: "verified" as const }),
    seal: async (stats) => ({ ...stats, signature: "sealed" })
  },
  currentAppVersion,
  successRefreshDelayMS = 0,
  onUserData
}: {
  persisted?: PersistedSnapshot;
  clients?: Partial<ConstructorParameters<typeof UpdateStore>[0]["clients"]>;
  runBrewCommand?: ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"];
  runMasCommand?: ConstructorParameters<typeof UpdateStore>[0]["runMasCommand"];
  openExternalURL?: ConstructorParameters<typeof UpdateStore>[0]["openExternalURL"];
  openAppBundle?: ConstructorParameters<typeof UpdateStore>[0]["openAppBundle"];
  profileStatsIntegrity?: ConstructorParameters<typeof UpdateStore>[0]["profileStatsIntegrity"];
  currentAppVersion?: ConstructorParameters<typeof UpdateStore>[0]["currentAppVersion"];
  successRefreshDelayMS?: ConstructorParameters<typeof UpdateStore>[0]["successRefreshDelayMS"];
  onUserData?: (directory: string) => void;
} = {}): Promise<UpdateStore> {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-update-store-"));
  tempDirs.push(userData);
  onUserData?.(userData);
  return new UpdateStore({
    persistence: new SnapshotPersistence(userData),
    persisted,
    openExternalURL,
    openAppBundle,
    profileStatsIntegrity,
    currentAppVersion,
    runBrewCommand,
    runMasCommand,
    successRefreshDelayMS,
    clients: {
      scanner: { scanApplications: async () => [] },
      appStore: { lookupOutcome: async () => ({ type: "completed" }) },
      sparkle: { lookupOutcome: async () => ({ type: "completed" }) },
      homebrew: {
        fetchIndex: async () => emptyHomebrewCaskIndex,
        lookupUpdate: () => undefined,
        searchCasks: () => []
      },
      homebrewFormula: {
        fetchIndex: async () => emptyHomebrewFormulaIndex,
        searchFormulae: () => []
      },
      homebrewInventory: {
        fetchInventory: async () => ({
          items: [],
          outdatedDetectionSucceeded: true,
          outdatedDetectionSucceededByKind: { formula: true, cask: true }
        })
      },
      selfUpdate: {
        lookup: async (currentVersion, checkedAt) => ({
          available: false,
          currentVersion,
          releaseURL: "https://github.com/arshiaghaf/Baseline/releases/latest",
          checkedAt
        })
      },
      ...clients
    }
  });
}
