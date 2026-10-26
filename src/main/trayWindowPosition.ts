// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { Display, Rectangle } from "electron";

type TrayDisplay = Pick<Display, "workArea">;

export function calculateTrayWindowBounds(
  trayBounds: Rectangle,
  preferredSize: Pick<Rectangle, "width" | "height">,
  display: TrayDisplay
): Rectangle {
  const width = Math.min(preferredSize.width, display.workArea.width);
  const height = Math.min(preferredSize.height, display.workArea.height);
  const proposedX = trayBounds.x + trayBounds.width / 2 - width / 2;
  const minX = display.workArea.x;
  const maxX = display.workArea.x + display.workArea.width - width;
  const x = clamp(proposedX, minX, maxX);
  const minY = display.workArea.y;
  const maxY = display.workArea.y + display.workArea.height - height;
  const y = clamp(trayBounds.y + trayBounds.height, minY, maxY);

  return {
    x: Math.round(x),
    y: Math.round(y),
    width,
    height
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
