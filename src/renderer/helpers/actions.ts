// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { BaselineSnapshot, HomebrewManagedItem } from "../../shared/domain";

export function performHomebrewUpdateAllForItems(items: Pick<HomebrewManagedItem, "id">[]): void {
  void window.baseline.performHomebrewUpdateAll(items.map((item) => item.id));
}

export function toggleCollapsedSection(
  kind: "app" | "homebrew",
  sectionID: string,
  snapshot: BaselineSnapshot
): void {
  const key = kind === "app" ? "collapsedAppSectionIDs" : "collapsedHomebrewSectionIDs";
  const values = new Set(snapshot[key]);
  if (values.has(sectionID)) {
    values.delete(sectionID);
  } else {
    values.add(sectionID);
  }
  void window.baseline.updatePreferences({ [key]: [...values].sort() });
}
