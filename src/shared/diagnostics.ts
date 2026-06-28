// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import type { BaselineSnapshot, UpdateSource } from "./domain";
import { sourceDisplayName } from "./domain";
import { formatAppDisplayVersion, type AppMetadata } from "./appMetadata";

export function renderDiagnostics(
  snapshot: BaselineSnapshot,
  appMetadata: Pick<AppMetadata, "version" | "buildNumber"> | string = "Unknown",
  platform = process.platform
): string {
  const updateSourceCounts = sourceCounts(snapshot.updates.map((update) => update.source));
  const appHintCounts = sourceCounts(snapshot.apps.map((app) => app.sourceHint));
  const homebrewFormulas = snapshot.homebrewItems.filter((item) => item.kind === "formula");
  const homebrewCasks = snapshot.homebrewItems.filter((item) => item.kind === "cask");
  const appLinkedCasks = homebrewCasks.filter((item) => Boolean(item.appID));
  const homebrewAppUpdates = snapshot.updates.filter((update) => update.source === "homebrew");
  const homebrewAppUpdatesWithInstalledCask = homebrewAppUpdates.filter((update) =>
    snapshot.homebrewItems.some(
      (item) =>
        item.kind === "cask" &&
        item.appID === update.appID &&
        (!update.homebrewToken || item.token.toLowerCase() === update.homebrewToken.toLowerCase())
    )
  );
  const publisherUpdaterApps = snapshot.apps.filter((app) => Boolean(app.sparkleFeedURL));
  const directDownloadCandidates = snapshot.apps.filter(
    (app) =>
      app.sourceHint === "unknown" &&
      !app.sparkleFeedURL &&
      app.hasAppStoreEvidence !== true &&
      !snapshot.homebrewItems.some((item) => item.kind === "cask" && item.appID === app.id)
  );

  const safeLastMessage = (snapshot.refreshErrorMessage ?? snapshot.lastRefreshNoticeMessage)
    ?.split(/\r?\n/u)[0]
    ?.trim();

  const lines = [
    "Baseline Diagnostics",
    `Generated: ${new Date().toISOString()}`,
    `Platform: ${platform}`,
    `App version: ${diagnosticsAppVersion(appMetadata)}`,
    "",
    "Refresh",
    `- Last refresh: ${snapshot.lastRefreshDate ?? "Never"}`,
    `- Refreshing: ${yesNo(snapshot.isRefreshing)}`,
    `- Auto refresh: ${yesNo(snapshot.autoRefreshEnabled)}`,
    `- Refresh interval: ${snapshot.refreshIntervalMinutes} minutes`,
    `- Appearance: ${appearanceLabel(snapshot.appearancePreference)}`
  ];

  if (safeLastMessage) {
    lines.push(`- Last message: ${safeLastMessage}`);
  }

  lines.push(
    "",
    "Apps",
    `- Scanned apps: ${snapshot.apps.length}`,
    `- Available updates: ${snapshot.updates.length}`,
    `- Ignored: ${snapshot.ignoredIDs.length}`,
    `- Source hints: ${formatSourceCounts(appHintCounts)}`,
    `- Update sources: ${formatSourceCounts(updateSourceCounts)}`,
    `- Apps with publisher updater feed: ${publisherUpdaterApps.length}`,
    `- Direct-download candidates without known feed: ${directDownloadCandidates.length}`,
    `- Homebrew app updates with installed cask link: ${homebrewAppUpdatesWithInstalledCask.length}`,
    `- Homebrew app updates without installed cask link: ${
      homebrewAppUpdates.length - homebrewAppUpdatesWithInstalledCask.length
    }`,
    "",
    "Homebrew",
    `- Homebrew detected: ${yesNo(snapshot.isHomebrewInstalled)}`,
    `- Items: ${snapshot.homebrewItems.length}`,
    `- Formulae: ${homebrewFormulas.length}`,
    `- Casks: ${homebrewCasks.length}`,
    `- App-linked casks: ${appLinkedCasks.length}`,
    `- Outdated: ${snapshot.homebrewItems.filter((item) => item.isOutdated).length}`,
    `- Installed/current: ${snapshot.homebrewItems.filter((item) => !item.isOutdated).length}`,
    `- Recently updated: ${snapshot.homebrewRecentlyUpdated.length}`,
    `- Ignored: ${snapshot.ignoredHomebrewItemIDs.length}`,
    "",
    "Optional Tools",
    `- mas installed: ${yesNo(snapshot.isMasInstalled)}`,
    `- Use mas for App Store updates: ${yesNo(snapshot.useMasForAppStoreUpdates)}`,
    "",
    "Scan Directories",
    `- Custom directories: ${snapshot.additionalDirectories.length}`,
    ...defaultScanDirectories(snapshot.additionalDirectories).map((directory) => `- ${directory}`)
  );

  return lines.join("\n");
}

function diagnosticsAppVersion(
  appMetadata: Pick<AppMetadata, "version" | "buildNumber"> | string
): string {
  return typeof appMetadata === "string"
    ? appMetadata
    : formatAppDisplayVersion(appMetadata.version, appMetadata.buildNumber);
}

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

function sourceCounts(sources: UpdateSource[]): Map<UpdateSource, number> {
  const counts = new Map<UpdateSource, number>();
  for (const source of sources) {
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return counts;
}

function formatSourceCounts(counts: Map<UpdateSource, number>): string {
  const formatted = [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([source, count]) => `${sourceDisplayName(source)}: ${count}`)
    .join(", ");
  return formatted || "None";
}

function appearanceLabel(value: BaselineSnapshot["appearancePreference"]): string {
  return {
    system: "System Default",
    light: "Light Mode",
    dark: "Dark Mode"
  }[value];
}

function defaultScanDirectories(additional: string[]): string[] {
  const home = process.env.HOME;
  const defaults = ["/Applications", home ? `${home}/Applications` : undefined].filter(
    Boolean
  ) as string[];
  return [...new Set([...defaults, ...additional])];
}
