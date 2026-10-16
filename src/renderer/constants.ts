// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React from "react";
import { CircleUserRound, Monitor, Moon, Settings, Sun, Terminal } from "lucide-react";
import type { AppearancePreference } from "../shared/domain";
import type { SettingsSectionID } from "./types";

export const sidebarIconStrokeWidth = 1.5;

export const toolbarIconStrokeWidth = 1.5;

export const compactVersionLabelMaxLength = 9;

export const settingsSidebarItems: Array<{
  id: SettingsSectionID;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
}> = [
  { id: "general", label: "General", icon: Settings },
  { id: "profile", label: "Profile", icon: CircleUserRound },
  { id: "appearance", label: "Appearance", icon: Monitor },
  { id: "diagnostics", label: "Diagnostics", icon: Terminal }
];

export const primarySettingsSidebarItems = settingsSidebarItems.filter(
  (item) => item.id !== "diagnostics"
);

export const appearanceOptions: Array<{
  value: AppearancePreference;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
}> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon }
];
