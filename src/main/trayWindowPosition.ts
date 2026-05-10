import type { Display, Rectangle } from "electron";

type TrayDisplay = Pick<Display, "workArea">;

export function calculateTrayWindowPosition(
  trayBounds: Rectangle,
  windowBounds: Rectangle,
  display: TrayDisplay
): { x: number; y: number } {
  const proposedX = trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2;
  const minX = display.workArea.x;
  const maxX = display.workArea.x + display.workArea.width - windowBounds.width;
  const x = clamp(proposedX, minX, Math.max(minX, maxX));
  const y = trayBounds.y + trayBounds.height;

  return {
    x: Math.round(x),
    y: Math.round(y)
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
