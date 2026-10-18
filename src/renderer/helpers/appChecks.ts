// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { AppProviderCheck, BaselineSnapshot } from "../../shared/domain";

export function appUpdatesEmptyText(snapshot: BaselineSnapshot): string {
  return updatesEmptyText(snapshot, true);
}

export function combinedUpdatesEmptyText(snapshot: BaselineSnapshot): string {
  return updatesEmptyText(snapshot, false);
}

function updatesEmptyText(snapshot: BaselineSnapshot, appsOnly: boolean): string {
  const checks = Object.values(snapshot.appProviderChecks ?? {});
  if (snapshot.isRefreshing || checks.some((check) => check.status === "pending"))
    return appsOnly
      ? "Checking app updates. Results are incomplete."
      : "Checking for updates. Results are incomplete.";
  if (snapshot.refreshErrorMessage || checks.some((check) => check.status === "failed"))
    return appsOnly
      ? "Some app updates could not be checked."
      : "Some updates could not be checked.";
  if (checks.some((check) => check.status === "unresolved"))
    return "No updates found in checked sources. Some apps have no verified update source.";
  if (!checks.length) {
    if (!snapshot.lastRefreshDate)
      return appsOnly ? "Refresh to check app updates." : "Refresh to check for updates.";
    return appsOnly
      ? "No app updates to show from the last refresh."
      : "No updates to show from the last refresh.";
  }
  return appsOnly
    ? "No app updates found in the checked sources."
    : "No updates found in the checked sources.";
}

export function appCheckLabel(check: AppProviderCheck | undefined): string | undefined {
  if (!check) return undefined;
  if (check.status === "pending") return "Checking updates";
  if (check.status === "failed") return "Could not check updates";
  if (check.status === "unresolved") return "No verified update source";
  return undefined;
}
