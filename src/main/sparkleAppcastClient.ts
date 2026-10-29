// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { XMLParser } from "fast-xml-parser";
import type { SparkleLookupResult } from "../shared/domain";
import { byteLimits, isAllowedFeedURL, sanitizeExternalURL } from "../shared/security";
import { compareVersions, isVersionEmpty, type VersionValue, version } from "../shared/version";
import type { LookupOutcome } from "./appStoreLookupClient";
import { LookupCache, type LookupRequestOptions } from "./lookupCache";
import { isSparkleVersionNewer, sparkleMarketingVersion } from "../shared/sparkleVersion";
import type { ReleaseNotesFormat } from "../shared/releaseNotes";

type AppcastItem = {
  shortVersionString?: string;
  buildVersion?: string;
  enclosureURL?: string;
  releaseNotesURL?: string;
  releaseNotesContent?: string;
  releaseNotesFormat?: ReleaseNotesFormat;
  publicationDate?: string;
  channel?: string;
  minimumSystemVersion?: string;
  maximumSystemVersion?: string;
  os?: string;
  validEligibility: boolean;
};

export type SparkleHost = {
  platform: NodeJS.Platform;
  systemVersion?: string;
};

type SparkleSelectionOptions = {
  // Only supply channels backed by explicit evidence for this installed app.
  allowedChannels?: readonly string[];
};

type SparkleLookupOptions = LookupRequestOptions & SparkleSelectionOptions;

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

  constructor(
    private readonly host: SparkleHost = {
      platform: process.platform,
      systemVersion: process.getSystemVersion?.()
    }
  ) {}

  async lookupOutcome(
    feedURL: string,
    localVersion: VersionValue,
    localBuildVersion?: VersionValue,
    options: SparkleLookupOptions = {}
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
        value: selectUpdate(candidates, localVersion, localBuildVersion, this.host, options)
      };
    } catch {
      return { type: "transientFailure" };
    }
  }

  parseAppcast(
    data: Buffer,
    localVersion: VersionValue,
    localBuildVersion?: VersionValue,
    options: SparkleSelectionOptions = {}
  ): SparkleLookupResult | undefined {
    if (data.byteLength > byteLimits.sparkleAppcastMaxBytes) {
      return undefined;
    }

    return selectUpdate(
      decodeAppcast(data).candidates,
      localVersion,
      localBuildVersion,
      this.host,
      options
    );
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
  localBuildVersion: VersionValue | undefined,
  host: SparkleHost,
  options: SparkleSelectionOptions
): SparkleLookupResult | undefined {
  const candidates = decoded.filter(
    (candidate) =>
      isEligible(candidate.item, host, options) &&
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
    updateURLKind: best.updateURL ? "download" : undefined,
    releaseNotesURL: best.releaseNotesURL,
    ...(best.item.releaseNotesContent
      ? {
          releaseNotesContent: best.item.releaseNotesContent,
          releaseNotesFormat: best.item.releaseNotesFormat
        }
      : {}),
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
  lhs: AppcastCandidate,
  rhs: AppcastCandidate,
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
  const buildComparison = compareVersions(lhs.buildVersion, rhs.buildVersion);
  if (buildComparison !== 0) return buildComparison;
  // Shared notes must not let an unusable enclosure hide a valid download for
  // the same release. Newer notes-only releases retain their version ranking.
  return Number(Boolean(lhs.updateURL)) - Number(Boolean(rhs.updateURL));
}

function isEligible(
  item: AppcastItem,
  host: SparkleHost,
  options: SparkleSelectionOptions
): boolean {
  if (!item.validEligibility || host.platform !== "darwin") return false;
  if (item.channel && !options.allowedChannels?.includes(item.channel)) return false;
  if (item.os !== undefined && item.os !== "macos") return false;
  for (const [bound, direction] of [
    [item.minimumSystemVersion, -1],
    [item.maximumSystemVersion, 1]
  ] as const) {
    if (!bound) continue;
    if (!isSystemVersion(bound) || !isSystemVersion(host.systemVersion)) return false;
    if (compareVersions(version(host.systemVersion), version(bound)) === direction) return false;
  }
  return true;
}

function isSystemVersion(value: string | undefined): value is string {
  return value !== undefined && /^\d+(?:\.\d+)*$/.test(value);
}

function normalizeItem(item: any): AppcastItem[] {
  const enclosures = Array.isArray(item?.enclosure) ? item.enclosure : [item?.enclosure];
  return enclosures.map((enclosure: any) => {
    const eligibility = [
      item?.["sparkle:channel"],
      item?.["sparkle:minimumSystemVersion"],
      item?.["sparkle:maximumSystemVersion"],
      enclosure?.["@_sparkle:os"]
    ];
    const [channel, minimumSystemVersion, maximumSystemVersion, os] = eligibility.map((value) =>
      stringText(value)?.trim()
    );
    return {
      shortVersionString: firstVersionText(
        item?.["sparkle:shortVersionString"],
        item?.["@_sparkle:shortVersionString"],
        enclosure?.["@_sparkle:shortVersionString"]
      ),
      buildVersion: firstVersionText(
        item?.["sparkle:version"],
        item?.["@_sparkle:version"],
        enclosure?.["@_sparkle:version"]
      ),
      enclosureURL: enclosure?.["@_url"],
      releaseNotesURL:
        stringText(item?.["sparkle:releaseNotesLink"]) ?? stringText(item?.releaseNotesLink),
      ...inlineReleaseNotes(item),
      publicationDate: stringText(item?.pubDate),
      channel,
      minimumSystemVersion,
      maximumSystemVersion,
      os,
      validEligibility: eligibility.every(
        (value) => value === undefined || stringText(value) !== undefined
      )
    };
  });
}

function inlineReleaseNotes(
  item: any
): Pick<AppcastItem, "releaseNotesContent" | "releaseNotesFormat"> {
  const description = item?.description;
  const format = description?.["@_sparkle:format"] ?? "html";
  const content = stringText(description);
  return content && content.length <= 64_000 && ["html", "plain-text", "markdown"].includes(format)
    ? { releaseNotesContent: content, releaseNotesFormat: format }
    : {};
}

/** Note lookup is exact and read-only; it never creates an actionable update candidate. */
export function exactSparkleReleaseNotes(
  data: Buffer,
  targetVersion: string,
  targetBuildVersion?: string,
  host: SparkleHost = { platform: process.platform, systemVersion: process.getSystemVersion?.() }
): { content?: string; format?: ReleaseNotesFormat; url?: string } | undefined {
  if (data.byteLength > byteLimits.sparkleAppcastMaxBytes) return undefined;
  const parsed = parser.parse(data.toString("utf8"));
  const raw = parsed?.rss?.channel?.item;
  const entries = (Array.isArray(raw) ? raw : raw ? [raw] : []).flatMap(normalizeItem);
  const matches = entries.filter(
    (item) =>
      isEligible(item, host, {}) &&
      (item.shortVersionString ?? item.buildVersion) === targetVersion &&
      (targetBuildVersion === undefined || item.buildVersion === targetBuildVersion)
  );
  // Distinct machine builds sharing one marketing version are ambiguous without a build target.
  if (new Set(matches.map((item) => item.buildVersion)).size > 1) return undefined;
  const match = matches[0];
  return match
    ? {
        content: match.releaseNotesContent,
        format: match.releaseNotesFormat,
        url: sanitizeExternalURL(match.releaseNotesURL)
      }
    : undefined;
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
      .flatMap(normalizeItem)
      .map(usableCandidate)
      .filter((candidate): candidate is AppcastCandidate => candidate !== undefined)
  };
}
