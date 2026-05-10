import { describe, expect, it } from "vitest";
import { calculateTrayWindowPosition } from "../src/main/trayWindowPosition";

describe("tray window positioning", () => {
  it("centers the compact window under the tray item without a vertical gap", () => {
    expect(
      calculateTrayWindowPosition(
        { x: 900, y: 0, width: 24, height: 24 },
        { x: 0, y: 0, width: 440, height: 560 },
        { workArea: { x: 0, y: 24, width: 1440, height: 876 } }
      )
    ).toEqual({ x: 692, y: 24 });
  });

  it("clamps the compact window to the left edge of the matched display work area", () => {
    expect(
      calculateTrayWindowPosition(
        { x: 10, y: 0, width: 24, height: 24 },
        { x: 0, y: 0, width: 440, height: 560 },
        { workArea: { x: 0, y: 24, width: 1440, height: 876 } }
      )
    ).toEqual({ x: 0, y: 24 });
  });

  it("clamps the compact window to the right edge of the matched display work area", () => {
    expect(
      calculateTrayWindowPosition(
        { x: 1420, y: 0, width: 24, height: 24 },
        { x: 0, y: 0, width: 440, height: 560 },
        { workArea: { x: 0, y: 24, width: 1440, height: 876 } }
      )
    ).toEqual({ x: 1000, y: 24 });
  });

  it("uses the matched display work area when clamping multi-display positions", () => {
    expect(
      calculateTrayWindowPosition(
        { x: -1180, y: 0, width: 24, height: 24 },
        { x: 0, y: 0, width: 440, height: 560 },
        { workArea: { x: -1280, y: 24, width: 1280, height: 776 } }
      )
    ).toEqual({ x: -1280, y: 24 });
  });
});
