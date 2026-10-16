// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type {
  HomebrewCaskDiscoveryItem,
  HomebrewCaskEntry,
  HomebrewCaskIndex,
  HomebrewLookupResult,
  HomebrewPresentation
} from "../shared/domain";
import { emptyHomebrewCaskIndex, homebrewDiscoverID } from "../shared/domain";
import { byteLimits, isValidHomebrewToken, sanitizeExternalURL } from "../shared/security";
import { compareVersions, isVersionGreater, type VersionValue, version } from "../shared/version";
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

export class HomebrewCaskClient {
  private decoded?: CatalogueDecodeStatus;
  private readonly searchIndexes = new WeakMap<
    HomebrewCaskIndex,
    Array<{ entry: HomebrewCaskEntry; terms: CatalogueSearchTerms }>
  >();
  private readonly cache: CatalogueCache<HomebrewCaskIndex>;

  constructor(options: { storage?: CatalogueStorage } = {}) {
    this.cache = new CatalogueCache(
      "https://formulae.brew.sh/api/cask.json",
      emptyHomebrewCaskIndex,
      byteLimits.homebrewCaskIndexMaxBytes,
      (data) => this.parseIndex(data, { strictCatalogue: true }),
      options.storage
    );
  }

  get cacheStatus() {
    return { ...this.cache.status, ...(this.decoded ? { decode: this.decoded } : {}) };
  }

  fetchIndex(options: CatalogueFetchOptions = {}): Promise<HomebrewCaskIndex> {
    return this.cache.fetch(options);
  }

  lookupUpdate(
    bundleIdentifier: string | undefined,
    appBundleName: string,
    localVersion: VersionValue,
    index: HomebrewCaskIndex
  ): HomebrewLookupResult | undefined {
    const byBundle = bundleIdentifier
      ? index.byBundleIdentifier[bundleIdentifier.toLowerCase()]
      : undefined;
    if (byBundle && isVersionGreater(byBundle.version, localVersion)) {
      return this.lookupResult(byBundle);
    }

    const normalizedName = normalizeAppBundleName(appBundleName);
    const candidates = normalizedName ? [...(index.byAppBundleName[normalizedName] ?? [])] : [];
    if (candidates.length === 0) {
      return undefined;
    }

    const tokenHint = normalizedName ? tokenHintForAppBundleName(normalizedName) : undefined;
    const related = tokenHint
      ? candidates.filter((entry) => isTokenRelated(entry.token, tokenHint))
      : [];
    const entry = pickPreferredEntry(related.length ? related : candidates);
    if (!entry || !isVersionGreater(entry.version, localVersion)) {
      return undefined;
    }
    return this.lookupResult(entry);
  }

  searchCasks(
    query: string,
    index: HomebrewCaskIndex,
    excludingTokens: Set<string>
  ): HomebrewCaskDiscoveryItem[] {
    const compactQuery = compactCatalogueText(query);
    if (!compactQuery) {
      return [];
    }

    let entries = this.searchIndexes.get(index);
    if (!entries) {
      entries = deduplicatedEntries(index).map((entry) => ({
        entry,
        terms: {
          token: compactCatalogueText(entry.token),
          names: [
            displayName(entry),
            ...entry.appBundleNames.map((name) => name.replace(/\.app$/iu, ""))
          ].map(compactCatalogueText)
        }
      }));
      this.searchIndexes.set(index, entries);
    }
    return entries
      .filter(({ entry }) => !excludingTokens.has(entry.token.toLowerCase()))
      .map(({ entry, terms }) => ({ entry, rank: catalogueSearchRank(terms, compactQuery) }))
      .filter(({ rank }) => rank >= 0)
      .sort((lhs, rhs) => lhs.rank - rhs.rank || compareEntries(lhs.entry, rhs.entry))
      .slice(0, 12)
      .map(({ entry, rank }) =>
        rankedCatalogueItem(
          {
            id: homebrewDiscoverID("cask", entry.token),
            kind: "cask",
            token: entry.token,
            displayName: displayName(entry),
            presentation: entry.presentation,
            version: entry.version,
            homepageURL:
              sanitizeExternalURL(`https://formulae.brew.sh/cask/${entry.token}`) ??
              entry.homepageURL
          },
          compactQuery,
          rank
        )
      );
  }

