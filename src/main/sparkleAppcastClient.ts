// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { XMLParser } from "fast-xml-parser";
import type { SparkleLookupResult } from "../shared/domain";
import { byteLimits, isAllowedFeedURL, sanitizeExternalURL } from "../shared/security";
import { isVersionEmpty, isVersionGreater, type VersionValue, version } from "../shared/version";
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

export class SparkleAppcastClient {
  async lookupOutcome(
    feedURL: string,
    localVersion: VersionValue
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
      return { type: "completed", value: this.parseAppcast(buffer, localVersion) };
    } catch {
      return { type: "transientFailure" };
    }
  }

  parseAppcast(data: Buffer, localVersion: VersionValue): SparkleLookupResult | undefined {
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
        parsedVersion: version(item.shortVersionString ?? item.buildVersion)
      }))
      .filter(({ parsedVersion }) => !isVersionEmpty(parsedVersion))
      .sort(
        (lhs, rhs) => -1 * (isVersionGreater(lhs.parsedVersion, rhs.parsedVersion) ? 1 : -1)
      )[0];

    if (!best || !isVersionGreater(best.parsedVersion, localVersion)) {
      return undefined;
    }

    const updateURL = sanitizeExternalURL(best.item.enclosureURL);
    const releaseNotesURL = sanitizeExternalURL(best.item.releaseNotesURL);
    if (!updateURL && !releaseNotesURL) {
      return undefined;
    }

    return {
      remoteVersion: best.parsedVersion,
      updateURL,
      releaseNotesURL,
      releaseDate: best.item.publicationDate
    };
  }
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
