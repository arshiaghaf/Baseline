// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type {
  AppRecord,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  UpdateRecord
} from "./domain";

export function homebrewItemHasAppRepresentation(
  item: Pick<HomebrewManagedItem, "kind" | "token"> &
    Partial<
      Pick<HomebrewManagedItem, "appID" | "name"> & Pick<HomebrewCaskDiscoveryItem, "displayName">
    >,
  apps: AppRecord[]
): boolean {
  if (!isCask(item.kind)) {
    return false;
  }
  if (item.appID && apps.some((app) => app.id === item.appID)) {
    return true;
  }

  return false;
}

export function homebrewItemMatchesApp(
  item: Pick<HomebrewManagedItem, "kind" | "token"> &
    Partial<
      Pick<HomebrewManagedItem, "appID" | "name"> & Pick<HomebrewCaskDiscoveryItem, "displayName">
    >,
  apps: AppRecord[]
): boolean {
  if (!isCask(item.kind)) {
    return false;
  }
  if (item.appID) {
    return apps.some((app) => app.id === item.appID);
  }

  return false;
}

export function isCask(kind: string): boolean {
  return kind.toLowerCase() === "cask";
}

/** Resolve the installed cask selected by the app update, never a sibling app link. */
export function homebrewItemForAppUpdate(
  update: UpdateRecord | undefined,
  items: HomebrewManagedItem[]
): HomebrewManagedItem | undefined {
  if (update?.source !== "homebrew" || !update.homebrewToken) return undefined;
  const token = update.homebrewToken.toLowerCase();
  return items.find((item) => item.kind === "cask" && item.token.toLowerCase() === token);
}
