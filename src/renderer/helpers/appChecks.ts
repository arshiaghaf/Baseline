// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { AppProviderCheck, BaselineSnapshot } from "../../shared/domain";

export function appUpdatesEmptyText(snapshot: BaselineSnapshot): string {
  const checks = Object.values(snapshot.appProviderChecks ?? {});
  if (snapshot.isRefreshing || checks.some((check) => check.status === "pending"))
    return "Checking app updates. Results are incomplete.";
  if (snapshot.refreshErrorMessage || checks.some((check) => check.status === "failed"))
    return "Some app updates could not be checked.";
  if (checks.some((check) => check.status === "unresolved"))
    return "No updates found in checked sources. Some apps have no verified update source.";
  if (!checks.length)
    return snapshot.lastRefreshDate
      ? "No app updates to show from the last refresh."
      : "Refresh to check app updates.";
  return "No app updates found in the checked sources.";
}

export function appCheckLabel(check: AppProviderCheck | undefined): string | undefined {
  if (!check) return undefined;
  if (check.status === "pending") return "Checking updates";
  if (check.status === "failed") return "Could not check updates";
  if (check.status === "unresolved") return "No verified update source";
  return undefined;
}
