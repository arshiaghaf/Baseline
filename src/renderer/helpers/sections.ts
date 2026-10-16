// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { AppRecord, BaselineSnapshot, HomebrewManagedItem } from "../../shared/domain";

export function uninstallableHomebrewItemForApp(
  app: AppRecord,
  snapshot: BaselineSnapshot
): HomebrewManagedItem | undefined {
  const matchedByExplicitLink = snapshot.homebrewItems.find(
    (item) => item.kind === "cask" && item.appID === app.id
  );
  if (matchedByExplicitLink) {
    return matchedByExplicitLink;
  }

  return undefined;
}
