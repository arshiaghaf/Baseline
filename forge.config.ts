// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { execFileSync } from "node:child_process";

function macOSMajorVersion(): number | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  try {
    const version = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8"
    }).trim();
    const major = Number.parseInt(version.split(".")[0] ?? "", 10);

    return Number.isNaN(major) ? undefined : major;
  } catch {
    return undefined;
  }
}

const appIcon =
  (macOSMajorVersion() ?? 26) >= 26 ? "assets/app-icon" : "assets/app-icon-legacy.icns";

const config: ForgeConfig = {
  packagerConfig: {
    name: "Baseline",
    executableName: "Baseline",
    icon: appIcon,
    appBundleId: "com.arshiaghaf.baseline",
    appCategoryType: "public.app-category.utilities",
    asar: true,
    extendInfo: {
      LSMinimumSystemVersion: "14.0"
    }
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ["darwin"]),
    new MakerDMG(
      {
        name: "Baseline",
        format: "ULFO"
      },
      ["darwin"]
    )
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/main.ts",
          config: "vite.main.config.ts"
        },
        {
          entry: "src/main/preload.ts",
          config: "vite.preload.config.ts"
        }
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts"
        }
      ]
    })
  ]
};

export default config;
