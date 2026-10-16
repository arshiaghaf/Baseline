// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { defaultPersistedSnapshot, type BaselineSnapshot } from "../src/shared/domain";
import { version } from "../src/shared/version";

export const visualTime = "2026-10-16T12:00:00.000Z";

export function visualSnapshot(): BaselineSnapshot {
  return {
    ...defaultPersistedSnapshot(visualTime),
    autoRefreshEnabled: false,
    lastRefreshDate: "2026-10-16T11:45:00.000Z",
    apps: [
      {
        id: "atlas",
        bundlePath: "/Applications/Atlas.app",
        displayName: "Atlas",
        localVersion: version("1.2.0"),
        sourceHint: "appStore"
      },
      {
        id: "beacon",
        bundlePath: "/Applications/Beacon.app",
        displayName: "Beacon",
        localVersion: version("3.0"),
        sourceHint: "sparkle"
      },
      {
        id: "canvas",
        bundlePath: "/Applications/Canvas.app",
        displayName: "Canvas",
        localVersion: version("4.1"),
        sourceHint: "web"
      },
      {
        id: "dusk",
        bundlePath: "/Applications/Dusk.app",
        displayName: "Dusk",
        localVersion: version("2.0"),
        sourceHint: "unknown"
      }
    ],
    updates: [
      {
        id: "atlas",
        appID: "atlas",
        source: "appStore",
        supportLevel: "supported",
        localVersion: version("1.2.0"),
        remoteVersion: version("1.3.0"),
        appStoreItemID: 123,
        checkedAt: visualTime
      },
      {
        id: "beacon",
        appID: "beacon",
        source: "sparkle",
        supportLevel: "supported",
        localVersion: version("3.0"),
        remoteVersion: version("3.2"),
        updateURL: "https://example.com/beacon",
        checkedAt: visualTime
      }
    ],
    recentlyUpdated: [
      {
        id: "canvas-recent",
        appID: "canvas",
        displayName: "Canvas",
        source: "web",
        fromVersion: version("4.0"),
        toVersion: version("4.1"),
        updatedAt: "2026-10-16T11:00:00.000Z"
      }
    ],
    ignoredIDs: ["dusk"],
    homebrewItems: [
      {
        id: "formula:birch",
        token: "birch",
        name: "Birch",
        kind: "formula",
        installedVersion: version("1.0"),
        latestVersion: version("1.1"),
        isOutdated: true
      },
      {
        id: "cask:cedar",
        token: "cedar",
        name: "Cedar",
        kind: "cask",
        presentation: "package",
        installedVersion: version("2.0"),
        latestVersion: version("2.1"),
        isOutdated: true,
        releaseDate: visualTime
      },
      {
        id: "formula:elm",
        token: "elm",
        name: "Elm",
        kind: "formula",
        installedVersion: version("3.0"),
        latestVersion: version("3.1"),
        isOutdated: true,
        pinned: true
      },
      {
        id: "cask:fern",
        token: "fern",
        name: "Fern",
        kind: "cask",
        presentation: "cli",
        installedVersion: version("1.0"),
        isOutdated: false
      }
    ],
    ignoredHomebrewItemIDs: ["cask:fern"],
    homebrewDiscoverItems: [
      {
        id: "cask:grove",
        token: "grove",
        displayName: "Grove",
        kind: "cask",
        presentation: "app",
        version: version("5.0"),
        homepageURL: "https://example.com/grove"
      }
    ],
    additionalDirectories: ["/Example/Applications"],
    defaultScanDirectories: ["/Applications", "/Example/Default Applications"],
    profileStats: {
      ...defaultPersistedSnapshot("2026-09-01T12:00:00.000Z").profileStats,
      integrityStatus: "verified",
      events: [
        {
          id: "canvas-event",
          type: "appUpdate",
          targetID: "canvas",
          displayName: "Canvas",
          channel: "web",
          occurredAt: "2026-10-16T11:00:00.000Z"
        }
      ]
    },
    operationFailures: [
      {
        id: "update:atlas",
        entityID: "atlas",
        operation: "update",
        reason: "network",
        status: 1,
        occurredAt: "2026-10-16T11:30:00.000Z"
      }
    ],
    operationFailureDetails: {
      "update:atlas": {
        attemptID: "visual-attempt",
        outputTail: "Download failed: connection timed out.\nNo files were changed."
      }
    },
    isMasInstalled: true,
    isHomebrewInstalled: true,
    isChecking: false,
    isRefreshing: false,
    searchText: "",
    isRunningHomebrewMaintenance: false,
    isHomebrewCommandLocked: false,
    isHomebrewCleanupLocked: false,
    isCleaningUpHomebrew: false,
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
    homebrewDiscoverInstallingItemIDs: [],
    homebrewDiscoverInstalledPendingRefreshItemIDs: [],
    homebrewDiscoverFailedItemIDs: [],
    homebrewDiscoverProgressByItemID: {},
    laggingHomebrewCaskTokens: [],
    snapshotRevision: 1
  };
}
