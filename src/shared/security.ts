import { isIP } from "node:net";

export const byteLimits = {
  appStoreLookupMaxBytes: 1 * 1024 * 1024,
  sparkleAppcastMaxBytes: 2 * 1024 * 1024,
  homebrewIndexMaxBytes: 25 * 1024 * 1024
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

  if (first === 10 || first === 127) {
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
  return (
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  );
}
