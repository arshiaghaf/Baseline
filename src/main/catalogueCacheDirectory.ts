// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import path from "node:path";

// Disposable catalogues never share the durable snapshot's recovery files.
// An explicit user-data override also isolates caches for tests and support runs.
export function catalogueCacheDirectory(
  homeDirectory: string,
  userDataDirectory: string,
  isolatedUserData: boolean
): string {
  return isolatedUserData
    ? path.join(userDataDirectory, "cache", "catalogues")
    : path.join(homeDirectory, "Library", "Caches", "com.arshiaghaf.baseline", "catalogues");
}