  // Installed metadata also uses this mapper. Strict catalogue admission must not
  // reject a healthy inventory kind because of unrelated optional installed fields.
  parseIndex(data: Buffer, options: { strictCatalogue?: boolean } = {}): HomebrewCaskIndex {
    if (data.byteLength > byteLimits.homebrewCaskIndexMaxBytes) {
      return emptyHomebrewCaskIndex;
    }

    const raw = decodeCatalogue(data);
    const status = decodeStatus(raw.length);
    const byToken: Record<string, HomebrewCaskEntry> = Object.create(null);
    const byBundleIdentifier: Record<string, HomebrewCaskEntry> = Object.create(null);
    const byAppBundleName: Record<string, HomebrewCaskEntry[]> = Object.create(null);

    for (const rawItem of raw) {
      const item = rawItem as any;
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        (options.strictCatalogue && !catalogueEntryIsBounded(item)) ||
        typeof item.token !== "string" ||
        !isValidHomebrewToken(item.token)
      ) {
        status.skippedEntries++;
        continue;
      }
      const token = item.token;
      if (
        (item.version !== undefined && typeof item.version !== "string") ||
        (item.artifacts !== undefined && !Array.isArray(item.artifacts)) ||
        (item.homepage !== undefined && item.homepage !== null && typeof item.homepage !== "string")
      )
        status.schemaWarnings++;

      const entry: HomebrewCaskEntry = {
        token,
        fullToken: typeof item.full_token === "string" ? item.full_token : token,
        tap: typeof item.tap === "string" ? item.tap : "homebrew/cask",
        version: version(comparableVersion(item?.version)),
        homepageURL: sanitizeExternalURL(item?.homepage),
        presentation: classifyCaskPresentation(item),
        ...extractBundleIdentifierMetadata(item),
        appBundleNames: extractAppBundleNames(item),
        ...extractInstalledAppPaths(item)
      };
      byToken[token.toLowerCase()] = entry;

      for (const identifier of entry.bundleIdentifiers) {
        indexBundleIdentifier(byBundleIdentifier, identifier, entry);
      }

      for (const appName of entry.appBundleNames) {
        byAppBundleName[appName] = [...(byAppBundleName[appName] ?? []), entry];
      }
    }

    for (const [key, entries] of Object.entries(byAppBundleName)) {
      const deduped = new Map<string, HomebrewCaskEntry>();
      for (const entry of entries) {
        deduped.set(entry.token.toLowerCase(), entry);
      }
      byAppBundleName[key] = [...deduped.values()].sort(compareEntries);
    }

    if (options.strictCatalogue) requireUsableCatalogue(status);
    this.decoded = status;
    return { byToken, byBundleIdentifier, byAppBundleName };
  }

  private lookupResult(entry: HomebrewCaskEntry): HomebrewLookupResult {
    return {
      remoteVersion: entry.version,
      token: entry.token,
      homepageURL:
        entry.tap && entry.tap !== "homebrew/cask"
          ? entry.homepageURL
          : (sanitizeExternalURL(`https://formulae.brew.sh/cask/${entry.token}`) ??
            entry.homepageURL)
    };
  }
}

function extractBundleIdentifierMetadata(
  object: any
): Pick<HomebrewCaskEntry, "bundleIdentifiers" | "inferredBundleIdentifiers"> {
  const explicit = new Set<string>();
  const quit = new Set<string>();
  walk(object, (key, value) => {
    if (
      key === "bundle_id" ||
      key === "bundle_ids" ||
      key === "bundle_identifier" ||
      key === "bundleIdentifier"
    ) {
      if (typeof value === "string") {
        explicit.add(value);
      } else if (Array.isArray(value)) {
        value.filter((entry) => typeof entry === "string").forEach((entry) => explicit.add(entry));
      }
    } else if (key === "quit") {
      if (typeof value === "string") {
        quit.add(value);
      } else if (Array.isArray(value)) {
        value.filter((entry) => typeof entry === "string").forEach((entry) => quit.add(entry));
      }
    }
  });
  if (explicit.size > 0 || hasExplicitAppArtifactName(object)) {
    return { bundleIdentifiers: [...explicit].sort() };
  }
  if (isPackageBackedAppCandidate(object)) {
    return { bundleIdentifiers: [], inferredBundleIdentifiers: [...quit].sort() };
  }
  return { bundleIdentifiers: [] };
}

