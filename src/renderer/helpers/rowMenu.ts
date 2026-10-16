// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React from "react";
import type {
  RowActionMenuPlacement,
  RowActionMenuFloatingPosition,
  RowUpdateMenuAction
} from "../types";

export const rowActionMenuEstimatedWidth = 142;

export function rowActionMenuPopoverClassName(placement: RowActionMenuPlacement): string {
  if (placement === "above") {
    return "row-action-menu-popover row-action-menu-popover-above";
  }
  if (placement === "floating") {
    return "row-action-menu-popover row-action-menu-popover-floating";
  }
  return "row-action-menu-popover";
}

export function floatingRowActionMenuStyle(
  position: RowActionMenuFloatingPosition | undefined
): React.CSSProperties {
  return {
    left: position?.left ?? 0,
    top: position?.top ?? 0,
    visibility: position ? "visible" : "hidden"
  };
}

export function rowActionMenuEstimatedHeight(
  updateAction: RowUpdateMenuAction | undefined,
  canUninstall: boolean
): number {
  const itemCount = 1 + (updateAction ? 1 : 0) + (canUninstall ? 1 : 0);
  return itemCount * 28 + 10;
}
