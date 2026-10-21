// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { ForgeHookFn } from "@electron-forge/shared-types";
import { execFileSync } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

export async function buildAdminAskpass(
  destination: string,
  arch: string,
  sourceRoot = __dirname
): Promise<void> {
  if (arch !== "arm64") throw new Error("Unsupported admin helper architecture.");
  if (!path.isAbsolute(destination)) throw new Error("Admin helper output must be absolute.");
  await mkdir(path.dirname(destination), { recursive: true });
  execFileSync(
    "/usr/bin/xcrun",
    [
      "--sdk",
      "macosx",
      "clang",
      "-arch",
      "arm64",
      "-mmacosx-version-min=15.0",
      "-fobjc-arc",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-framework",
      "Foundation",
      "-framework",
      "AppKit",
      path.join(sourceRoot, "native/admin-askpass/main.m"),
      path.join(sourceRoot, "native/admin-askpass/dialog.m"),
      "-o",
      destination
    ],
    { stdio: "pipe" }
  );
  await chmod(destination, 0o755);
}

/** afterCopy's buildPath is Resources/app. Sibling output remains outside ASAR
 * and exists before Packager signs the bundle. Nothing launches the helper. */
export const packageAdminAskpass: ForgeHookFn<"packageAfterCopy"> = async (
  _config,
  buildPath,
  _version,
  platform,
  arch
) => {
  if (platform !== "darwin") return;
  await buildAdminAskpass(path.join(path.dirname(buildPath), "admin-askpass"), arch);
};
