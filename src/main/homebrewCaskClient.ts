// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
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

export class HomebrewCaskClient {
  async fetchIndex(): Promise<HomebrewCaskIndex> {
    try {
      const response = await fetch("https://formulae.brew.sh/api/cask.json", {
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) {
        return emptyHomebrewCaskIndex;
      }
      return this.parseIndex(Buffer.from(await response.arrayBuffer()));
    } catch {
      return emptyHomebrewCaskIndex;
    }
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
    const compactQuery = compactSearchText(query);
    if (!compactQuery) {
      return [];
    }

    return deduplicatedEntries(index)
      .filter((entry) => !excludingTokens.has(entry.token.toLowerCase()))
      .map((entry) => ({ entry, rank: searchRank(entry, compactQuery) }))
      .filter(({ rank }) => rank >= 0)
      .sort((lhs, rhs) => lhs.rank - rhs.rank || compareEntries(lhs.entry, rhs.entry))
      .slice(0, 12)
      .map(({ entry }) => ({
        id: homebrewDiscoverID("cask", entry.token),
        kind: "cask",
        token: entry.token,
        displayName: displayName(entry),
        presentation: entry.presentation,
        version: entry.version,
        homepageURL:
          sanitizeExternalURL(`https://formulae.brew.sh/cask/${entry.token}`) ?? entry.homepageURL
      }));
  }

  parseIndex(data: Buffer): HomebrewCaskIndex {
    if (data.byteLength > byteLimits.homebrewCaskIndexMaxBytes) {
      return emptyHomebrewCaskIndex;
    }

    const raw = JSON.parse(data.toString("utf8")) as any[];
    const byToken: Record<string, HomebrewCaskEntry> = {};
    const byBundleIdentifier: Record<string, HomebrewCaskEntry> = {};
    const byAppBundleName: Record<string, HomebrewCaskEntry[]> = {};

    for (const item of raw) {
      const token = item?.token;
      if (typeof token !== "string" || !isValidHomebrewToken(token)) {
        continue;
      }

      const entry: HomebrewCaskEntry = {
        token,
        version: version(comparableVersion(item?.version)),
        homepageURL: sanitizeExternalURL(item?.homepage),
        presentation: classifyCaskPresentation(item),
        ...extractBundleIdentifierMetadata(item),
        appBundleNames: extractAppBundleNames(item)
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

    return { byToken, byBundleIdentifier, byAppBundleName };
  }

  private lookupResult(entry: HomebrewCaskEntry): HomebrewLookupResult {
    return {
      remoteVersion: entry.version,
      token: entry.token,
      homepageURL:
        sanitizeExternalURL(`https://formulae.brew.sh/cask/${entry.token}`) ?? entry.homepageURL
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
  if (Array.isArray(value)) {
    value.forEach((entry) => walk(entry, visitor));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visitor(key, child);
      walk(child, visitor);
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

function searchRank(entry: HomebrewCaskEntry, compactQuery: string): number {
  const token = compactSearchText(entry.token);
  const names = [displayName(entry), ...entry.appBundleNames].map(compactSearchText);
  if (token === compactQuery) return 0;
  if (token.startsWith(compactQuery)) return 1;
  if (names.some((name) => name.startsWith(compactQuery))) return 2;
  if (token.includes(compactQuery)) return 3;
  if (names.some((name) => name.includes(compactQuery))) return 4;
  return -1;
}

function displayName(entry: HomebrewCaskEntry): string {
  const appName = entry.appBundleNames[0]?.replace(/\.app$/iu, "");
  return appName || entry.token;
}

function compactSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}
