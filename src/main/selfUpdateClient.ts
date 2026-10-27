// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { SelfUpdateRecord } from "../shared/domain";
import { sanitizeExternalURL } from "../shared/security";
import { compareVersions, version, type VersionValue } from "../shared/version";

const latestReleaseURL = "https://api.github.com/repos/arshiaghaf/baseline/releases/latest";
const fallbackReleasePageURL = "https://github.com/arshiaghaf/baseline/releases/latest";

export class SelfUpdateClient {
  constructor(private readonly architecture: string = process.arch) {}

  async lookup(
    currentVersion: VersionValue,
    checkedAt: string,
    signal?: AbortSignal
  ): Promise<SelfUpdateRecord> {
    signal?.throwIfAborted();
    if (this.architecture !== "arm64") {
      return {
        ...unavailableSelfUpdate(currentVersion, checkedAt),
        releaseURL: "https://github.com/arshiaghaf/baseline#install"
      };
    }
    try {
      const response = await fetch(latestReleaseURL, {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json"
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000)
      });
      signal?.throwIfAborted();
      if (!response.ok) {
        return unavailableSelfUpdate(currentVersion, checkedAt);
      }

      const raw = (await response.json()) as any;
      signal?.throwIfAborted();
      const latestVersion = version(latestVersionString(raw));
      const candidateURL = sanitizeExternalURL(raw?.html_url);
      const releaseURL = candidateURL?.startsWith(
        "https://github.com/arshiaghaf/baseline/releases/tag/"
      )
        ? candidateURL
        : fallbackReleasePageURL;
      return {
        available: isSelfUpdateAvailable(latestVersion, currentVersion),
        currentVersion,
        latestVersion,
        releaseURL,
        checkedAt
      };
    } catch {
      signal?.throwIfAborted();
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
