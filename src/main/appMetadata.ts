// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { execFileSync } from "node:child_process";
import path from "node:path";
import type { App } from "electron";
import { formatAppDisplayVersion, type AppMetadata } from "../shared/appMetadata";
import { validBuildNumber } from "../shared/buildNumber";

export function appMetadata(app: App): AppMetadata {
  const version = app.getVersion();
  const buildNumber =
    buildNumberFromEnvironment() ?? (app.isPackaged ? buildNumberFromBundle() : localBuildNumber());

  return {
    version,
    buildNumber,
    displayVersion: formatAppDisplayVersion(version, buildNumber)
  };
}

function buildNumberFromEnvironment(): string | undefined {
  return validBuildNumber(process.env.BASELINE_BUILD_NUMBER ?? process.env.GITHUB_RUN_NUMBER);
}

function buildNumberFromBundle(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  const infoPlistPath = path.join(process.resourcesPath, "..", "Info.plist");
  return runBuildNumberCommand("/usr/bin/plutil", [
    "-extract",
    "CFBundleVersion",
    "raw",
    "-o",
    "-",
    infoPlistPath
  ]);
}

function localBuildNumber(): string | undefined {
  return runBuildNumberCommand("/usr/bin/git", ["rev-list", "--count", "HEAD"], process.cwd());
}

function runBuildNumberCommand(command: string, args: string[], cwd?: string): string | undefined {
  try {
    return validBuildNumber(
      execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim()
    );
  } catch {
    return undefined;
  }
}
