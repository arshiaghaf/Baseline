// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { AppStoreLookupResult } from "../shared/domain";
import { byteLimits, sanitizeExternalURL } from "../shared/security";
import { isVersionGreater, type VersionValue, version } from "../shared/version";
import { LookupCache, type LookupRequestOptions } from "./lookupCache";

type LookupEntry = {
  bundleId?: string;
  kind?: string;
  version?: string;
  trackViewUrl?: string;
  trackId?: number;
  releaseNotes?: string;
  currentVersionReleaseDate?: string;
  supportedDevices?: string[];
};

export type LookupOutcome<T> =
  { type: "completed"; value?: T; checkedAt?: string } | { type: "transientFailure" };

type LookupOptions = LookupRequestOptions & {
  includeIOSAppStoreSoftware?: boolean;
  includeMacCapableAppStoreSoftware?: boolean;
};

export class AppStoreLookupClient {
  // Negative catalogue matches are stable enough to reuse across hourly
  // polling. Manual checks bypass freshness; existing products expire sooner.
  private readonly cache = new LookupCache(3100, (data) => {
    const response = JSON.parse(data.toString("utf8")) as { results?: LookupEntry[] };
    return response.results?.length ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000;
  });

  async lookupOutcome(
    bundleIdentifier: string,
    localVersion: VersionValue,
    options: LookupOptions = {}
  ): Promise<LookupOutcome<AppStoreLookupResult>> {
    const url = new URL("https://itunes.apple.com/lookup");
    url.searchParams.set("bundleId", bundleIdentifier);
    if (!options.includeIOSAppStoreSoftware) {
      url.searchParams.set("entity", "macSoftware");
    }

    try {
      const buffer = await this.cache.get(
        url.href,
        async (signal) => {
          const response = await fetch(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(8000)])
          });
          if (!response.ok) {
            if (response.status === 429)
              this.cache.backoff(url.href, response.headers.get("retry-after"));
            throw new Error("Lookup unavailable");
          }
          const data = Buffer.from(await response.arrayBuffer());
          if (data.byteLength > byteLimits.appStoreLookupMaxBytes)
            throw new Error("Lookup too large");
          this.parseLookupResponse(data, localVersion, { ...options, bundleIdentifier });
          return data;
        },
        options
      );
      return {
        type: "completed",
        checkedAt: this.cache.checkedAt(url.href),
        value: this.parseLookupResponse(buffer, localVersion, {
          ...options,
          bundleIdentifier
        })
      };
    } catch {
      return { type: "transientFailure" };
    }
  }

  parseLookupResponse(
    data: Buffer,
    localVersion: VersionValue,
    options: LookupOptions & { bundleIdentifier?: string } = {}
  ): AppStoreLookupResult | undefined {
    if (data.byteLength > byteLimits.appStoreLookupMaxBytes) {
      return undefined;
    }
    const response = JSON.parse(data.toString("utf8")) as { results?: LookupEntry[] };
    const results = response.results ?? [];
    const selected =
      (options.includeIOSAppStoreSoftware
        ? results.find((entry) => isIOSAppStoreSoftware(entry, options.bundleIdentifier))
        : undefined) ??
      results.find((entry) => entry.kind === "mac-software") ??
      (options.includeMacCapableAppStoreSoftware
        ? results.find((entry) => isMacCapableAppStoreSoftware(entry, options.bundleIdentifier))
        : undefined) ??
      (results.length === 1 && !results[0]?.kind ? results[0] : undefined);
    if (!selected) {
      return undefined;
    }

    const remoteVersion = version(selected.version);
    if (!isVersionGreater(remoteVersion, localVersion)) {
      return undefined;
    }

    return {
      remoteVersion,
      updateURL: sanitizeExternalURL(selected.trackViewUrl),
      releaseNotesSummary: selected.releaseNotes,
      releaseDate: selected.currentVersionReleaseDate,
      appStoreItemID: selected.trackId
    };
  }
}

function isIOSAppStoreSoftware(entry: LookupEntry, bundleIdentifier: string | undefined): boolean {
  return (
    entry.kind === "software" && entry.bundleId?.toLowerCase() === bundleIdentifier?.toLowerCase()
  );
}

function isMacCapableAppStoreSoftware(
  entry: LookupEntry,
  bundleIdentifier: string | undefined
): boolean {
  return (
    entry.kind === "software" &&
    entry.bundleId?.toLowerCase() === bundleIdentifier?.toLowerCase() &&
    entry.supportedDevices?.some((device) => device.startsWith("MacDesktop-")) === true
  );
}