function indexBundleIdentifier(
  byBundleIdentifier: Record<string, HomebrewCaskEntry>,
  identifier: string,
  entry: HomebrewCaskEntry
): void {
  const key = identifier.toLowerCase();
  const existing = byBundleIdentifier[key];
  if (!existing || compareVersions(entry.version, existing.version) >= 0) {
    byBundleIdentifier[key] = entry;
  }
}

function extractInstalledAppPaths(object: any): Pick<HomebrewCaskEntry, "installedAppPaths"> {
  const paths = new Set<string>();
  for (const artifact of Array.isArray(object?.artifacts) ? object.artifacts : []) {
    if (!artifact || typeof artifact !== "object" || (!artifact.app && !artifact.apps)) continue;
    // Only installed app artifact targets are ownership evidence; delete/zap paths are not.
    const add = (value: unknown) => {
      if (
        typeof value === "string" &&
        value.startsWith("/") &&
        value.toLowerCase().endsWith(".app")
      )
        paths.add(value);
    };
    add(artifact.target);
    walk(artifact.app ?? artifact.apps, (key, value) => {
      if (key === "target") add(value);
    });
  }
  return paths.size ? { installedAppPaths: [...paths].sort() } : {};
}

function extractAppBundleNames(object: any): string[] {
  const found = new Set<string>();
  const addNormalized = (value: string, options: { requireAppSuffix?: boolean } = {}) => {
    if (options.requireAppSuffix && !value.trim().toLowerCase().endsWith(".app")) {
      return;
    }
    const normalized = normalizeAppBundleName(value);
    if (normalized) found.add(normalized);
  };
  walk(object, (key, value) => {
    if (["app", "apps", "login_item"].includes(key)) {
      if (typeof value === "string") {
        addNormalized(value);
      } else if (Array.isArray(value)) {
        value.filter((entry) => typeof entry === "string").forEach((entry) => addNormalized(entry));
      }
    } else if (key === "target") {
      stringValues(value).forEach((entry) => addNormalized(entry, { requireAppSuffix: true }));
    } else if (key === "delete") {
      stringValues(value).forEach((entry) => addNormalized(entry, { requireAppSuffix: true }));
    }
  });
  return [...found].sort();
}

function walk(value: any, visitor: (key: string, value: any) => void): void {
  const pending = [value];
  let visited = 0;
  while (pending.length && ++visited <= 20_000) {
    const current = pending.pop();
    if (Array.isArray(current)) pending.push(...current);
    else if (current && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        visitor(key, child);
        pending.push(child);
      }
    }
  }
}

function hasExplicitAppArtifactName(object: any): boolean {
  let found = false;
  walk(object, (key, value) => {
    if (found || !["app", "apps"].includes(key)) {
      return;
    }
    if (typeof value === "string") {
      found = normalizeAppBundleName(value) !== undefined;
    } else if (Array.isArray(value)) {
      found = value.some((entry) => typeof entry === "string" && normalizeAppBundleName(entry));
    }
  });
  return found;
}

function hasPackageBackedAppNameHint(object: any): boolean {
  let found = false;
  walk(object, (key, value) => {
    if (found || key !== "login_item") {
      return;
    }
    if (typeof value === "string") {
      found = normalizeAppBundleName(value) !== undefined;
    } else if (Array.isArray(value)) {
      found = value.some((entry) => typeof entry === "string" && normalizeAppBundleName(entry));
    }
  });
  return found;
}

function isPackageBackedAppCandidate(object: any): boolean {
  if (!hasArtifactKey(object, "pkg") || hasExplicitAppArtifactName(object)) {
    return false;
  }
  if (hasPackageBackedAppNameHint(object) || hasDeletedAppPathHint(object)) {
    return true;
  }
  return !hasTargetArtifactName(object);
}

