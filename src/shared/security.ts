// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { isIP } from "node:net";

export const byteLimits = {
  appStoreLookupMaxBytes: 1 * 1024 * 1024,
  sparkleAppcastMaxBytes: 2 * 1024 * 1024,
  homebrewCaskIndexMaxBytes: 25 * 1024 * 1024,
  homebrewFormulaIndexMaxBytes: 64 * 1024 * 1024
};

const homebrewTokenSegmentRegex = /^[a-z0-9][a-z0-9+._@-]{0,127}$/;

export function sanitizeExternalURL(raw?: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const url = new URL(raw);
    return isAllowedExternalURL(url) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function isAllowedExternalURL(raw: string | URL): boolean {
  const url = typeof raw === "string" ? safeURL(raw) : raw;
  if (!url) {
    return false;
  }

  return url.protocol === "https:" && Boolean(url.hostname);
}

export function isAllowedFeedURL(raw: string | URL): boolean {
  const url = typeof raw === "string" ? safeURL(raw) : raw;
  if (!url || !isAllowedExternalURL(url)) {
    return false;
  }

  const host = url.hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return false;
  }

  const ipFamily = isIP(host);
  if (ipFamily === 4) {
    return !isDisallowedIPv4(host);
  }
  if (ipFamily === 6) {
    return !isDisallowedIPv6(host);
  }

  return true;
}

export function isValidHomebrewToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed || trimmed !== token) {
    return false;
  }

  const segments = token.split("/");
  if (segments.length !== 1 && segments.length !== 3) {
    return false;
  }

  return segments.every((segment) => homebrewTokenSegmentRegex.test(segment));
}

export function resolvedExecutablePath(
  candidates: string[],
  isExecutable: (path: string) => boolean
): string | undefined {
  for (const candidate of candidates) {
    if (!candidate.startsWith("/") || candidate.endsWith("/env")) {
      continue;
    }
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function brewExecutableCandidates(): string[] {
  return ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
}

export function masExecutableCandidates(): string[] {
  return ["/opt/homebrew/bin/mas", "/usr/local/bin/mas"];
}

function safeURL(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function isDisallowedIPv4(host: string): boolean {
  const bytes = host.split(".").map((part) => Number.parseInt(part, 10));
  const first = bytes[0];
  const second = bytes[1];

  if (first === 0 || first === 10 || first === 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  return first === 172 && second !== undefined && second >= 16 && second <= 31;
}

function isDisallowedIPv6(host: string): boolean {
  const normalized = host.toLowerCase();
  const groups = ipv6Groups(normalized);
  const embeddedIPv4 = groups ? embeddedIPv4Address(groups) : undefined;
  if (embeddedIPv4) {
    return isDisallowedIPv4(embeddedIPv4);
  }
  const firstGroup = groups?.[0];

  return (
    normalized === "::" ||
    normalized === "::1" ||
    (firstGroup !== undefined &&
      ((firstGroup >= 0xfe80 && firstGroup <= 0xfebf) ||
        (firstGroup >= 0xfc00 && firstGroup <= 0xfdff)))
  );
}

function embeddedIPv4Address(groups: number[]): string | undefined {
  const isIPv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isIPv4Translated =
    groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0;
  const isIPv4Compatible = groups.slice(0, 6).every((group) => group === 0);
  const isWellKnownNAT64 =
    groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
  if (!isIPv4Mapped && !isIPv4Translated && !isIPv4Compatible && !isWellKnownNAT64) {
    return undefined;
  }

  const high = groups[6]!;
  const low = groups[7]!;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function ipv6Groups(host: string): number[] | undefined {
  if (host.includes(".")) {
    const lastColon = host.lastIndexOf(":");
    if (lastColon === -1) {
      return undefined;
    }
    const ipv4 = host.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) {
      return undefined;
    }
    const bytes = ipv4.split(".").map((part) => Number.parseInt(part, 10));
    const high = (bytes[0]! << 8) | bytes[1]!;
    const low = (bytes[2]! << 8) | bytes[3]!;
    return ipv6Groups(`${host.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`);
  }

  const compressionParts = host.split("::");
  if (compressionParts.length > 2) {
    return undefined;
  }

  if (compressionParts.length === 2) {
    const [headRaw, tailRaw] = compressionParts as [string, string];
    const head = ipv6GroupList(headRaw);
    const tail = ipv6GroupList(tailRaw);
    if (!head || !tail) {
      return undefined;
    }
    const missing = 8 - head.length - tail.length;
    if (missing < 1) {
      return undefined;
    }
    return [...head, ...Array<number>(missing).fill(0), ...tail];
  }

  const groups = ipv6GroupList(host);
  return groups?.length === 8 ? groups : undefined;
}

function ipv6GroupList(raw: string): number[] | undefined {
  if (!raw) {
    return [];
  }
  const groups = raw.split(":").map((group) => {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) {
      return Number.NaN;
    }
    return Number.parseInt(group, 16);
  });
  return groups.every(Number.isInteger) ? groups : undefined;
}
