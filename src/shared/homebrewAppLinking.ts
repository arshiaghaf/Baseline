// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
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
  apps: AppRecord[],
  updatesByAppID: Map<string, UpdateRecord>
): boolean {
  if (!isCask(item.kind)) {
    return false;
  }
  if (item.appID && apps.some((app) => app.id === item.appID)) {
    return true;
  }

  const identifiers = homebrewItemIdentifiers(item);
  return apps.some((app) => {
    const update = updatesByAppID.get(app.id);
    if (update?.homebrewToken && identifiers.has(normalizedHomebrewAppName(update.homebrewToken))) {
      return true;
    }
    return false;
  });
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

export function homebrewItemIdentifiers(
  item: Pick<HomebrewManagedItem, "token"> &
    Partial<Pick<HomebrewManagedItem, "name"> & Pick<HomebrewCaskDiscoveryItem, "displayName">>
): Set<string> {
  return new Set(
    [item.token, item.name, item.displayName]
      .filter((value): value is string => Boolean(value))
      .map(normalizedHomebrewAppName)
  );
}

export function normalizedHomebrewAppName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function isCask(kind: string): boolean {
  return kind.toLowerCase() === "cask";
}
