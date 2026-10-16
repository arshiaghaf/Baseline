// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewManagedItem,
  UpdateRecord
} from "../../shared/domain";
import { homebrewItemForAppUpdate } from "../../shared/homebrewAppLinking";
import type { ActionState } from "../types";
import { uninstallableHomebrewItemForApp } from "./sections";

export type AppControlState = {
  update?: UpdateRecord;
  isIgnored: boolean;
  uninstallableItem?: HomebrewManagedItem;
  isUninstalling: boolean;
  actionState: ActionState;
  isUpdating: boolean;
  homebrewUninstallBlocked: boolean;
  isHomebrewUpdatePinned: boolean;
};

export function appControlState(app: AppRecord, snapshot: BaselineSnapshot): AppControlState {
  const update = snapshot.updates.find((candidate) => candidate.appID === app.id);
  const isHomebrewUpdatePinned = Boolean(
    homebrewItemForAppUpdate(update, snapshot.homebrewItems)?.pinned
  );
  const isIgnored = snapshot.ignoredIDs.includes(app.id);
  const uninstallableItem = uninstallableHomebrewItemForApp(app, snapshot);
  const isUninstalling = uninstallableItem
    ? snapshot.homebrewUninstallingItemIDs.includes(uninstallableItem.id)
    : false;
  const { state: actionState, isUpdating } = appUpdateActionState(app, snapshot);
  const homebrewCommandActive = isHomebrewCommandActive(snapshot);
  const homebrewUninstallBlocked = Boolean(
    uninstallableItem && homebrewCommandActive && !isUninstalling
  );
  return {
    update,
    isIgnored,
    uninstallableItem,
    isUninstalling,
    actionState,
    isUpdating,
    homebrewUninstallBlocked,
    isHomebrewUpdatePinned
  };
}

export type HomebrewControlState = {
  isUpdating: boolean;
  isUninstalling: boolean;
  isIgnored: boolean;
  updateState: ActionState;
  homebrewUninstallBlocked: boolean;
};

export function homebrewControlState(
  item: HomebrewManagedItem,
  snapshot: BaselineSnapshot
): HomebrewControlState {
  const isUpdating = snapshot.homebrewUpdatingItemIDs.includes(item.id);
  const queued = snapshot.homebrewQueuedItemIDs.includes(item.id);
  const isUninstalling = snapshot.homebrewUninstallingItemIDs.includes(item.id);
  const isIgnored = snapshot.ignoredHomebrewItemIDs.includes(item.id);
  const failed = snapshot.homebrewBatchFailedItemIDs.includes(item.id);
  const done = snapshot.homebrewUpdatedPendingRefreshItemIDs.includes(item.id);
  const progress = snapshot.homebrewBatchProgressByItemID[item.id];
  const homebrewUninstallBlocked = isHomebrewCommandActive(snapshot) && !isUninstalling;
  return {
    isUpdating,
    isUninstalling,
    isIgnored,
    updateState: actionStateFromFlags({
      failed,
      queued,
      updating: isUpdating,
      progress,
      done
    }),
    homebrewUninstallBlocked
  };
}

export function actionStateFromFlags({
  failed,
  queued = false,
  updating,
  progress,
  done
}: {
  failed: boolean;
  queued?: boolean;
  updating: boolean;
  progress?: number;
  done: boolean;
}): ActionState {
  if (failed) {
    return { type: "failed" };
  }
  if (done) {
    return { type: "done" };
  }
  if (queued) {
    return { type: "queued" };
  }
  if (updating) {
    return progress === undefined ? { type: "updating" } : { type: "updating", progress };
  }
  return { type: "ready" };
}

export function isHomebrewCommandActive(snapshot: BaselineSnapshot): boolean {
  return (
    snapshot.isHomebrewCommandLocked ||
    snapshot.isRunningHomebrewMaintenance ||
    snapshot.homebrewUpdatingItemIDs.length > 0 ||
    snapshot.homebrewUninstallingItemIDs.length > 0 ||
    snapshot.homebrewDiscoverInstallingItemIDs.length > 0
  );
}

export function actionStateLabel(state: Exclude<ActionState, { type: "ready" }>): string {
  if (state.type === "updating") {
    return "Updating";
  }
  if (state.type === "queued") {
    return "Queued";
  }
  if (state.type === "done") {
    return "Updated";
  }
  return "Update failed";
}

export function appUpdateActionState(
  app: AppRecord,
  snapshot: BaselineSnapshot
): { state: ActionState; isUpdating: boolean } {
  const update = snapshot.updates.find((candidate) => candidate.appID === app.id);
  const matchedHomebrewItem = homebrewItemForAppUpdate(update, snapshot.homebrewItems);
  const isUpdating =
    snapshot.appUpdatingIDs.includes(app.id) ||
    Boolean(
      matchedHomebrewItem && snapshot.homebrewUpdatingItemIDs.includes(matchedHomebrewItem.id)
    );
  const queued = Boolean(
    matchedHomebrewItem && snapshot.homebrewQueuedItemIDs.includes(matchedHomebrewItem.id)
  );
  const progress =
    snapshot.homebrewFallbackProgressByAppID[app.id] ??
    (matchedHomebrewItem
      ? snapshot.homebrewBatchProgressByItemID[matchedHomebrewItem.id]
      : undefined);
  const failed =
    snapshot.homebrewFallbackFailedAppIDs.includes(app.id) ||
    Boolean(
      matchedHomebrewItem && snapshot.homebrewBatchFailedItemIDs.includes(matchedHomebrewItem.id)
    );
  const done =
    snapshot.appUpdatedPendingRefreshIDs.includes(app.id) ||
    Boolean(
      matchedHomebrewItem &&
      snapshot.homebrewUpdatedPendingRefreshItemIDs.includes(matchedHomebrewItem.id)
    );

  return {
    isUpdating,
    state: actionStateFromFlags({
      failed,
      queued,
      updating: isUpdating,
      progress,
      done
    })
  };
}

export function homebrewBatchActionState(
  items: Pick<HomebrewManagedItem, "id">[],
  snapshot: BaselineSnapshot
): ActionState {
  return items.length > 0 &&
    items.every((item) => snapshot.homebrewUpdatedPendingRefreshItemIDs.includes(item.id))
    ? { type: "done" }
    : { type: "ready" };
}
