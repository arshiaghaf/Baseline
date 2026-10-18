// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { AppStoreLookupResult, AppStoreProviderIdentity } from "../shared/domain";
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
  | {
      type: "completed";
      value?: T;
      checkedAt?: string;
      identity?: AppStoreProviderIdentity;
      providerFound?: boolean;
      /** True only when metadata came from bundle discovery rather than a known numeric ID. */
      discovered?: boolean;
    }
  | { type: "transientFailure" };

type LookupOptions = LookupRequestOptions & {
  includeIOSAppStoreSoftware?: boolean;
  includeMacCapableAppStoreSoftware?: boolean;
  identity?: AppStoreProviderIdentity;
};
export type AppStoreLookupRequest = {
  bundleIdentifier: string;
  localVersion: VersionValue;
  platform: "mac" | "ios";
  identity?: AppStoreProviderIdentity;
};
export type AppStoreBatchLookupOptions = LookupRequestOptions & {
  onOutcome?: (index: number, outcome: LookupOutcome<AppStoreLookupResult>) => void;
};
export type AppStoreLookupSource = Pick<AppStoreLookupClient, "lookupOutcome"> &
  Partial<Pick<AppStoreLookupClient, "lookupOutcomes" | "storefront">>;

type Scope = { platform: "mac" | "ios"; storefront: string };
type Query = Scope & { entity?: "desktopSoftware" | "macSoftware" | "software" };
type CheckedEntries = { entries: LookupEntry[]; checkedAt?: string };
const maxBatchIdentifiers = 32;
const maxBatchURLLength = 4000;

export class AppStoreLookupClient {
  // Cache metadata, never an installed-version comparison. Manual refreshes
  // bypass both positive and negative freshness while sharing in-flight work.
  private readonly cache = new LookupCache(3100, (data) => {
    const response = JSON.parse(data.toString("utf8")) as { results: LookupEntry[] };
    return response.results.length ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000;
  });
  readonly storefront: string;

  constructor(storefront = "us") {
    this.storefront = normalizeStorefront(storefront) ?? "us";
  }

  async lookupOutcomes(
    requests: AppStoreLookupRequest[],
    options: AppStoreBatchLookupOptions = {}
  ): Promise<LookupOutcome<AppStoreLookupResult>[]> {
    const outcomes: LookupOutcome<AppStoreLookupResult>[] = requests.map(() => ({
      type: "transientFailure"
    }));
    const assigned = new Set<number>();
    const assignOutcome = (index: number, outcome: LookupOutcome<AppStoreLookupResult>) => {
      if (assigned.has(index)) return;
      assigned.add(index);
      outcomes[index] = outcome;
      try {
        options.onOutcome?.(index, outcome);
      } catch {
        // Observers do not affect whether source metadata was verified.
      }
    };
    const groups = new Map<string, { query: Query; numeric: boolean; indices: number[] }>();
    for (const [index, request] of requests.entries()) {
      if (!validBundleIdentifier(request.bundleIdentifier)) continue;
      const identity = verifiedIdentity(request.identity, request.platform, this.storefront);
      const scope = {
        platform: request.platform,
        storefront: this.storefront
      };
      const query = { ...scope, entity: primaryEntity(scope.platform) };
      const key = `${scope.platform}:${scope.storefront}:${Boolean(identity)}`;
      const group = groups.get(key) ?? { query, numeric: Boolean(identity), indices: [] };
      group.indices.push(index);
      groups.set(key, group);
    }
    await Promise.all(
      [...groups.values()].map(async ({ query, numeric, indices }) => {
        const identifier = (index: number) =>
          numeric
            ? String(requests[index]!.identity!.productID)
            : requests[index]!.bundleIdentifier.toLowerCase();
        const identifiers = [...new Set(indices.map(identifier))].sort();
        const batches: string[][] = [];
        let batch: string[] = [];
        for (const id of identifiers) {
          if (
            batch.length >= maxBatchIdentifiers ||
            lookupURL([...batch, id], numeric, query).length > maxBatchURLLength
          ) {
            batches.push(batch);
            batch = [];
          }
          batch.push(id);
        }
        if (batch.length) batches.push(batch);
        await Promise.all(
          batches.map(async (ids) => {
            const selected = indices.filter((index) => ids.includes(identifier(index)));
            let checked: CheckedEntries | undefined;
            if (ids.length > 1) {
              try {
                checked = await this.load(ids, numeric, query, options);
              } catch {
                // Bulk errors and omissions are unconfirmed, never negatives.
              }
            }
            await Promise.all(
              selected.map(async (index) => {
                const request = requests[index]!;
                if (options.signal?.aborted) return;
                const entries = checked?.entries.filter((entry) =>
                  matches(entry, request, numeric)
                );
                const selected = entries && selectEntry(entries, query);
                if (selected) {
                  assignOutcome(
                    index,
                    makeOutcome(selected, request, query, !numeric, checked!.checkedAt)
                  );
                  return;
                }
                assignOutcome(index, await this.lookupRequest(request, query, options));
              })
            );
          })
        );
      })
    );
    for (const index of requests.keys()) assignOutcome(index, outcomes[index]!);
    return outcomes;
  }

