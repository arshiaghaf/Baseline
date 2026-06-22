// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { XMLParser } from "fast-xml-parser";
import type { SparkleLookupResult } from "../shared/domain";
import { byteLimits, isAllowedFeedURL, sanitizeExternalURL } from "../shared/security";
import {
  compareVersions,
  isVersionEmpty,
  isVersionGreater,
  type VersionValue,
  version
} from "../shared/version";
import type { LookupOutcome } from "./appStoreLookupClient";

type AppcastItem = {
  shortVersionString?: string;
  buildVersion?: string;
  enclosureURL?: string;
  releaseNotesURL?: string;
  publicationDate?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text"
});

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

export class SparkleAppcastClient {
  async lookupOutcome(
    feedURL: string,
    localVersion: VersionValue,
    localBuildVersion?: VersionValue
  ): Promise<LookupOutcome<SparkleLookupResult>> {
    if (!isAllowedFeedURL(feedURL)) {
      return { type: "completed" };
    }

    try {
      const response = await fetch(feedURL, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        return { type: "transientFailure" };
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > byteLimits.sparkleAppcastMaxBytes) {
        return { type: "completed" };
      }
      return {
        type: "completed",
        value: this.parseAppcast(buffer, localVersion, localBuildVersion)
      };
    } catch {
      return { type: "transientFailure" };
    }
  }

  parseAppcast(
    data: Buffer,
    localVersion: VersionValue,
    localBuildVersion?: VersionValue
  ): SparkleLookupResult | undefined {
    if (data.byteLength > byteLimits.sparkleAppcastMaxBytes) {
      return undefined;
    }

    const parsed = parser.parse(data.toString("utf8")) as any;
    const channel = parsed?.rss?.channel;
    const rawItems = Array.isArray(channel?.item)
      ? channel.item
      : channel?.item
        ? [channel.item]
        : [];
    const items = rawItems.map(normalizeItem).filter(Boolean) as AppcastItem[];
    const best = items
      .map((item) => ({
        item,
        buildVersion: version(item.buildVersion),
        parsedVersion: version(item.shortVersionString ?? item.buildVersion)
      }))
      .filter(({ parsedVersion }) => !isVersionEmpty(parsedVersion))
      .filter((candidate) => isAppcastItemNewer(candidate, localVersion, localBuildVersion))
      .sort((lhs, rhs) => -1 * compareAppcastItems(lhs, rhs))[0];

    if (!best) {
      return undefined;
    }

    const updateURL = sanitizeExternalURL(best.item.enclosureURL);
    const releaseNotesURL = sanitizeExternalURL(best.item.releaseNotesURL);
    if (!updateURL && !releaseNotesURL) {
      return undefined;
    }

    return {
      remoteVersion: best.parsedVersion,
      remoteBuildVersion: isVersionEmpty(best.buildVersion) ? undefined : best.buildVersion,
      updateURL,
      releaseNotesURL,
      releaseDate: best.item.publicationDate
    };
  }
}

function compareAppcastItems(
  lhs: { parsedVersion: VersionValue; buildVersion: VersionValue },
  rhs: { parsedVersion: VersionValue; buildVersion: VersionValue }
): number {
  const versionComparison = compareVersions(lhs.parsedVersion, rhs.parsedVersion);
  if (versionComparison !== 0) {
    return versionComparison;
  }
  return compareVersions(lhs.buildVersion, rhs.buildVersion);
}

function isAppcastItemNewer(
  item: { parsedVersion: VersionValue; buildVersion: VersionValue },
  localVersion: VersionValue,
  localBuildVersion?: VersionValue
): boolean {
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

function normalizeItem(item: any): AppcastItem {
  return {
    shortVersionString:
      item?.["@_sparkle:shortVersionString"] ?? item?.enclosure?.["@_sparkle:shortVersionString"],
    buildVersion: item?.["@_sparkle:version"] ?? item?.enclosure?.["@_sparkle:version"],
    enclosureURL: item?.enclosure?.["@_url"],
    releaseNotesURL:
      stringText(item?.["sparkle:releaseNotesLink"]) ?? stringText(item?.releaseNotesLink),
    publicationDate: stringText(item?.pubDate)
  };
}

function stringText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    "#text" in value &&
    typeof (value as any)["#text"] === "string"
  ) {
    return (value as any)["#text"];
  }
  return undefined;
}
