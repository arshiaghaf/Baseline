// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

export function normalizeAppVisibility(input: {
  showDockIcon?: unknown;
  showMenuBarIcon?: unknown;
}): { showDockIcon: boolean; showMenuBarIcon: boolean } {
  const showMenuBarIcon = input.showMenuBarIcon !== false;
  return {
    showDockIcon: input.showDockIcon !== false || !showMenuBarIcon,
    showMenuBarIcon
  };
}