  async lookupOutcome(
    bundleIdentifier: string,
    localVersion: VersionValue,
    options: LookupOptions = {}
  ): Promise<LookupOutcome<AppStoreLookupResult>> {
    const platform = options.includeIOSAppStoreSoftware ? "ios" : "mac";
    const identity = verifiedIdentity(options.identity, platform, this.storefront);
    return this.lookupRequest(
      { bundleIdentifier, localVersion, platform, identity },
      {
        platform,
        storefront: this.storefront,
        entity: primaryEntity(platform)
      },
      options
    );
  }

  private async lookupRequest(
    request: AppStoreLookupRequest,
    query: Query,
    options: LookupRequestOptions
  ): Promise<LookupOutcome<AppStoreLookupResult>> {
    try {
      if (!validBundleIdentifier(request.bundleIdentifier)) throw new Error("Invalid bundle ID");
      const identity = verifiedIdentity(request.identity, request.platform, this.storefront);
      // Individually confirm known numeric IDs before rediscovering a missing
      // product by bundle ID. Never carry an old numeric ID into a new match.
      if (identity) {
        const checked = await this.load([String(identity.productID)], true, query, options);
        const selected = confirmedEntry(
          checked.entries.filter((entry) => matches(entry, request, true)),
          query
        );
        if (selected) return makeOutcome(selected, request, query, false, checked.checkedAt);
      }
      const queries: Query[] = [query];
      queries.push({ ...query, entity: request.platform === "mac" ? "macSoftware" : undefined });
      let checkedAt: string | undefined;
      for (const current of queries) {
        options.signal?.throwIfAborted();
        const checked = await this.load(
          [request.bundleIdentifier.toLowerCase()],
          false,
          current,
          options
        );
        checkedAt = checked.checkedAt;
        const selected = confirmedEntry(
          checked.entries.filter((entry) => matches(entry, request, false)),
          current
        );
        if (selected) return makeOutcome(selected, request, current, true, checked.checkedAt);
      }
      return { type: "completed", checkedAt, value: undefined, discovered: true };
    } catch {
      return { type: "transientFailure" };
    }
  }

  private async load(
    identifiers: string[],
    numeric: boolean,
    query: Query,
    options: LookupRequestOptions
  ): Promise<CheckedEntries> {
    const url = lookupURL(identifiers, numeric, query);
    const data = await this.cache.get(
      url,
      async (signal) => {
        const response = await fetch(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)])
        });
        if (!response.ok) {
          if (response.status === 429) this.cache.backoff(url, response.headers.get("retry-after"));
          throw new Error("Lookup unavailable");
        }
        const data = Buffer.from(await response.arrayBuffer());
        validateResponse(data, identifiers, numeric);
        return data;
      },
      options
    );
    return {
      entries: validateResponse(data, identifiers, numeric),
      checkedAt: this.cache.checkedAt(url)
    };
  }

  parseLookupResponse(
    data: Buffer,
    localVersion: VersionValue,
    options: LookupOptions & { bundleIdentifier?: string } = {}
  ): AppStoreLookupResult | undefined {
    if (data.byteLength > byteLimits.appStoreLookupMaxBytes) return undefined;
    const response = JSON.parse(data.toString("utf8")) as { results?: LookupEntry[] };
    if (!Array.isArray(response.results) || !options.bundleIdentifier) return undefined;
    const query: Query = {
      platform: options.includeIOSAppStoreSoftware ? "ios" : "mac",
      storefront: this.storefront,
      entity: options.includeIOSAppStoreSoftware ? "software" : "desktopSoftware"
    };
    const request = {
      bundleIdentifier: options.bundleIdentifier,
      localVersion,
      platform: query.platform
    };
    const selected = selectEntry(
      response.results.filter((entry) => matches(entry, request, false)),
      query
    );
    return selected ? updateValue(selected, localVersion) : undefined;
  }
}

