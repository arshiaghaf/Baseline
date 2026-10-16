// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { HomebrewManagedItemKind } from "../shared/domain";
import { isValidHomebrewToken } from "../shared/security";
import type { CommandResult } from "./commandRunner";

/** Strict transport validation; optional metadata is decoded separately. */
export function installedInfoSection(
  result: CommandResult,
  kind: HomebrewManagedItemKind
): Record<string, any>[] | undefined {
  if (!result.success) return undefined;
  try {
    const raw = JSON.parse(result.stdout ?? result.output);
    const entries: unknown = raw?.[kind === "formula" ? "formulae" : "casks"];
    if (!Array.isArray(entries)) return undefined;
    const tokens = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      const token = kind === "formula" ? entry.name : entry.token;
      if (
        typeof token !== "string" ||
        !isValidHomebrewToken(token) ||
        token.includes("/") ||
        tokens.has(token.toLowerCase())
      )
        return undefined;
      tokens.add(token.toLowerCase());
      if (kind === "formula") {
        if (
          !Array.isArray(entry.installed) ||
          entry.installed.length === 0 ||
          !entry.installed.every((receipt: any) => isVersion(receipt?.version))
        )
          return undefined;
      } else if (!isVersion(entry.installed)) {
        // Unknown/null/array schemas must not silently remove an installed cask.
        return undefined;
      }
    }
    return entries;
  } catch {
    return undefined;
  }
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/u.test(value);
}
