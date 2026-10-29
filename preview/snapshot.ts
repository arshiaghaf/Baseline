// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { defaultPersistedSnapshot, type BaselineSnapshot } from "../src/shared/domain";
import { version } from "../src/shared/version";
import { fetchReleaseNotes } from "../src/main/releaseNotesFetch";
import { SparkleAppcastClient } from "../src/main/sparkleAppcastClient";

/** These are labelled sample installations, not a scan of this computer. */
export function previewSnapshot(input: Partial<BaselineSnapshot> = {}): BaselineSnapshot {
  return {
    ...defaultPersistedSnapshot(),
    isMasInstalled: false,
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
    homebrewDiscoverItems: [],
    homebrewDiscoverInstallingItemIDs: [],
    homebrewDiscoverInstalledPendingRefreshItemIDs: [],
    homebrewDiscoverFailedItemIDs: [],
    homebrewDiscoverProgressByItemID: {},
    laggingHomebrewCaskTokens: [],
    defaultScanDirectories: [],
    ...input,
    updateIntroductionDismissed: true,
    autoRefreshEnabled: false,
    showMenuBarIcon: false,
    showDockIcon: false,
    profileStats: { ...defaultPersistedSnapshot().profileStats, integrityStatus: "verified" }
  };
}

export async function publishedSampleSnapshot(): Promise<BaselineSnapshot> {
  const result = previewSnapshot();
  const failed: string[] = [];
  const now = new Date().toISOString();
  await Promise.all([
    (async () => {
      try {
        const response = await fetchReleaseNotes(
          "https://itunes.apple.com/lookup?id=497799835&entity=macSoftware&country=us"
        );
        if (response.status !== 200) throw new Error("Lookup unavailable");
        const entry = JSON.parse(response.data.toString("utf8")).results?.[0];
        if (
          !entry ||
          typeof entry.version !== "string" ||
          typeof entry.bundleId !== "string" ||
          typeof entry.releaseNotes !== "string"
        )
          throw new Error("No published notes");
        const id = "app:preview-store";
        result.apps.push({
          id,
          bundlePath: "/Sample Inventory/Store Example.app",
          displayName: `${String(entry.trackName ?? "App Store")} · App Store example`,
          bundleIdentifier: entry.bundleId,
          localVersion: version("0.0.0"),
          sourceHint: "appStore",
          hasAppStoreEvidence: true
        });
        result.updates.push({
          id,
          appID: id,
          source: "appStore",
          supportLevel: "supported",
          localVersion: version("0.0.0"),
          remoteVersion: version(entry.version),
          releaseNotesSummary: entry.releaseNotes,
          releaseDate: entry.currentVersionReleaseDate,
          updateURL: entry.trackViewUrl,
          appStoreItemID: entry.trackId,
          checkedAt: now
        });
      } catch {
        failed.push("App Store");
      }
    })(),
    (async () => {
      try {
        const feed = "https://iterm2.com/appcasts/final.xml";
        const outcome = await new SparkleAppcastClient().lookupOutcome(feed, version("0.0.0"));
        if (outcome.type !== "completed" || !outcome.value) throw new Error("Feed unavailable");
        const id = "app:preview-sparkle";
        result.apps.push({
          id,
          bundlePath: "/Sample Inventory/Sparkle Example.app",
          displayName: "iTerm2 · Sparkle example",
          bundleIdentifier: "com.googlecode.iterm2",
          localVersion: version("0.0.0"),
          sparkleFeedURL: feed,
          sourceHint: "sparkle"
        });
        result.updates.push({
          id,
          appID: id,
          source: "sparkle",
          supportLevel: "supported",
          localVersion: version("0.0.0"),
          ...outcome.value,
          checkedAt: now
        });
      } catch {
        failed.push("Sparkle");
      }
    })(),
    (async () => {
      try {
        const response = await fetchReleaseNotes("https://formulae.brew.sh/api/formula/gh.json");
        if (response.status !== 200) throw new Error("Catalogue unavailable");
        const entry = JSON.parse(response.data.toString("utf8"));
        if (entry.name !== "gh" || typeof entry.versions?.stable !== "string")
          throw new Error("Invalid catalogue identity");
        const target = entry.versions.stable + (entry.revision ? `_${entry.revision}` : "");
        result.homebrewItems.push({
          id: "formula:gh",
          token: "gh",
          name: "GitHub CLI · GitHub example",
          kind: "formula",
          installedVersion: version("0.0.0"),
          latestVersion: version(target),
          isOutdated: true,
          formulaIdentity: { name: "gh", fullName: "gh", tap: "homebrew/core", oldNames: [] },
          formulaIdentityVerified: true
        });
      } catch {
        failed.push("Homebrew catalogue");
      }
    })()
  ]);
  result.homebrewItems.push({
    id: "formula:unavailable-example",
    token: "unavailable-example",
    name: "Unavailable source example",
    kind: "formula",
    installedVersion: version("1.0"),
    latestVersion: version("2.0"),
    isOutdated: true,
    formulaIdentity: {
      name: "unavailable-example",
      fullName: "preview/examples/unavailable-example",
      tap: "preview/examples",
      oldNames: []
    },
    formulaIdentityVerified: true
  });
  result.lastRefreshNoticeMessage = failed.length
    ? `Sample sources unavailable: ${failed.join(", ")}. Retry the preview later or provide a saved sample snapshot.`
    : undefined;
  result.lastRefreshDate = now;
  return result;
}
