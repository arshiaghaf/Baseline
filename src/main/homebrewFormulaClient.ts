// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type {
  HomebrewCaskDiscoveryItem,
  HomebrewFormulaEntry,
  HomebrewFormulaIndex
} from "../shared/domain";
import { emptyHomebrewFormulaIndex, homebrewDiscoverID } from "../shared/domain";
import { byteLimits, isValidHomebrewToken, sanitizeExternalURL } from "../shared/security";
import { version } from "../shared/version";
import { CatalogueCache, type CatalogueFetchOptions } from "./catalogueCache";
import {
  catalogueEntryIsBounded,
  decodeCatalogue,
  decodeStatus,
  requireUsableCatalogue,
  type CatalogueDecodeStatus
} from "./catalogueDecode";
import {
  compactCatalogueText,
  catalogueSearchRank,
  rankedCatalogueItem,
  type CatalogueSearchTerms
} from "./catalogueSearch";
import type { CatalogueStorage } from "./catalogueStorage";

export class HomebrewFormulaClient {
  private decoded?: CatalogueDecodeStatus;
  private readonly searchIndexes = new WeakMap<
    HomebrewFormulaIndex,
    Array<{ entry: HomebrewFormulaEntry; terms: CatalogueSearchTerms }>
  >();
  private readonly cache: CatalogueCache<HomebrewFormulaIndex>;

  constructor(options: { storage?: CatalogueStorage } = {}) {
    this.cache = new CatalogueCache(
      "https://formulae.brew.sh/api/formula.json",
      emptyHomebrewFormulaIndex,
      byteLimits.homebrewFormulaIndexMaxBytes,
      (data) => this.parseIndex(data),
      options.storage
    );
  }

  get cacheStatus() {
    return { ...this.cache.status, ...(this.decoded ? { decode: this.decoded } : {}) };
  }

  fetchIndex(options: CatalogueFetchOptions = {}): Promise<HomebrewFormulaIndex> {
    return this.cache.fetch(options);
  }

  parseIndex(data: Buffer): HomebrewFormulaIndex {
    if (data.byteLength > byteLimits.homebrewFormulaIndexMaxBytes) {
      return emptyHomebrewFormulaIndex;
    }
    const raw = decodeCatalogue(data);
    const status = decodeStatus(raw.length);
    const byToken: Record<string, HomebrewFormulaEntry> = Object.create(null);
    for (const item of raw) {
      if (
        !catalogueEntryIsBounded(item) ||
        typeof item.name !== "string" ||
        !isValidHomebrewToken(item.name)
      ) {
        status.skippedEntries++;
        continue;
      }
      const token = item.name;
      if (
        (item.versions?.stable !== undefined && typeof item.versions.stable !== "string") ||
        (item.desc !== undefined && item.desc !== null && typeof item.desc !== "string") ||
        (item.homepage !== undefined && item.homepage !== null && typeof item.homepage !== "string")
      )
        status.schemaWarnings++;
      byToken[token.toLowerCase()] = {
        token,
        version: version(stableVersion(item)),
        homepageURL: sanitizeExternalURL(item?.homepage),
        description: typeof item?.desc === "string" ? item.desc : undefined
      };
    }
    requireUsableCatalogue(status);
    this.decoded = status;
    return { byToken };
  }

  searchFormulae(
    query: string,
    index: HomebrewFormulaIndex,
    excludingTokens: Set<string>
  ): HomebrewCaskDiscoveryItem[] {
    const compactQuery = compactCatalogueText(query);
    if (!compactQuery) {
      return [];
    }
    let entries = this.searchIndexes.get(index);
    if (!entries) {
      entries = Object.values(index.byToken).map((entry) => ({
        entry,
        terms: {
          token: compactCatalogueText(entry.token),
          names: [],
          description: compactCatalogueText(entry.description ?? "")
        }
      }));
      this.searchIndexes.set(index, entries);
    }
    return entries
      .filter(({ entry }) => !excludingTokens.has(entry.token.toLowerCase()))
      .map(({ entry, terms }) => ({ entry, rank: catalogueSearchRank(terms, compactQuery) }))
      .filter(({ rank }) => rank >= 0)
      .sort((lhs, rhs) => lhs.rank - rhs.rank || lhs.entry.token.localeCompare(rhs.entry.token))
      .slice(0, 12)
      .map(({ entry, rank }) =>
        rankedCatalogueItem(
          {
            id: homebrewDiscoverID("formula", entry.token),
            kind: "formula",
            token: entry.token,
            displayName: entry.token,
            presentation: "formula",
            version: entry.version,
            homepageURL:
              sanitizeExternalURL(`https://formulae.brew.sh/formula/${entry.token}`) ??
              entry.homepageURL
          },
          compactQuery,
          rank
        )
      );
  }
}

function stableVersion(item: any): string {
  const stable = item?.versions?.stable;
  return typeof stable === "string" ? stable : "";
}
