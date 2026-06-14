// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { execFileSync } from "node:child_process";
import packageJSON from "./package.json";
import { buildNumberForAppVersion, validBuildNumber } from "./src/shared/buildNumber";

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
const buildNumber = releaseBuildNumber();

const config: ForgeConfig = {
  packagerConfig: {
    name: "Baseline",
    executableName: "Baseline",
    appVersion: packageJSON.version,
    buildVersion: buildNumber,
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

function releaseBuildNumber(): string {
  return (
    validBuildNumber(process.env.BASELINE_BUILD_NUMBER) ??
    releaseVersionBuildNumber() ??
    validBuildNumber(process.env.GITHUB_RUN_NUMBER) ??
    gitCommitCount() ??
    "1"
  );
}

function releaseVersionBuildNumber(): string | undefined {
  if (process.env.BASELINE_RELEASE_BUILD !== "1") {
    return undefined;
  }

  const buildNumber = buildNumberForAppVersion(packageJSON.version);
  if (!buildNumber) {
    throw new Error(
      `Cannot derive release build number from package version ${packageJSON.version}. ` +
        "Use a stable x.y.z version with minor and patch components below 100."
    );
  }
  return buildNumber;
}

function gitCommitCount(): string | undefined {
  try {
    return validBuildNumber(
      execFileSync("/usr/bin/git", ["rev-list", "--count", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim()
    );
  } catch {
    return undefined;
  }
}
