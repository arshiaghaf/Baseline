// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { nativeImage } from "electron";
import { trayRefreshFrameCount } from "./trayRefreshAnimation";

const iconSize = 18;
const fullTurn = 2 * Math.PI;

// The existing two circular arrows glyph, kept as the canonical artwork.
const refreshGlyphDataURL =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAA0VXHyAAABIklEQVQ4EaWSP2pCQRCHTUidAySkCgErb5DSVBZapfIeOY6FjVYWgeANklIFCYiNSPAMFonf99wF9+3zD+QH3467+2acnZla7Z+6Cv6vwQ6CbWBb8Bj2C+wIvsM+M0NO5B7e4Q/W8BH4wf5CH24hk85j2MAcmnAoM+2AgSaQBdF5C1PowjNU6YFDg5hJoi92ph1ZJbfpxkx8Tj09vnznc8ziTZdrF2QXYieKgxOLWVqHJ7+5cUEvcAexjZ6dUq98aTqmFeeifH92b0EsjAU6Jgsbi6z9LH9oa8zCVlXJ1nZhBrbc1idyOCyOQdpQfo7D5ZA5bDo7fJkMYiY+x0BxlNf8Nm3H3HGPo5/9C3eFrIlZFK3CLkFnJ1XFll/atb1X1boDYBs/6p2bHjwAAAAASUVORK5CYII=";

export function createTrayIcons(): {
  idle: Electron.NativeImage;
  refreshing: Electron.NativeImage[];
} {
  const glyph = nativeImage.createFromDataURL(refreshGlyphDataURL);
  const pixels = glyph.toBitmap();
  const { width, height } = glyph.getSize();
  return {
    idle: createIcon((x, y) => idleCoverage(x, y)),
    refreshing: Array.from({ length: trayRefreshFrameCount }, (_, frame) => {
      const angle = (frame / trayRefreshFrameCount) * fullTurn;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      return createIcon((x, y) => {
        // Inverse rotation about a fixed center; every frame samples the same
        // original artwork, avoiding cumulative resampling drift or cropping.
        const dx = x - iconSize / 2;
        const dy = y - iconSize / 2;
        const sx = cosine * dx + sine * dy + width / 2 - 0.5;
        const sy = -sine * dx + cosine * dy + height / 2 - 0.5;
        return interpolatedAlpha(pixels, width, height, sx, sy);
      });
    })
  };
}

// Black with alpha only: macOS supplies the menu bar's light/dark tint.
// Rasterize once at 1x and Retina 2x, never on an animation tick. NativeImage
// supports bitmap/PNG input; an SVG data URL produces an empty image.
function createIcon(coverageAt: (x: number, y: number) => number): Electron.NativeImage {
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const size = iconSize * scaleFactor;
    const bitmap = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let coverage = 0;
        for (let sy = 0; sy < 4; sy += 1) {
          for (let sx = 0; sx < 4; sx += 1) {
            const px = (x + (sx + 0.5) / 4) / scaleFactor;
            const py = (y + (sy + 0.5) / 4) / scaleFactor;
            coverage += coverageAt(px, py);
          }
        }
        bitmap[(y * size + x) * 4 + 3] = Math.round((coverage / 16) * 255);
      }
    }
    const representation = nativeImage.createFromBitmap(bitmap, {
      width: size,
      height: size,
      scaleFactor
    });
    image.addRepresentation({ scaleFactor, buffer: representation.toPNG() });
  }
  image.setTemplateImage(true);
  return image;
}

function idleCoverage(x: number, y: number): number {
  const dx = x - 9;
  const dy = y - 9;
  // Preserve the original 15-point circle and its triangular cutout.
  const inTriangle = y >= 3.7 && y <= 11.8 && Math.abs(dx) <= ((y - 3.7) * 4.7) / 8.1;
  return Math.hypot(dx, dy) <= 7.5 && !inTriangle ? 1 : 0;
}

function interpolatedAlpha(
  pixels: Buffer,
  width: number,
  height: number,
  x: number,
  y: number
): number {
  const left = Math.floor(x);
  const top = Math.floor(y);
  const fx = x - left;
  const fy = y - top;
  const alpha = (px: number, py: number): number =>
    px < 0 || py < 0 || px >= width || py >= height ? 0 : pixels[(py * width + px) * 4 + 3]! / 255;
  return (
    alpha(left, top) * (1 - fx) * (1 - fy) +
    alpha(left + 1, top) * fx * (1 - fy) +
    alpha(left, top + 1) * (1 - fx) * fy +
    alpha(left + 1, top + 1) * fx * fy
  );
}
