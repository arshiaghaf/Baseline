// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import {
  compareVersions,
  isVersionEmpty,
  isVersionGreater,
  version,
  type VersionValue
} from "./version";

export function sparkleMarketingVersion(
  displayVersion: VersionValue,
  buildVersion?: VersionValue
): VersionValue {
  const match = /^(.+?)\s+\((\d+(?:\.\d+)*)\)$/u.exec(displayVersion.raw.trim());
  if (
    !match ||
    !buildVersion ||
    !/^\d+(?:\.\d+)*$/u.test(buildVersion.raw.trim()) ||
    compareVersions(match[2]!, buildVersion) !== 0
  ) {
    return displayVersion;
  }
  // Only remove a display annotation corroborated by the machine version.
  return version(match[1]);
}

const prereleaseLabels = new Set([
  "dev",
  "snapshot",
  "nightly",
  "canary",
  "alpha",
  "a",
  "beta",
  "b",
  "pre",
  "preview",
  "rc",
  "candidate"
]);

export function isSparkleVersionNewer(
  item: { parsedVersion: VersionValue; buildVersion: VersionValue; hasMarketingVersion: boolean },
  localVersion: VersionValue,
  localBuildVersion?: VersionValue
): boolean {
  if (!item.hasMarketingVersion && localBuildVersion && !isVersionEmpty(localBuildVersion)) {
    return (
      !isVersionEmpty(item.buildVersion) && isVersionGreater(item.buildVersion, localBuildVersion)
    );
  }
  const marketingVersionComparison = compareVersions(item.parsedVersion, localVersion);
  if (marketingVersionComparison > 0) {
    if (
      isSameCorePrereleasePromotion(item.parsedVersion, localVersion) &&
      localBuildVersion &&
      !isVersionEmpty(localBuildVersion)
    ) {
      return (
        !isVersionEmpty(item.buildVersion) && isVersionGreater(item.buildVersion, localBuildVersion)
      );
    }
    return true;
  }
  if (
    marketingVersionComparison < 0 ||
    !localBuildVersion ||
    isVersionEmpty(localBuildVersion) ||
    isVersionEmpty(item.buildVersion)
  ) {
    return false;
  }
  return isVersionGreater(item.buildVersion, localBuildVersion);
}

function isSameCorePrereleasePromotion(
  remoteVersion: VersionValue,
  localVersion: VersionValue
): boolean {
  const remoteTokens = versionTokens(remoteVersion);
  const localTokens = versionTokens(localVersion);

  return (
    (prereleaseToken(remoteTokens) !== undefined || prereleaseToken(localTokens) !== undefined) &&
    compareVersions(
      releaseCoreVersion(remoteVersion, remoteTokens),
      releaseCoreVersion(localVersion, localTokens)
    ) === 0
  );
}

type VersionToken = {
  text: string;
  index: number;
  isNumeric: boolean;
};

function versionTokens(value: VersionValue): VersionToken[] {
  return [
    ...value.raw
      .trim()
      .toLowerCase()
      .matchAll(/[a-z]+|\d+/giu)
  ].map((match) => ({
    text: match[0],
    index: match.index ?? 0,
    isNumeric: /^\d+$/u.test(match[0])
  }));
}

function prereleaseToken(tokens: VersionToken[]): VersionToken | undefined {
  return tokens.find((token, index) => {
    if (token.isNumeric || !prereleaseLabels.has(token.text)) {
      return false;
    }
    return tokens.slice(0, index).some((candidate) => candidate.isNumeric);
  });
}

function releaseCoreVersion(value: VersionValue, tokens: VersionToken[]): VersionValue {
  const marker = prereleaseToken(tokens);
  return marker ? version(value.raw.slice(0, marker.index)) : value;
}
