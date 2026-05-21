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
  const updatesBySource = new Map<UpdateSource, number>();
  for (const update of snapshot.updates) {
    updatesBySource.set(update.source, (updatesBySource.get(update.source) ?? 0) + 1);
  }

  const sourceCounts = [...updatesBySource.entries()]
    .filter(([, count]) => count > 0)
    .map(([source, count]) => `${sourceDisplayName(source)}: ${count}`)
    .join(", ");

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
    `- Sources: ${sourceCounts || "None"}`,
    "",
    "Homebrew",
    `- Items: ${snapshot.homebrewItems.length}`,
    `- Outdated: ${snapshot.homebrewItems.filter((item) => item.isOutdated).length}`,
    `- Installed/current: ${snapshot.homebrewItems.filter((item) => !item.isOutdated).length}`,
    `- Recently updated: ${snapshot.homebrewRecentlyUpdated.length}`,
    `- Ignored: ${snapshot.ignoredHomebrewItemIDs.length}`,
    `- Homebrew available for helper install: ${yesNo(snapshot.isHomebrewInstalled)}`,
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
