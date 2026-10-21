// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { nativeImage, type NativeImage } from "electron";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Read the icon actually shipped by Electron Packager, including the selected
// macOS icon variant. No system file-icon lookup or permission probe is needed.
export async function permissionGuideIcon(bundle: string): Promise<NativeImage> {
  let temporary: string | undefined;
  try {
    temporary = await mkdtemp(path.join(os.tmpdir(), "baseline-guide-icon-"));
    const png = path.join(temporary, "icon.png");
    await execFileAsync(
      "/usr/bin/sips",
      [
        "-s",
        "format",
        "png",
        path.join(bundle, "Contents", "Resources", "electron.icns"),
        "--out",
        png
      ],
      { timeout: 8000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" }
    );
    const image = nativeImage.createFromPath(png);
    if (image.isEmpty()) return image;
    const retina = image.resize({ width: 128, height: 128, quality: "best" });
    return nativeImage.createFromBuffer(retina.toPNG(), { scaleFactor: 2 });
  } catch {
    return nativeImage.createEmpty();
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}
