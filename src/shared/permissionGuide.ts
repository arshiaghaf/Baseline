// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

export const permissionGuideActions = [
  "show",
  "info",
  "settings",
  "finder",
  "copy",
  "drag",
  "close"
] as const;
export type PermissionGuideAction = (typeof permissionGuideActions)[number];
export type PermissionGuideInfo = {
  appPath?: string;
  iconDataURL?: string;
  message?: string;
};
