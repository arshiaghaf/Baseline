// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { HomebrewCaskEntry, HomebrewCaskIndex, HomebrewManagedItem } from "./domain";
import { compareVersions } from "./version";
import { isValidHomebrewToken } from "./security";

export function homebrewCommandToken(item: HomebrewManagedItem): string | undefined {
  if (!isValidHomebrewToken(item.token)) return undefined;
  if (item.kind !== "cask") return item.token;
  const full = item.fullToken;
  const tap = item.tap;
  if (!full || !tap || !isValidHomebrewToken(full)) return undefined;
  if (tap === "homebrew/cask") {
    return full === item.token || full === `${tap}/${item.token}` ? full : undefined;
  }
  return full === `${tap}/${item.token}` ? full : undefined;
}

export function homebrewItemIdentity(item: HomebrewManagedItem): string | undefined {
  const command = homebrewCommandToken(item);
  return command ? (item.kind === "cask" ? `${item.tap}/${item.token}` : command) : undefined;
}

export function installedCaskEntry(
  item: HomebrewManagedItem,
  index: HomebrewCaskIndex
): HomebrewCaskEntry | undefined {
  if (item.kind !== "cask" || !homebrewCommandToken(item)) return undefined;
  const entry = item.caskMetadata ?? index.byToken[item.token.toLowerCase()];
  if (!entry || entry.token.toLowerCase() !== item.token.toLowerCase()) return undefined;
  // Legacy public catalogue entries may omit identity; custom taps must be explicit.
  const full = entry.fullToken ?? entry.token;
  const tap = entry.tap ?? "homebrew/cask";
  const identity = homebrewItemIdentity({ ...item, fullToken: full, tap });
  return identity && identity === homebrewItemIdentity(item) ? entry : undefined;
}

export function caskIndexForInstalledItems(
  catalogue: HomebrewCaskIndex,
  items: HomebrewManagedItem[]
): HomebrewCaskIndex {
  const byToken = { ...catalogue.byToken };
  for (const item of items) {
    if (item.kind !== "cask") continue;
    const key = item.token.toLowerCase();
    const entry = installedCaskEntry(item, catalogue);
    delete byToken[key];
    if (entry) byToken[key] = entry;
  }
  const byBundleIdentifier: HomebrewCaskIndex["byBundleIdentifier"] = {};
  const byAppBundleName: HomebrewCaskIndex["byAppBundleName"] = {};
  for (const entry of Object.values(byToken)) {
    for (const identifier of entry.bundleIdentifiers) {
      const key = identifier.toLowerCase();
      const existing = byBundleIdentifier[key];
      if (!existing || compareVersions(entry.version, existing.version) >= 0) {
        byBundleIdentifier[key] = entry;
      }
    }
    for (const name of entry.appBundleNames) {
      byAppBundleName[name] = [...(byAppBundleName[name] ?? []), entry];
    }
  }
  return { byToken, byBundleIdentifier, byAppBundleName };
}
