// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

export type VersionValue = {
  raw: string;
};

export function version(raw?: string | null): VersionValue {
  return {
    raw: (raw ?? "").trim()
  };
}

type ParsedVersion = {
  core: number[];
  prerelease?: {
    rank: number;
    components: number[];
  };
};

const prereleaseRanks: ReadonlyMap<string, number> = new Map([
  ["dev", 0],
  ["snapshot", 0],
  ["nightly", 0],
  ["canary", 0],
  ["alpha", 1],
  ["a", 1],
  ["beta", 2],
  ["b", 2],
  ["pre", 3],
  ["preview", 3],
  ["rc", 4],
  ["candidate", 4]
] as const);

function numericComponents(value: VersionValue | string | null | undefined): number[] {
  const raw = typeof value === "string" ? value : (value?.raw ?? "");
  const sanitized = raw.trim().replace(/[^0-9]+/g, ".");
  const parsed = sanitized
    .split(".")
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));

  return trimTrailingZeroes(parsed);
}

function parseVersion(value: VersionValue | string | null | undefined): ParsedVersion {
  const raw = typeof value === "string" ? value : (value?.raw ?? "");
  const tokens = [
    ...raw
      .trim()
      .toLowerCase()
      .matchAll(/[a-z]+|\d+/giu)
  ].map(([token]) => token);
  const prereleaseIndex = tokens.findIndex((token, index) => {
    if (!prereleaseRanks.has(token)) {
      return false;
    }
    return tokens.slice(0, index).some((candidate) => /^\d+$/u.test(candidate));
  });

  if (prereleaseIndex < 0) {
    return { core: numericComponents(value) };
  }

  return {
    core: trimTrailingZeroes(
      tokens
        .slice(0, prereleaseIndex)
        .filter((token) => /^\d+$/u.test(token))
        .map((token) => Number.parseInt(token, 10))
        .filter((part) => Number.isFinite(part))
    ),
    prerelease: {
      rank: prereleaseRanks.get(tokens[prereleaseIndex] ?? "") ?? 0,
      components: trimTrailingZeroes(
        tokens
          .slice(prereleaseIndex + 1)
          .filter((token) => /^\d+$/u.test(token))
          .map((token) => Number.parseInt(token, 10))
          .filter((part) => Number.isFinite(part))
      )
    }
  };
}

function trimTrailingZeroes(components: number[]): number[] {
  const trimmed = [...components];
  while (trimmed.at(-1) === 0) {
    trimmed.pop();
  }
  return trimmed;
}

function compareComponents(lhs: number[], rhs: number[]): number {
  const count = Math.max(lhs.length, rhs.length);

  for (let index = 0; index < count; index += 1) {
    const leftValue = lhs[index] ?? 0;
    const rightValue = rhs[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue < rightValue ? -1 : 1;
    }
  }

  return 0;
}

export function compareVersions(lhs: VersionValue | string, rhs: VersionValue | string): number {
  const left = parseVersion(lhs);
  const right = parseVersion(rhs);
  const coreComparison = compareComponents(left.core, right.core);
  if (coreComparison !== 0) {
    return coreComparison;
  }

  if (left.prerelease && !right.prerelease) {
    return -1;
  }
  if (!left.prerelease && right.prerelease) {
    return 1;
  }
  if (left.prerelease && right.prerelease) {
    const rankComparison = left.prerelease.rank - right.prerelease.rank;
    return (
      rankComparison || compareComponents(left.prerelease.components, right.prerelease.components)
    );
  }

  return 0;
}

export function isVersionGreater(lhs: VersionValue | string, rhs: VersionValue | string): boolean {
  return compareVersions(lhs, rhs) > 0;
}

export function isVersionEmpty(value: VersionValue | string | null | undefined): boolean {
  const raw = typeof value === "string" ? value : (value?.raw ?? "");
  return raw.trim().length === 0;
}

export function maxVersion(lhs: VersionValue, rhs: VersionValue): VersionValue {
  return compareVersions(lhs, rhs) >= 0 ? lhs : rhs;
}
