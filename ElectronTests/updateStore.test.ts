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
      bundleIdentifiers: ["com.example.pkgbacked"],
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
      bundleIdentifiers: [],
      inferredBundleIdentifiers: ["com.example.pkgbacked.helper"],
      appBundleNames: ["package backed.app"]
    };
    const store = await makeStore({
      clients: {
        scanner: { scanApplications: async () => [packageBackedApp] },
        homebrew: {
          fetchIndex: async () => ({
            byToken: { "pkg-backed-app": entry },
            byBundleIdentifier: { "com.example.pkgbacked.helper": entry },
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
      iconDataURL: "data:image/png;base64,icon"
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
      iconDataURL: "data:image/png;base64,icon"
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
  runMasCommand = async () => ({ success: true, status: 0, output: "" })
}: {
  persisted?: PersistedSnapshot;
  clients?: Partial<ConstructorParameters<typeof UpdateStore>[0]["clients"]>;
  runBrewCommand?: ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"];
  runMasCommand?: ConstructorParameters<typeof UpdateStore>[0]["runMasCommand"];
} = {}): Promise<UpdateStore> {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-update-store-"));
  tempDirs.push(userData);
  return new UpdateStore({
    persistence: new SnapshotPersistence(userData),
    persisted,
    openExternalURL: async () => true,
    openAppBundle: async () => undefined,
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
