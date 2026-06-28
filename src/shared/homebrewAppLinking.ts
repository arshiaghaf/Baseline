// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import type { AppRecord, HomebrewCaskDiscoveryItem, HomebrewManagedItem } from "./domain";

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
