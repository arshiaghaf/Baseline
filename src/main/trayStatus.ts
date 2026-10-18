// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { BaselineSnapshot } from "../shared/domain";
import {
  homebrewItemForAppUpdate,
  homebrewItemHasAppRepresentation
} from "../shared/homebrewAppLinking";

export function trayUpdateTitle(snapshot: BaselineSnapshot): string {
  const ignored = new Set(snapshot.ignoredIDs);
  const ignoredHomebrew = new Set(snapshot.ignoredHomebrewItemIDs);
  const visibleAppUpdates = snapshot.updates.filter(
    (update) =>
      !ignored.has(update.appID) &&
      !(
        update.source === "homebrew" &&
        homebrewItemForAppUpdate(update, snapshot.homebrewItems)?.pinned
      )
  );
  const visibleAppUpdateIDs = new Set(visibleAppUpdates.map((update) => update.appID));
  const appsRepresentedOutsideHomebrew = snapshot.apps.filter(
    (app) => visibleAppUpdateIDs.has(app.id) || ignored.has(app.id)
  );
  const visibleHomebrewUpdates = snapshot.homebrewItems.filter(
    (item) =>
      item.isOutdated &&
      !item.pinned &&
      !ignoredHomebrew.has(item.id) &&
      !homebrewItemHasAppRepresentation(item, appsRepresentedOutsideHomebrew)
  );
  const visibleUpdates = visibleAppUpdates.length + visibleHomebrewUpdates.length;
  if (visibleUpdates === 0) {
    const checks = Object.values(snapshot.appProviderChecks ?? {});
    const complete =
      snapshot.lastRefreshDate &&
      snapshot.homebrewCheckStatus === "complete" &&
      !snapshot.isRefreshing &&
      !snapshot.isChecking &&
      !snapshot.refreshErrorMessage &&
      !snapshot.lastRefreshNoticeMessage &&
      !snapshot.homebrewConfigurationBlocked &&
      checks.every((check) => check.status === "checked");
    return complete ? "✓" : "";
  }
  return `${visibleUpdates}\u2009↓`;
}
