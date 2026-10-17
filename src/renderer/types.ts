// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { HomebrewCaskDiscoveryItem, HomebrewManagedItem } from "../shared/domain";

export type Route = "main" | "menubar" | "settings";

export type ActionState =
  | { type: "ready" }
  | { type: "queued" }
  | { type: "updating"; progress?: number; waitingForAdmin?: boolean }
  | { type: "done" }
  | { type: "failed" };

export type ActionConfirmation =
  | { type: "install"; item: HomebrewCaskDiscoveryItem }
  | { type: "uninstall"; item: HomebrewManagedItem };

export type RequestActionConfirmation = (confirmation: ActionConfirmation) => void;

export type RowUpdateMenuAction = {
  state: ActionState;
  disabled?: boolean;
  readyLabel?: string;
  onAction: () => void;
};

export type RowActionMenuPlacement = "below" | "above" | "floating";

export type RowActionMenuFloatingPosition = {
  left: number;
  top: number;
};

export type SettingsSectionID = "general" | "profile" | "appearance" | "diagnostics";

export type TogglePatch = Exclude<
  keyof Parameters<typeof window.baseline.updatePreferences>[0],
  "selectedTab" | "refreshIntervalMinutes" | "appearancePreference"
>;
