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
  if (
    snapshot.isRefreshing ||
    checks.some((check) => check.status === "pending") ||
    (!appsOnly && snapshot.homebrewCheckStatus === "checking")
  )
    return appsOnly
      ? "Checking app updates. Results are incomplete."
      : "Checking for updates. Results are incomplete.";
  if (
    snapshot.refreshErrorMessage ||
    checks.some((check) => check.status === "failed") ||
    (!appsOnly && snapshot.homebrewCheckStatus === "incomplete")
  )
    return appsOnly
      ? "Some app updates could not be checked."
      : "Some updates could not be checked.";
  // Inventory failures and cached catalogue warnings can complete a refresh
  // without a refresh error. Keep the combined result qualified in both cases.
  if (!appsOnly && (snapshot.lastRefreshNoticeMessage || snapshot.homebrewCheckNoticeMessage))
    return "Some update information may be incomplete. See the refresh notice for details.";
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

export function homebrewUpdatesEmptyText(snapshot: BaselineSnapshot): string {
  if (snapshot.isRefreshing || snapshot.homebrewCheckStatus === "checking")
    return "Checking Homebrew updates. Results are incomplete.";
  if (snapshot.homebrewConfigurationBlocked || snapshot.homebrewCheckStatus === "incomplete")
    return "Some Homebrew updates could not be checked. Refresh to retry.";
  if (snapshot.refreshErrorMessage)
    return "No Homebrew updates to show. The refresh did not complete.";
  if (snapshot.homebrewCheckNoticeMessage)
    return "Homebrew update information may be incomplete. See the refresh notice for details.";
  if (snapshot.homebrewCheckStatus !== "complete") return "Refresh to check Homebrew updates.";
  if (snapshot.homebrewItems.some((item) => item.isOutdated))
    return "No Homebrew updates to show. Updates may be listed with apps, ignored, or pinned.";
  return "All your Homebrew items are up to date.";
}
