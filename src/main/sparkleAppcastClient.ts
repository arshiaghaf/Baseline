// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { XMLParser } from "fast-xml-parser";
import type { SparkleLookupResult } from "../shared/domain";
import { byteLimits, isAllowedFeedURL, sanitizeExternalURL } from "../shared/security";
import { compareVersions, isVersionEmpty, type VersionValue, version } from "../shared/version";
import type { LookupOutcome } from "./appStoreLookupClient";
import { LookupCache, type LookupRequestOptions } from "./lookupCache";
import { isSparkleVersionNewer, sparkleMarketingVersion } from "../shared/sparkleVersion";

type AppcastItem = {
  shortVersionString?: string;
  buildVersion?: string;
  enclosureURL?: string;
  releaseNotesURL?: string;
  publicationDate?: string;
};

type AppcastCandidate = {
  item: AppcastItem;
  hasMarketingVersion: boolean;
  buildVersion: VersionValue;
  parsedVersion: VersionValue;
  updateURL?: string;
  releaseNotesURL?: string;
};

type FeedMetadata = {
  data: Buffer;
  checkedAt?: string;
};

type RefreshFeeds = {
  entries: Map<string, FeedMetadata>;
  bytes: number;
};

const maxRefreshEntries = 512;
const maxRefreshBytes = 8 * 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false
});

export class SparkleAppcastClient {
  private readonly cache = new LookupCache(1000);
  private readonly decoded = new WeakMap<Buffer, AppcastCandidate[]>();
  // RefreshLifecycle supplies a distinct signal for each refresh generation.
  // Only forced lookups need extra retention: ordinary lookups already reuse
  // LookupCache metadata. Never let an earlier cached read satisfy a forced one.
  private readonly refreshFeeds = new WeakMap<AbortSignal, RefreshFeeds>();

  async lookupOutcome(
    feedURL: string,
    localVersion: VersionValue,
    localBuildVersion?: VersionValue,
    options: LookupRequestOptions = {}
  ): Promise<LookupOutcome<SparkleLookupResult>> {
    if (!isAllowedFeedURL(feedURL)) {
      return { type: "completed" };
    }

    try {
      options.signal?.throwIfAborted();
      const refresh = options.force && options.signal ? this.feedsFor(options.signal) : undefined;
      let metadata = refresh?.entries.get(feedURL);
      if (!metadata) {
        const buffer = await this.cache.get(
          feedURL,
          async (signal) => {
            const response = await fetch(feedURL, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)])
            });
            if (!response.ok) {
              if (response.status === 429)
                this.cache.backoff(feedURL, response.headers.get("retry-after"));
              throw new Error("Appcast unavailable");
            }
            const data = Buffer.from(await response.arrayBuffer());
            if (data.byteLength > byteLimits.sparkleAppcastMaxBytes)
              throw new Error("Appcast too large");
            this.decodeMetadata(data);
            return data;
          },
          options
        );
        options.signal?.throwIfAborted();
        metadata = { data: buffer, checkedAt: this.cache.checkedAt(feedURL) };
        if (refresh) this.rememberFeed(refresh, feedURL, metadata);
      }
      options.signal?.throwIfAborted();
      const candidates = this.decodeMetadata(metadata.data);
      return {
        type: "completed",
        checkedAt: metadata.checkedAt,
        providerFound: candidates.length > 0,
        value: selectUpdate(candidates, localVersion, localBuildVersion)
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

    return selectUpdate(decodeAppcast(data).candidates, localVersion, localBuildVersion);
  }

  private decodeMetadata(data: Buffer): AppcastCandidate[] {
    const cached = this.decoded.get(data);
    if (cached) return cached;
    const decoded = decodeAppcast(data);
    if (!decoded.validChannel) throw new Error("Invalid appcast response");
    this.decoded.set(data, decoded.candidates);
    return decoded.candidates;
  }

  private feedsFor(signal: AbortSignal): RefreshFeeds {
    let feeds = this.refreshFeeds.get(signal);
    if (!feeds) {
      feeds = { entries: new Map(), bytes: 0 };
      this.refreshFeeds.set(signal, feeds);
    }
    return feeds;
  }

  private rememberFeed(feeds: RefreshFeeds, url: string, metadata: FeedMetadata): void {
    const previous = feeds.entries.get(url);
    if (previous) feeds.bytes -= previous.data.byteLength;
    feeds.entries.delete(url);
    feeds.entries.set(url, metadata);
    feeds.bytes += metadata.data.byteLength;
    while (feeds.entries.size > maxRefreshEntries || feeds.bytes > maxRefreshBytes) {
      const oldest = feeds.entries.keys().next().value!;
      feeds.bytes -= feeds.entries.get(oldest)!.data.byteLength;
      feeds.entries.delete(oldest);
    }
  }
}

