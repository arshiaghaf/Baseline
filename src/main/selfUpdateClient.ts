// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import type { SelfUpdateRecord } from "../shared/domain";
import { sanitizeExternalURL } from "../shared/security";
import { compareVersions, version, type VersionValue } from "../shared/version";

const latestReleaseURL = "https://api.github.com/repos/arshiaghaf/Baseline/releases/latest";
const fallbackReleasePageURL = "https://github.com/arshiaghaf/Baseline/releases/latest";

export class SelfUpdateClient {
  async lookup(currentVersion: VersionValue, checkedAt: string): Promise<SelfUpdateRecord> {
    try {
      const response = await fetch(latestReleaseURL, {
        headers: {
          Accept: "application/vnd.github+json"
        },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) {
        return unavailableSelfUpdate(currentVersion, checkedAt);
      }

      const raw = (await response.json()) as any;
      const latestVersion = version(latestVersionString(raw));
      const releaseURL = sanitizeExternalURL(raw?.html_url) ?? fallbackReleasePageURL;
      return {
        available: isSelfUpdateAvailable(latestVersion, currentVersion),
        currentVersion,
        latestVersion,
        releaseURL,
        checkedAt
      };
    } catch {
      return unavailableSelfUpdate(currentVersion, checkedAt);
    }
  }
}

function latestVersionString(raw: any): string {
  return typeof raw?.tag_name === "string" ? raw.tag_name : "";
}

function isSelfUpdateAvailable(latestVersion: VersionValue, currentVersion: VersionValue): boolean {
  return compareVersions(releaseCoreVersion(latestVersion), releaseCoreVersion(currentVersion)) > 0;
}

function releaseCoreVersion(value: VersionValue): VersionValue {
  const releaseCore = value.raw.trim().match(/^v?(\d+(?:\.\d+)*)/)?.[1];
  return version(releaseCore ?? value.raw);
}

function unavailableSelfUpdate(currentVersion: VersionValue, checkedAt: string): SelfUpdateRecord {
  return {
    available: false,
    currentVersion,
    releaseURL: fallbackReleasePageURL,
    checkedAt
  };
}
