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

export type AppStoreLookupRequest = {
  bundleIdentifier: string;
  localVersion: VersionValue;
  includeIOSAppStoreSoftware?: boolean;
  includeMacCapableAppStoreSoftware?: boolean;
};

export type AppStoreLookupSource = Pick<AppStoreLookupClient, "lookupOutcome"> &
  Partial<Pick<AppStoreLookupClient, "lookupOutcomes">>;

// Leave room below the endpoint's result cap and keep URLs bounded. Lookup
// results still require exact bundle identity and per-consumer platform checks.
const maxBatchIdentifiers = 32;
const maxBatchURLLength = 4000;

export class AppStoreLookupClient {
  // Negative catalogue matches are stable enough to reuse across hourly
  // polling. Manual checks bypass freshness; existing products expire sooner.
  private readonly cache = new LookupCache(3100, (data) => {
    const response = JSON.parse(data.toString("utf8")) as { results?: LookupEntry[] };
    return response.results?.length ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000;
  });

  async lookupOutcomes(
    requests: AppStoreLookupRequest[],
    options: LookupRequestOptions = {}
  ): Promise<LookupOutcome<AppStoreLookupResult>[]> {
    const outcomes = new Array<LookupOutcome<AppStoreLookupResult>>(requests.length);
    try {
      for (const includeIOS of [false, true]) {
        const indices = requests.flatMap((request, index) =>
          Boolean(request.includeIOSAppStoreSoftware) === includeIOS ? [index] : []
        );
        const identifiers = [
          ...new Set(indices.map((index) => requests[index]!.bundleIdentifier))
        ].sort();
        let batch: string[] = [];
        const flush = async () => {
          if (batch.length === 0) return;
          const current = batch;
          batch = [];
          const selected = indices.filter((index) =>
            current.includes(requests[index]!.bundleIdentifier)
          );
          if (current.length > 1) {
            const url = batchURL(current, includeIOS);
            try {
              const buffer = await this.cache.get(
                url,
                async (signal) => {
                  const response = await fetch(url, {
                    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)])
                  });
                  if (!response.ok) {
                    if (response.status === 429)
                      this.cache.backoff(url, response.headers.get("retry-after"));
                    throw new Error("Lookup unavailable");
                  }
                  const data = Buffer.from(await response.arrayBuffer());
                  validateBatch(data, current);
                  return data;
                },
                options
              );
              const entries = validateBatch(buffer, current);
              for (const index of selected) {
                const request = requests[index]!;
                const matches = entries.filter(
                  (entry) =>
                    entry.bundleId!.toLowerCase() === request.bundleIdentifier.toLowerCase()
                );
                outcomes[index] = {
                  type: "completed",
                  checkedAt: this.cache.checkedAt(url),
                  value: this.parseLookupResponse(
                    Buffer.from(JSON.stringify({ results: matches })),
                    request.localVersion,
                    request
                  )
                };
              }
              return;
            } catch {
              // A failed or incompatible bulk response must not turn apps into misses.
              // Individual fallback shares the same host pacing and Retry-After state.
            }
          }
          for (const index of selected) {
            options.signal?.throwIfAborted();
            const request = requests[index]!;
            outcomes[index] = await this.lookupOutcome(
              request.bundleIdentifier,
              request.localVersion,
              { ...request, ...options }
            );
          }
        };
        for (const identifier of identifiers) {
          options.signal?.throwIfAborted();
          if (!/^[A-Za-z0-9._-]{1,255}$/.test(identifier)) {
            await flush();
            batch = [identifier];
            await flush();
            continue;
          }
          if (
            batch.length >= maxBatchIdentifiers ||
            batchURL([...batch, identifier], includeIOS).length > maxBatchURLLength
          )
            await flush();
          batch.push(identifier);
        }
        await flush();
      }
      return outcomes;
    } catch (error) {
      if (options.signal?.aborted) return requests.map(() => ({ type: "transientFailure" }));
      throw error;
    }
  }

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

function batchURL(identifiers: string[], includeIOS: boolean): string {
  const url = new URL("https://itunes.apple.com/lookup");
  url.searchParams.set("bundleId", identifiers.join(","));
  if (!includeIOS) url.searchParams.set("entity", "macSoftware");
  url.searchParams.set("limit", "200");
  return url.href;
}

function validateBatch(data: Buffer, identifiers: string[]): LookupEntry[] {
  if (data.byteLength > byteLimits.appStoreLookupMaxBytes) throw new Error("Lookup too large");
  const response = JSON.parse(data.toString("utf8"));
  if (
    !Array.isArray(response?.results) ||
    !Number.isSafeInteger(response.resultCount) ||
    response.resultCount !== response.results.length ||
    response.resultCount >= 200
  )
    throw new Error("Invalid lookup batch");
  const requested = new Set(identifiers.map((identifier) => identifier.toLowerCase()));
  const seen = new Set<string>();
  for (const entry of response.results) {
    if (
      !entry ||
      typeof entry.bundleId !== "string" ||
      !requested.has(entry.bundleId.toLowerCase()) ||
      !["mac-software", "software"].includes(entry.kind) ||
      typeof entry.version !== "string"
    )
      throw new Error("Invalid lookup entry");
    const key = `${entry.bundleId.toLowerCase()}:${entry.kind}`;
    if (seen.has(key)) throw new Error("Ambiguous lookup entry");
    seen.add(key);
  }
  return response.results;
}