function selectUpdate(
  decoded: AppcastCandidate[],
  localVersion: VersionValue,
  localBuildVersion?: VersionValue
): SparkleLookupResult | undefined {
  const candidates = decoded.filter((candidate) =>
    isSparkleVersionNewer(
      candidate,
      sparkleMarketingVersion(localVersion, localBuildVersion),
      localBuildVersion
    )
  );
  // Use one comparison domain for the entire pool: switching between
  // marketing and machine versions per pair can produce a cyclic sort.
  const useBuildOrder = candidates.some((candidate) => !candidate.hasMarketingVersion);
  const best = candidates.sort((lhs, rhs) => -compareAppcastItems(lhs, rhs, useBuildOrder))[0];

  if (!best) {
    return undefined;
  }

  return {
    remoteVersion: { ...best.parsedVersion },
    remoteBuildVersion: isVersionEmpty(best.buildVersion) ? undefined : { ...best.buildVersion },
    versionComparison: best.hasMarketingVersion ? "marketing" : "build",
    updateURL: best.updateURL,
    releaseNotesURL: best.releaseNotesURL,
    releaseDate: best.item.publicationDate
  };
}

function usableCandidate(item: AppcastItem): AppcastCandidate | undefined {
  const buildVersion = version(item.buildVersion);
  const parsedVersion = sparkleMarketingVersion(
    version(item.shortVersionString ?? item.buildVersion),
    buildVersion
  );
  const updateURL = sanitizeExternalURL(item.enclosureURL);
  const releaseNotesURL = sanitizeExternalURL(item.releaseNotesURL);
  if (isVersionEmpty(parsedVersion) || (!updateURL && !releaseNotesURL)) return undefined;
  return {
    item,
    hasMarketingVersion: Boolean(item.shortVersionString?.trim()),
    buildVersion,
    parsedVersion,
    updateURL,
    releaseNotesURL
  };
}

function compareAppcastItems(
  lhs: { parsedVersion: VersionValue; buildVersion: VersionValue; hasMarketingVersion: boolean },
  rhs: { parsedVersion: VersionValue; buildVersion: VersionValue; hasMarketingVersion: boolean },
  useBuildOrder: boolean
): number {
  if (useBuildOrder) {
    const lhsHasBuild = !isVersionEmpty(lhs.buildVersion);
    const rhsHasBuild = !isVersionEmpty(rhs.buildVersion);
    // Marketing-only entries cannot be ranked against machine numbers.
    // Prefer comparable machine versions, retaining a marketing-only fallback.
    if (lhsHasBuild !== rhsHasBuild) {
      return lhsHasBuild ? 1 : -1;
    }
    const buildComparison = compareVersions(lhs.buildVersion, rhs.buildVersion);
    if (buildComparison !== 0) {
      return buildComparison;
    }
    if (lhs.hasMarketingVersion !== rhs.hasMarketingVersion) {
      return lhs.hasMarketingVersion ? 1 : -1;
    }
  }
  const versionComparison = compareVersions(lhs.parsedVersion, rhs.parsedVersion);
  if (versionComparison !== 0) {
    return versionComparison;
  }
  return compareVersions(lhs.buildVersion, rhs.buildVersion);
}

function normalizeItem(item: any): AppcastItem {
  return {
    shortVersionString: firstVersionText(
      item?.["sparkle:shortVersionString"],
      item?.["@_sparkle:shortVersionString"],
      item?.enclosure?.["@_sparkle:shortVersionString"]
    ),
    buildVersion: firstVersionText(
      item?.["sparkle:version"],
      item?.["@_sparkle:version"],
      item?.enclosure?.["@_sparkle:version"]
    ),
    enclosureURL: item?.enclosure?.["@_url"],
    releaseNotesURL:
      stringText(item?.["sparkle:releaseNotesLink"]) ?? stringText(item?.releaseNotesLink),
    publicationDate: stringText(item?.pubDate)
  };
}

function firstVersionText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringText(value)?.trim();
    if (text) return text;
  }
  return undefined;
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

/** Decode source metadata once; select a release separately for each installed app. */
function decodeAppcast(data: Buffer): { validChannel: boolean; candidates: AppcastCandidate[] } {
  const parsed = parser.parse(data.toString("utf8"));
  const channel = parsed?.rss?.channel;
  const raw: unknown[] = Array.isArray(channel?.item)
    ? channel.item
    : channel?.item
      ? [channel.item]
      : [];
  return {
    validChannel: Boolean(channel && typeof channel === "object"),
    candidates: raw
      .map(normalizeItem)
      .map(usableCandidate)
      .filter((candidate): candidate is AppcastCandidate => candidate !== undefined)
  };
}
