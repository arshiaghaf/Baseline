// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import type {
  HomebrewCaskDiscoveryItem,
  HomebrewFormulaEntry,
  HomebrewFormulaIndex
} from "../shared/domain";
import { emptyHomebrewFormulaIndex, homebrewDiscoverID } from "../shared/domain";
import { byteLimits, isValidHomebrewToken, sanitizeExternalURL } from "../shared/security";
import { version } from "../shared/version";

export class HomebrewFormulaClient {
  async fetchIndex(): Promise<HomebrewFormulaIndex> {
    try {
      const response = await fetch("https://formulae.brew.sh/api/formula.json", {
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) {
        return emptyHomebrewFormulaIndex;
      }
      return this.parseIndex(Buffer.from(await response.arrayBuffer()));
    } catch {
      return emptyHomebrewFormulaIndex;
    }
  }

  parseIndex(data: Buffer): HomebrewFormulaIndex {
    if (data.byteLength > byteLimits.homebrewFormulaIndexMaxBytes) {
      return emptyHomebrewFormulaIndex;
    }
    const raw = JSON.parse(data.toString("utf8")) as any[];
    const byToken: Record<string, HomebrewFormulaEntry> = {};
    for (const item of raw) {
      const token = item?.name;
      if (typeof token !== "string" || !isValidHomebrewToken(token)) {
        continue;
      }
      byToken[token.toLowerCase()] = {
        token,
        version: version(stableVersion(item)),
        homepageURL: sanitizeExternalURL(item?.homepage),
        description: typeof item?.desc === "string" ? item.desc : undefined
      };
    }
    return { byToken };
  }

  searchFormulae(
    query: string,
    index: HomebrewFormulaIndex,
    excludingTokens: Set<string>
  ): HomebrewCaskDiscoveryItem[] {
    const compactQuery = compactSearchText(query);
    if (!compactQuery) {
      return [];
    }
    return Object.values(index.byToken)
      .filter((entry) => !excludingTokens.has(entry.token.toLowerCase()))
      .map((entry) => ({ entry, rank: searchRank(entry, compactQuery) }))
      .filter(({ rank }) => rank >= 0)
      .sort((lhs, rhs) => lhs.rank - rhs.rank || lhs.entry.token.localeCompare(rhs.entry.token))
      .slice(0, 12)
      .map(({ entry }) => ({
        id: homebrewDiscoverID("formula", entry.token),
        kind: "formula",
        token: entry.token,
        displayName: entry.token,
        presentation: "formula",
        version: entry.version,
        homepageURL:
          sanitizeExternalURL(`https://formulae.brew.sh/formula/${entry.token}`) ??
          entry.homepageURL
      }));
  }
}

function stableVersion(item: any): string {
  const stable = item?.versions?.stable;
  return typeof stable === "string" ? stable : "";
}

function searchRank(entry: HomebrewFormulaEntry, compactQuery: string): number {
  const token = compactSearchText(entry.token);
  const description = compactSearchText(entry.description ?? "");
  if (token === compactQuery) return 0;
  if (token.startsWith(compactQuery)) return 1;
  if (token.includes(compactQuery)) return 2;
  if (description.includes(compactQuery)) return 3;
  return -1;
}

function compactSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}
