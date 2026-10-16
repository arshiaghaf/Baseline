// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import path from "node:path";
import type {
  AppRecord,
  HomebrewCaskIndex,
  HomebrewManagedItem,
  RecentlyUpdatedRecord,
  UpdateRecord
} from "../shared/domain";
import { isValidHomebrewToken } from "../shared/security";
import { compareVersions, isVersionGreater, version } from "../shared/version";
import { isSparkleVersionNewer, sparkleMarketingVersion } from "../shared/sparkleVersion";
import type { AppStoreLookupClient } from "./appStoreLookupClient";
import type { SparkleAppcastClient } from "./sparkleAppcastClient";
import type { HomebrewCaskClient } from "./homebrewCaskClient";

type LookupClients = {
  appStore: Pick<AppStoreLookupClient, "lookupOutcome">;
  sparkle: Pick<SparkleAppcastClient, "lookupOutcome">;
  homebrew: Pick<HomebrewCaskClient, "lookupUpdate">;
};

type LookupInput = {
  apps: AppRecord[];
  previousUpdates: Map<string, UpdateRecord>;
  homebrewItems: HomebrewManagedItem[];
  homebrewIndex: HomebrewCaskIndex;
  now: string;
  force: boolean;
  signal: AbortSignal;
  isCurrent: () => boolean;
  isSelfApp: (app: AppRecord) => boolean;
  canUseHomebrewAppUpdate: (
    app: AppRecord,
    token: string,
    items: HomebrewManagedItem[],
    index: HomebrewCaskIndex
  ) => boolean;
};

/** Returns undefined when a superseded generation must not commit its partial results. */
export async function lookupAppUpdates(
  clients: LookupClients,
  input: LookupInput
): Promise<UpdateRecord[] | undefined> {
  const updates: UpdateRecord[] = [];
  const {
    apps,
    previousUpdates,
    homebrewItems,
    homebrewIndex,
    now,
    force,
    signal,
    isCurrent,
    isSelfApp,
    canUseHomebrewAppUpdate
  } = input;
  for (const appRecord of apps) {
    if (isSelfApp(appRecord)) continue;
    if (signal.aborted || !isCurrent()) return undefined;
    if (appRecord.bundleIdentifier) {
      const outcome = await clients.appStore.lookupOutcome(
        appRecord.bundleIdentifier,
        appRecord.localVersion,
        {
          signal,
          force,
          includeIOSAppStoreSoftware:
            appRecord.isIOSAppOnMac === true && appRecord.hasAppStoreEvidence === true,
          includeMacCapableAppStoreSoftware:
            appRecord.isIOSAppOnMac !== true && appRecord.hasSafariWebExtension === true
        }
      );
      if (signal.aborted || !isCurrent()) return undefined;
      if (outcome.type === "completed" && outcome.value) {
        updates.push({
          id: appRecord.id,
          appID: appRecord.id,
          source: "appStore",
          supportLevel: "supported",
          localVersion: appRecord.localVersion,
          remoteVersion: outcome.value.remoteVersion,
          updateURL: outcome.value.updateURL,
          appStoreItemID: outcome.value.appStoreItemID,
          releaseNotesSummary: outcome.value.releaseNotesSummary,
          releaseDate: outcome.value.releaseDate,
          checkedAt: outcome.checkedAt ?? now
        });
        continue;
      }
      if (outcome.type === "transientFailure") {
        const previousUpdate = previousAppUpdateForTransientLookup(
          previousUpdates,
          appRecord,
          "appStore"
        );
        if (previousUpdate) {
          updates.push(previousUpdate);
          continue;
        }
      }
    }

    if (appRecord.sparkleFeedURL) {
      const outcome = await clients.sparkle.lookupOutcome(
        appRecord.sparkleFeedURL,
        appRecord.localVersion,
        appRecord.bundleVersion,
        { signal, force }
      );
      if (signal.aborted || !isCurrent()) return undefined;
      if (outcome.type === "completed" && outcome.value) {
        updates.push({
          id: appRecord.id,
          appID: appRecord.id,
          source: "sparkle",
          supportLevel: "limited",
          localVersion: appRecord.localVersion,
          remoteVersion: outcome.value.remoteVersion,
          localBuildVersion: appRecord.bundleVersion,
          remoteBuildVersion: outcome.value.remoteBuildVersion,
          sparkleVersionComparison: outcome.value.versionComparison,
          updateURL: outcome.value.updateURL,
          releaseNotesURL: outcome.value.releaseNotesURL,
          releaseDate: outcome.value.releaseDate,
          checkedAt: outcome.checkedAt ?? now
        });
        continue;
      }
      if (outcome.type === "transientFailure") {
        const previousUpdate = previousAppUpdateForTransientLookup(
          previousUpdates,
          appRecord,
          "sparkle"
        );
        if (previousUpdate) {
          updates.push(previousUpdate);
          continue;
        }
      }
    }

    const homebrewUpdate = clients.homebrew.lookupUpdate(
      appRecord.bundleIdentifier,
      path.basename(appRecord.bundlePath),
      appRecord.localVersion,
      homebrewIndex
    );
    if (homebrewUpdate && isValidHomebrewToken(homebrewUpdate.token)) {
      if (canUseHomebrewAppUpdate(appRecord, homebrewUpdate.token, homebrewItems, homebrewIndex)) {
        updates.push({
          id: appRecord.id,
          appID: appRecord.id,
          source: "homebrew",
          supportLevel: "limited",
          localVersion: appRecord.localVersion,
          remoteVersion: homebrewUpdate.remoteVersion,
          homebrewToken: homebrewUpdate.token,
          updateURL: homebrewUpdate.homepageURL,
          releaseNotesSummary: `Token: ${homebrewUpdate.token}`,
          checkedAt: now
        });
      }
    }
  }
  return updates;
}

