// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  defaultPersistedSnapshot
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
  PersistedSnapshot
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
});

async function makeStore({
  persisted = defaultPersistedSnapshot(),
  clients = {},
  runBrewCommand = async () => ({ success: true, status: 0, output: "" }),
  runMasCommand = async () => ({ success: true, status: 0, output: "" }),
  openExternalURL = async () => true,
  openAppBundle = async () => undefined,
  onUserData
}: {
  persisted?: PersistedSnapshot;
  clients?: Partial<ConstructorParameters<typeof UpdateStore>[0]["clients"]>;
  runBrewCommand?: ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"];
  runMasCommand?: ConstructorParameters<typeof UpdateStore>[0]["runMasCommand"];
  openExternalURL?: ConstructorParameters<typeof UpdateStore>[0]["openExternalURL"];
  openAppBundle?: ConstructorParameters<typeof UpdateStore>[0]["openAppBundle"];
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
    runBrewCommand,
    runMasCommand,
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
      ...clients
    }
  });
}