function normalizeStorefront(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z]{2}$/i.test(value) ? value.toLowerCase() : undefined;
}
function verifiedIdentity(
  identity: AppStoreProviderIdentity | undefined,
  platform: "mac" | "ios",
  currentStorefront: string
): AppStoreProviderIdentity | undefined {
  const storefront = normalizeStorefront(identity?.storefront);
  return identity &&
    positiveID(identity.productID) &&
    identity.platform === platform &&
    storefront === currentStorefront
    ? { ...identity, storefront }
    : undefined;
}
function positiveID(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function validBundleIdentifier(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,255}$/.test(value);
}
function primaryEntity(platform: "mac" | "ios"): "desktopSoftware" | "software" {
  return platform === "mac" ? "desktopSoftware" : "software";
}
function matches(entry: LookupEntry, request: AppStoreLookupRequest, numeric: boolean): boolean {
  return (
    isLookupEntry(entry) &&
    entry.bundleId!.toLowerCase() === request.bundleIdentifier.toLowerCase() &&
    (!numeric || entry.trackId === request.identity?.productID)
  );
}
function eligibleEntries(entries: LookupEntry[], query: Query): LookupEntry[] {
  return entries.filter((entry) =>
    query.platform === "ios"
      ? entry.kind === "software"
      : entry.kind === "mac-software" ||
        (query.entity === "desktopSoftware" &&
          entry.kind === "software" &&
          entry.supportedDevices?.some(
            (device) => typeof device === "string" && device.startsWith("MacDesktop-")
          ))
  );
}
function selectEntry(entries: LookupEntry[], query: Query): LookupEntry | undefined {
  const eligible = eligibleEntries(entries, query);
  // A platform-qualified record is not lower priority because of Apple's kind
  // label. Conflicting platform-qualified versions/identities remain ambiguous.
  return eligible.length === 1 ? eligible[0] : undefined;
}
function confirmedEntry(entries: LookupEntry[], query: Query): LookupEntry | undefined {
  const eligible = eligibleEntries(entries, query);
  if (eligible.length > 1) throw new Error("Ambiguous platform metadata");
  return eligible[0];
}
function makeOutcome(
  selected: LookupEntry,
  request: AppStoreLookupRequest,
  scope: Scope,
  discovered: boolean,
  checkedAt?: string
): LookupOutcome<AppStoreLookupResult> {
  return {
    type: "completed",
    checkedAt,
    discovered,
    value: updateValue(selected, request.localVersion),
    identity: positiveID(selected.trackId)
      ? { productID: selected.trackId, platform: scope.platform, storefront: scope.storefront }
      : undefined
  };
}
function updateValue(
  selected: LookupEntry,
  localVersion: VersionValue
): AppStoreLookupResult | undefined {
  const remoteVersion = version(selected.version);
  if (!isVersionGreater(remoteVersion, localVersion)) return undefined;
  return {
    remoteVersion,
    updateURL: sanitizeExternalURL(selected.trackViewUrl),
    releaseNotesSummary: selected.releaseNotes,
    releaseDate: selected.currentVersionReleaseDate,
    appStoreItemID: positiveID(selected.trackId) ? selected.trackId : undefined
  };
}
function lookupURL(identifiers: string[], numeric: boolean, query: Query): string {
  const url = new URL("https://itunes.apple.com/lookup");
  url.searchParams.set(numeric ? "id" : "bundleId", identifiers.join(","));
  url.searchParams.set("country", query.storefront);
  if (query.entity) url.searchParams.set("entity", query.entity);
  url.searchParams.set("limit", "200");
  return url.href;
}
function validateResponse(data: Buffer, identifiers: string[], numeric: boolean): LookupEntry[] {
  if (data.byteLength > byteLimits.appStoreLookupMaxBytes) throw new Error("Lookup too large");
  const response = JSON.parse(data.toString("utf8"));
  if (
    !Array.isArray(response?.results) ||
    !Number.isSafeInteger(response.resultCount) ||
    response.resultCount !== response.results.length ||
    response.resultCount >= 200
  )
    throw new Error("Invalid lookup response");
  const requested = new Set(identifiers.map((identifier) => identifier.toLowerCase()));
  const seen = new Set<string>();
  for (const entry of response.results) {
    if (
      !isLookupEntry(entry) ||
      !requested.has(numeric ? String(entry.trackId) : entry.bundleId!.toLowerCase())
    )
      throw new Error("Invalid lookup entry");
    const key = `${entry.bundleId!.toLowerCase()}:${entry.kind}`;
    if (seen.has(key)) throw new Error("Ambiguous lookup entry");
    seen.add(key);
  }
  return response.results;
}

function isLookupEntry(value: unknown): value is LookupEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.bundleId === "string" &&
    (entry.kind === "mac-software" || entry.kind === "software") &&
    typeof entry.version === "string" &&
    Boolean(entry.version.trim()) &&
    /\d/.test(entry.version) &&
    (entry.trackId === undefined || positiveID(entry.trackId)) &&
    (entry.supportedDevices === undefined ||
      (Array.isArray(entry.supportedDevices) &&
        entry.supportedDevices.every((device: unknown) => typeof device === "string"))) &&
    [entry.trackViewUrl, entry.releaseNotes, entry.currentVersionReleaseDate].every(
      (field) => field === undefined || typeof field === "string"
    )
  );
}