type AppLookupSource = Extract<UpdateRecord["source"], "appStore" | "sparkle">;

function previousAppUpdateForTransientLookup(
  previousUpdates: Map<string, UpdateRecord>,
  appRecord: AppRecord,
  source: AppLookupSource
): UpdateRecord | undefined {
  const previousUpdate = previousUpdates.get(appRecord.id);
  if (!previousUpdate || previousUpdate.source !== source) return undefined;
  if (previousUpdate.appID !== appRecord.id) return undefined;
  if (compareVersions(previousUpdate.localVersion, appRecord.localVersion) !== 0) return undefined;
  if (
    previousUpdate.localBuildVersion &&
    (!appRecord.bundleVersion ||
      compareVersions(previousUpdate.localBuildVersion, appRecord.bundleVersion) !== 0)
  )
    return undefined;
  return isAppUpdateNewerThanInstalledApp(previousUpdate, appRecord) ? previousUpdate : undefined;
}

export function isAppUpdateNewerThanInstalledApp(
  update: UpdateRecord,
  appRecord: AppRecord
): boolean {
  if (update.source === "sparkle") {
    const candidate = {
      parsedVersion: sparkleMarketingVersion(update.remoteVersion, update.remoteBuildVersion),
      buildVersion: update.remoteBuildVersion ?? version(),
      hasMarketingVersion: update.sparkleVersionComparison !== "build"
    };
    const localVersion = sparkleMarketingVersion(appRecord.localVersion, appRecord.bundleVersion);
    if (isSparkleVersionNewer(candidate, localVersion, appRecord.bundleVersion)) return true;
    // Legacy records did not preserve the feed's comparison domain.
    return (
      update.sparkleVersionComparison === undefined &&
      update.remoteBuildVersion !== undefined &&
      compareVersions(update.remoteVersion, update.remoteBuildVersion) === 0 &&
      isSparkleVersionNewer(
        { ...candidate, hasMarketingVersion: false },
        localVersion,
        appRecord.bundleVersion
      )
    );
  }
  const versionComparison = compareVersions(update.remoteVersion, appRecord.localVersion);
  if (versionComparison > 0) return true;
  if (versionComparison < 0) return false;
  if (!update.remoteBuildVersion || !update.localBuildVersion || !appRecord.bundleVersion)
    return false;
  return (
    compareVersions(update.localBuildVersion, appRecord.bundleVersion) === 0 &&
    isVersionGreater(update.remoteBuildVersion, appRecord.bundleVersion)
  );
}

export function mergeRecentlyUpdated(
  previousRecords: RecentlyUpdatedRecord[],
  apps: AppRecord[],
  updates: UpdateRecord[],
  previousUpdates: Map<string, UpdateRecord>,
  now: string
) {
  const currentUpdateIDs = new Set(updates.map((update) => update.appID));
  const appByID = new Map(apps.map((app) => [app.id, app]));
  const records = [...previousRecords];
  for (const [appID, previousUpdate] of previousUpdates.entries()) {
    if (currentUpdateIDs.has(appID)) {
      continue;
    }
    const appRecord = appByID.get(appID);
    if (!appRecord) {
      continue;
    }
    if (!hasInstalledAppAdvanced(appRecord, previousUpdate)) {
      continue;
    }
    records.unshift({
      id: appID,
      appID,
      displayName: appRecord.displayName,
      source: previousUpdate.source,
      fromVersion: previousUpdate.localVersion,
      toVersion: appRecord.localVersion,
      fromBuildVersion: previousUpdate.localBuildVersion,
      toBuildVersion: previousUpdate.localBuildVersion ? appRecord.bundleVersion : undefined,
      updatedAt: now
    });
  }
  const retentionMs = 14 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  const deduped = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    if (new Date(record.updatedAt).getTime() >= cutoff && !deduped.has(record.appID)) {
      deduped.set(record.appID, record);
    }
  }
  return [...deduped.values()].slice(0, 40);
}

function hasInstalledAppAdvanced(appRecord: AppRecord, previousUpdate: UpdateRecord): boolean {
  if (isVersionGreater(appRecord.localVersion, previousUpdate.localVersion)) {
    return true;
  }
  if (!previousUpdate.localBuildVersion || !appRecord.bundleVersion) {
    return false;
  }
  return isVersionGreater(appRecord.bundleVersion, previousUpdate.localBuildVersion);
}
