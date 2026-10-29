// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isAllowedFeedURL } from "../shared/security";

export type ReleaseNotesResponse = {
  status: number;
  url: string;
  headers: Record<string, string>;
  data: Buffer;
};

export type ReleaseNotesFetcher = (
  url: string,
  options?: { signal?: AbortSignal; maxBytes?: number }
) => Promise<ReleaseNotesResponse>;

/** Only ordinary public HTTPS endpoints are fetched, with no ambient cookies or credentials. */
export function publicNotesURL(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (
      !isAllowedFeedURL(url) ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      url.href.length > 4096 ||
      /\.(?:internal|test|invalid)$/iu.test(url.hostname)
    )
      return undefined;
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    if (isIP(host) && !isPublicNotesAddress(host)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** DNS answers are checked before connecting and the selected address is pinned per request. */
export function isPublicNotesAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const first = Number.parseInt(normalized.split(":")[0] ?? "", 16);
  const second = Number.parseInt(normalized.split(":")[1] || "0", 16);
  // Global unicast only; mapped IPv4, local, multicast and transition ranges are excluded.
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
    !normalized.startsWith("2002:") &&
    !normalized.startsWith("3fff:")
  );
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export const fetchReleaseNotes: ReleaseNotesFetcher = async (raw, options = {}) => {
  const signal = AbortSignal.any(
    [options.signal, AbortSignal.timeout(8000)].filter((value): value is AbortSignal => !!value)
  );
  const limit = Math.min(options.maxBytes ?? 1024 * 1024, 2 * 1024 * 1024);
  let url = publicNotesURL(raw);
  if (!url) throw new Error("Unsafe release notes address");
  for (let redirect = 0; redirect <= 4; redirect++) {
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
    if (!addresses.length || addresses.some(({ address }) => !isPublicNotesAddress(address)))
      throw new Error("Unsafe release notes destination");
    const selected = addresses[0]!;
    const response = await new Promise<ReleaseNotesResponse>((resolve, reject) => {
      const req = request(
        url!,
        {
          agent: false,
          signal,
          family: selected.family,
          lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
          headers: {
            Accept:
              "application/json, application/rss+xml, application/xml, text/html, text/plain;q=0.9",
            "Accept-Encoding": "identity",
            "User-Agent": "Baseline-Release-Notes"
          }
        },
        (res) => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers))
            if (typeof value === "string") headers[key] = value;
          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
            res.destroy();
            resolve({ status: res.statusCode!, headers, data: Buffer.alloc(0), url: url!.href });
            return;
          }
          const encoding = headers["content-encoding"]?.trim().toLowerCase();
          const decoder =
            encoding === "gzip"
              ? createGunzip()
              : encoding === "br"
                ? createBrotliDecompress()
                : encoding === "deflate"
                  ? createInflate()
                  : undefined;
          if (encoding && encoding !== "identity" && !decoder) {
            res.destroy();
            reject(new Error("Unsupported release notes encoding"));
            return;
          }
          const stream = decoder ? res.pipe(decoder) : res;
          const chunks: Buffer[] = [];
          let received = 0;
          let wireBytes = 0;
          const fail = (error: Error) => {
            res.destroy();
            decoder?.destroy();
            req.destroy();
            reject(error);
          };
          res.on("error", fail);
          res.on("aborted", () => fail(new Error("Incomplete release notes response")));
          res.on("data", (chunk: Buffer) => {
            wireBytes += chunk.byteLength;
            if (wireBytes > limit) fail(new Error("Release notes response too large"));
          });
          stream.on("error", fail);
          stream.on("data", (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > limit) return fail(new Error("Release notes content too large"));
            chunks.push(chunk);
          });
          stream.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers,
              data: Buffer.concat(chunks),
              url: url!.href
            })
          );
        }
      );
      req.on("error", reject);
      req.end();
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.location;
    url = location ? publicNotesURL(new URL(location, url).href) : undefined;
    if (!url) throw new Error("Unsafe release notes redirect");
  }
  throw new Error("Too many release notes redirects");
};