function classifyCaskPresentation(object: any): HomebrewPresentation {
  if (hasAppArtifactEvidence(object)) {
    return "app";
  }
  if (hasCliArtifactEvidence(object)) {
    return "cli";
  }
  if (hasArtifactKey(object, "pkg")) {
    return "package";
  }
  return "cask";
}

function hasAppArtifactEvidence(object: any): boolean {
  return (
    hasExplicitAppArtifactName(object) ||
    hasPackageBackedAppNameHint(object) ||
    hasDeletedAppPathHint(object) ||
    hasTargetAppPathHint(object)
  );
}

function hasTargetAppPathHint(object: any): boolean {
  let found = false;
  walk(object, (key, value) => {
    if (found || key !== "target") {
      return;
    }
    found = stringValues(value).some((entry) => entry.trim().toLowerCase().endsWith(".app"));
  });
  return found;
}

function hasCliArtifactEvidence(object: any): boolean {
  const cliArtifactKeys = [
    "binary",
    "manpage",
    "bash_completion",
    "zsh_completion",
    "fish_completion",
    "generate_completions_from_executable"
  ];
  return cliArtifactKeys.some((artifactKey) => hasArtifactKey(object, artifactKey));
}

function hasDeletedAppPathHint(object: any): boolean {
  let found = false;
  walk(object, (key, value) => {
    if (found || key !== "delete") {
      return;
    }
    found = stringValues(value).some((entry) => entry.trim().toLowerCase().endsWith(".app"));
  });
  return found;
}

function hasTargetArtifactName(object: any): boolean {
  let found = false;
  walk(object, (key, value) => {
    if (found || key !== "target") {
      return;
    }
    found = stringValues(value).some((entry) => normalizeAppBundleName(entry));
  });
  return found;
}

function hasArtifactKey(object: any, artifactKey: string): boolean {
  return Array.isArray(object?.artifacts)
    ? object.artifacts.some(
        (artifact: unknown) => artifact && typeof artifact === "object" && artifactKey in artifact
      )
    : false;
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function comparableVersion(raw: unknown): string {
  return typeof raw === "string" ? (raw.split(",")[0]?.trim() ?? "") : "";
}

function normalizeAppBundleName(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const filename = trimmed.split("/").at(-1) ?? trimmed;
  return filename.toLowerCase().endsWith(".app")
    ? filename.toLowerCase()
    : `${filename.toLowerCase()}.app`;
}

function tokenHintForAppBundleName(appBundleName: string): string {
  return appBundleName
    .replace(/\.app$/iu, "")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-|-$/gu, "");
}

function isTokenRelated(token: string, hint: string): boolean {
  const parts = canonicalTokenParts(token);
  return (
    parts.includes(hint) ||
    parts.some((part) => part.startsWith(`${hint}-`) || part.startsWith(`${hint}@`))
  );
}

function canonicalTokenParts(token: string): string[] {
  return token
    .toLowerCase()
    .split("/")
    .flatMap((part) => part.split(/[._+]/gu))
    .filter(Boolean);
}

function pickPreferredEntry(entries: HomebrewCaskEntry[]): HomebrewCaskEntry | undefined {
  return [...entries].sort(compareEntries)[0];
}

function compareEntries(lhs: HomebrewCaskEntry, rhs: HomebrewCaskEntry): number {
  const versionOrder = compareVersions(rhs.version, lhs.version);
  return versionOrder || lhs.token.localeCompare(rhs.token);
}

function deduplicatedEntries(index: HomebrewCaskIndex): HomebrewCaskEntry[] {
  const map = new Map<string, HomebrewCaskEntry>();
  for (const entry of [
    ...Object.values(index.byToken),
    ...Object.values(index.byBundleIdentifier),
    ...Object.values(index.byAppBundleName).flat()
  ]) {
    map.set(entry.token.toLowerCase(), entry);
  }
  return [...map.values()];
}

function displayName(entry: HomebrewCaskEntry): string {
  const appName = entry.appBundleNames[0]?.replace(/\.app$/iu, "");
  return appName || entry.token;
}
