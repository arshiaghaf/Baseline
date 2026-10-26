// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { calculateTrayWindowBounds } from "../src/main/trayWindowPosition";

describe("tray window positioning", () => {
  it("centers the compact window under the tray item without a vertical gap", () => {
    expect(
      calculateTrayWindowBounds(
        { x: 900, y: 0, width: 24, height: 24 },
        { width: 440, height: 560 },
        { workArea: { x: 0, y: 24, width: 1440, height: 876 } }
      )
    ).toEqual({ x: 692, y: 24, width: 440, height: 560 });
  });

  it("clamps the compact window to the left edge of the matched display work area", () => {
    expect(
      calculateTrayWindowBounds(
        { x: 10, y: 0, width: 24, height: 24 },
        { width: 440, height: 560 },
        { workArea: { x: 0, y: 24, width: 1440, height: 876 } }
      )
    ).toEqual({ x: 0, y: 24, width: 440, height: 560 });
  });

  it("clamps the compact window to the right edge of the matched display work area", () => {
    expect(
      calculateTrayWindowBounds(
        { x: 1420, y: 0, width: 24, height: 24 },
        { width: 440, height: 560 },
        { workArea: { x: 0, y: 24, width: 1440, height: 876 } }
      )
    ).toEqual({ x: 1000, y: 24, width: 440, height: 560 });
  });

  it("uses the matched display work area when clamping multi-display positions", () => {
    expect(
      calculateTrayWindowBounds(
        { x: -1180, y: 0, width: 24, height: 24 },
        { width: 440, height: 560 },
        { workArea: { x: -1280, y: 24, width: 1280, height: 776 } }
      )
    ).toEqual({ x: -1280, y: 24, width: 440, height: 560 });
  });
  it.each([
    { x: 0, y: 24, width: 1024, height: 516 },
    { x: -800, y: -600, width: 360, height: 380 },
    { x: 80, y: 100, width: 300, height: 200 }
  ])("fits both dimensions within a small work area %j", (workArea) => {
    const bounds = calculateTrayWindowBounds(
      { x: workArea.x + workArea.width - 24, y: workArea.y - 24, width: 24, height: 24 },
      { width: 440, height: 560 },
      { workArea }
    );
    expect(bounds.width).toBe(Math.min(440, workArea.width));
    expect(bounds.height).toBe(Math.min(560, workArea.height));
    expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
    expect(bounds.y).toBeGreaterThanOrEqual(workArea.y);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height);
  });

  it("moves upward at the bottom edge and respects a negative vertical origin", () => {
    expect(
      calculateTrayWindowBounds(
        { x: -50, y: -100, width: 24, height: 24 },
        { width: 440, height: 560 },
        { workArea: { x: -1000, y: -800, width: 1000, height: 800 } }
      )
    ).toEqual({ x: -440, y: -560, width: 440, height: 560 });
  });

  it("clamps above-work-area anchors to the top edge", () => {
    expect(
      calculateTrayWindowBounds(
        { x: 300, y: 0, width: 24, height: 24 },
        { width: 440, height: 560 },
        { workArea: { x: 0, y: 80, width: 1000, height: 800 } }
      ).y
    ).toBe(80);
  });
});
