// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import type { BaselineSnapshot, UpdateSource } from "./domain";
import { homebrewPresentationLabel, sourceDisplayName } from "./domain";
import { homebrewItemHasAppRepresentation } from "./homebrewAppLinking";
import { formatAppDisplayVersion, type AppMetadata } from "./appMetadata";

const routeExceptionLimit = 10;

export function renderDiagnostics(
  snapshot: BaselineSnapshot,
  appMetadata: Pick<AppMetadata, "version" | "buildNumber"> | string = "Unknown",
  platform = process.platform
): string {
  const updateSourceCounts = sourceCounts(snapshot.updates.map((update) => update.source));
  const appHintCounts = sourceCounts(snapshot.apps.map((app) => app.sourceHint));
  const homebrewFormulas = snapshot.homebrewItems.filter((item) => item.kind === "formula");
  const homebrewCasks = snapshot.homebrewItems.filter((item) => item.kind === "cask");
  const appLinkedCasks = homebrewCasks.filter((item) =>
    homebrewItemHasAppRepresentation(item, snapshot.apps)
  );
  const appLinkedCaskIDs = new Set(appLinkedCasks.map((item) => item.appID).filter(Boolean));
  const appsLinkedToHomebrewCasks = snapshot.apps.filter((app) => appLinkedCaskIDs.has(app.id));
  const appsNotLinkedToHomebrewCasks = snapshot.apps.length - appsLinkedToHomebrewCasks.length;
  const casksByPresentation = formatCaskPresentationCounts(homebrewCasks);
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
  const routeExceptions = routeExceptionRows(snapshot, routeExceptionLimit);

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
    `- Scanned app bundles: ${snapshot.apps.length}`,
    `- App bundles linked to Homebrew casks: ${appsLinkedToHomebrewCasks.length}`,
    `- App bundles not linked to Homebrew casks: ${appsNotLinkedToHomebrewCasks}`,
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
    "Route Exceptions",
    routeExceptions.total === 0
      ? "- None"
      : `- Listed: ${routeExceptions.rows.length} of ${routeExceptions.total}${
          routeExceptions.truncated ? " (truncated)" : ""
        }`,
    ...routeExceptions.rows.map((row) => `- ${formatRouteException(row)}`),
    "",
    "Homebrew",
    `- Homebrew detected: ${yesNo(snapshot.isHomebrewInstalled)}`,
    `- Items: ${snapshot.homebrewItems.length}`,
    `- Formulae: ${homebrewFormulas.length}`,
    `- Casks: ${homebrewCasks.length}`,
    `- Cask presentations: ${casksByPresentation}`,
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

function formatCaskPresentationCounts(
  casks: Array<Pick<BaselineSnapshot["homebrewItems"][number], "kind" | "presentation">>
): string {
  const counts = new Map<string, number>();
  for (const cask of casks) {
    const label = homebrewPresentationLabel(cask.kind, cask.presentation);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const formatted = [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label}: ${count}`)
    .join(", ");
  return formatted || "None";
}

type RouteExceptionRow = {
  actionRoute: string;
  bundleIdentifier: string;
  displayName: string;
  linkedCask: boolean;
  reason: string;
  selectedSource: UpdateSource;
  sourceHint: UpdateSource;
};

function routeExceptionRows(
  snapshot: BaselineSnapshot,
  limit: number
): { rows: RouteExceptionRow[]; total: number; truncated: boolean } {
  const appByID = new Map(snapshot.apps.map((app) => [app.id, app]));
  const rows = snapshot.updates.flatMap((update) => {
    if (update.source !== "homebrew") {
      return [];
    }
    const app = appByID.get(update.appID);
    if (!app) {
      return [];
    }
    const linkedCask = linkedHomebrewCaskForUpdate(snapshot, update);
    if (linkedCask) {
      return [];
    }
    return [
      {
        actionRoute: actionRouteForUpdate(snapshot, update),
        bundleIdentifier: diagnosticField(app.bundleIdentifier, "Not reported"),
        displayName: diagnosticField(app.displayName, "Unknown app"),
        linkedCask: false,
        reason: "Homebrew selected without installed cask link",
        selectedSource: update.source,
        sourceHint: app.sourceHint
      }
    ];
  });

  return {
    rows: rows.slice(0, limit),
    total: rows.length,
    truncated: rows.length > limit
  };
}

function linkedHomebrewCaskForUpdate(
  snapshot: BaselineSnapshot,
  update: { appID: string; homebrewToken?: string }
) {
  return snapshot.homebrewItems.find(
    (item) =>
      item.kind === "cask" &&
      item.appID === update.appID &&
      (!update.homebrewToken || item.token.toLowerCase() === update.homebrewToken.toLowerCase())
  );
}

function actionRouteForUpdate(
  snapshot: BaselineSnapshot,
  update: {
    appID: string;
    source: UpdateSource;
    appStoreItemID?: number;
    homebrewToken?: string;
    updateURL?: string;
  }
): string {
  if (update.source === "homebrew") {
    return linkedHomebrewCaskForUpdate(snapshot, update)
      ? "Homebrew cask update"
      : update.homebrewToken
        ? "Open app"
        : externalOrAppRoute(update);
  }
  if (update.source === "appStore" && snapshot.useMasForAppStoreUpdates && update.appStoreItemID) {
    return "App Store helper";
  }
  return externalOrAppRoute(update);
}

function externalOrAppRoute(update: { source: UpdateSource; updateURL?: string }): string {
  if (!update.updateURL) {
    return "Open app";
  }
  if (update.source === "appStore") {
    return "Open App Store URL";
  }
  if (update.source === "sparkle") {
    return "Open publisher updater URL";
  }
  if (update.source === "web") {
    return "Open publisher website";
  }
  return "Open external URL";
}

function formatRouteException(row: RouteExceptionRow): string {
  return [
    row.displayName,
    `bundle: ${row.bundleIdentifier}`,
    `hint: ${sourceDisplayName(row.sourceHint)}`,
    `selected: ${sourceDisplayName(row.selectedSource)}`,
    `action: ${row.actionRoute}`,
    `linked cask: ${yesNo(row.linkedCask)}`,
    `reason: ${row.reason}`
  ].join(" | ");
}

function diagnosticField(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/gu, " ").replace(/\|/gu, "/").trim();
  return normalized || fallback;
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
