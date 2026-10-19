// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import path from "node:path";
import type { AppRecord } from "../shared/domain";

// macOS services these protected application locations, including the app Cryptex.
// Classify resolved locations rather than names, bundle IDs, or /Applications aliases.
const managedRoots = [
  "/System/Applications",
  "/System/Library/CoreServices/Applications",
  "/System/Cryptexes/App/System/Applications",
  "/System/Volumes/Preboot/Cryptexes/App/System/Applications"
];

export function macOSManagedPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    !value.endsWith(".app") ||
    path.posix.normalize(value) !== value
  )
    return undefined;
  return managedRoots.some((root) => value.startsWith(`${root}/`)) ? value : undefined;
}

export function isMacOSManagedApp(app: AppRecord): boolean {
  return macOSManagedPath(app.macOSManagedPath) !== undefined;
}
