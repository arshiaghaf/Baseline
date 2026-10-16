// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { HomebrewCaskDiscoveryItem } from "../shared/domain";

export function compactCatalogueText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

export type CatalogueSearchTerms = { token: string; names: string[]; description?: string };

// The same scale applies to both kinds; exact names outrank prefixes/substrings.
export function catalogueSearchRank(terms: CatalogueSearchTerms, query: string): number {
  if (terms.token === query || terms.names.includes(query)) return 0;
  if (terms.token.startsWith(query) || terms.names.some((name) => name.startsWith(query))) return 1;
  if (terms.token.includes(query) || terms.names.some((name) => name.includes(query))) return 2;
  if (terms.description?.includes(query)) return 3;
  return -1;
}

// Keep scores out of the shared/renderer contract. Search results are immutable projections.
const ranks = new WeakMap<HomebrewCaskDiscoveryItem, { query: string; rank: number }>();

export function rankedCatalogueItem(
  item: HomebrewCaskDiscoveryItem,
  query: string,
  rank: number
): HomebrewCaskDiscoveryItem {
  ranks.set(item, { query, rank });
  return item;
}

export function mergeCatalogueSearchResults(
  query: string,
  casks: HomebrewCaskDiscoveryItem[],
  formulae: HomebrewCaskDiscoveryItem[],
  limit = 18
): HomebrewCaskDiscoveryItem[] {
  const compact = compactCatalogueText(query);
  if (!compact) return [];
  const rank = (item: HomebrewCaskDiscoveryItem) => {
    const scored = ranks.get(item);
    return scored?.query === compact
      ? scored.rank
      : catalogueSearchRank(
          {
            token: compactCatalogueText(item.token),
            names: [compactCatalogueText(item.displayName)]
          },
          compact
        );
  };
  return [...new Map([...casks, ...formulae].map((item) => [item.id, item])).values()]
    .map((item) => ({ item, rank: rank(item) }))
    .filter(({ rank }) => rank >= 0)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.item.token.localeCompare(b.item.token) ||
        a.item.kind.localeCompare(b.item.kind)
    )
    .slice(0, Math.max(0, Math.min(100, Math.floor(limit) || 0)))
    .map(({ item }) => item);
}
