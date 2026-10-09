// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

export type CatalogueFetchOptions = { force?: boolean };
export type CatalogueStatus = {
  checkedAt?: string;
  stale: boolean;
  unavailable: boolean;
};

const freshnessMS = 10 * 60 * 1000;
const maxStaleMS = 24 * 60 * 60 * 1000;
const retryDelayMS = 30 * 1000;

// One parsed index per client. Bodies are discarded after parsing; failed
// responses never replace a previously validated index or its validators.
export class CatalogueCache<T> {
  private entry?: {
    value: T;
    checkedAt: number;
    freshUntil: number;
    displayFreshUntil: number;
    cacheControl: string;
    etag?: string;
    modified?: string;
  };
  private task?: Promise<T>;
  private retryAfter = 0;
  private lastRequestFailed = false;
  private uncachedResponse?: { checkedAt: number; freshUntil: number };

  constructor(
    private readonly url: string,
    private readonly empty: T,
    private readonly maxBytes: number,
    private readonly parse: (data: Buffer) => T
  ) {}

  get status(): CatalogueStatus {
    const now = Date.now();
    const metadata = this.entry ?? this.uncachedResponse;
    const usable = metadata && now - metadata.checkedAt <= maxStaleMS;
    return {
      checkedAt: metadata ? new Date(metadata.checkedAt).toISOString() : undefined,
      stale: Boolean(
        usable &&
        (this.lastRequestFailed ||
          now >= (this.entry?.displayFreshUntil ?? this.uncachedResponse!.freshUntil))
      ),
      unavailable: !usable
    };
  }

  async fetch(options: CatalogueFetchOptions = {}): Promise<T> {
    if (this.task) return this.task;
    if (!options.force && this.entry && Date.now() < this.entry.freshUntil) return this.entry.value;
    if (!options.force && Date.now() < this.retryAfter) return this.lastGood();
    const task = this.revalidate();
    this.task = task;
    try {
      return await task;
    } finally {
      if (this.task === task) this.task = undefined;
    }
  }

  private lastGood(): T {
    return this.entry && Date.now() - this.entry.checkedAt <= maxStaleMS
      ? this.entry.value
      : this.empty;
  }

  private async revalidate(): Promise<T> {
    try {
      const headers: Record<string, string> = {};
      if (this.entry?.etag) headers["If-None-Match"] = this.entry.etag;
      if (this.entry?.modified) headers["If-Modified-Since"] = this.entry.modified;
      const response = await fetch(this.url, { headers, signal: AbortSignal.timeout(12000) });
      const checkedAt = Date.now();
      const cacheControl =
        response.headers.get("cache-control") ??
        (response.status === 304 ? this.entry?.cacheControl : undefined) ??
        "";
      const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl)?.[1];
      const mustRevalidate = /(?:^|,)\s*(?:no-cache|no-store)\b/i.test(cacheControl);
      const ttl = mustRevalidate
        ? 0
        : Math.max(
            0,
            Math.min(freshnessMS, maxAge === undefined ? freshnessMS : Number(maxAge) * 1000) -
              Math.max(0, Number(response.headers.get("age")) || 0) * 1000
          );
      // A live response is current even when cache policy forbids storage or
      // demands revalidation next time. Its display status is separate from TTL.
      const displayFreshUntil = checkedAt + (ttl || freshnessMS);
      this.lastRequestFailed = false;
      this.uncachedResponse = undefined;
      if (response.status === 304 && this.entry) {
        const value = this.entry.value;
        this.entry = /(?:^|,)\s*no-store\b/i.test(cacheControl)
          ? undefined
          : {
              ...this.entry,
              checkedAt,
              freshUntil: checkedAt + ttl,
              displayFreshUntil,
              cacheControl,
              etag: response.headers.get("etag") ?? this.entry.etag,
              modified: response.headers.get("last-modified") ?? this.entry.modified
            };
        if (!this.entry) this.uncachedResponse = { checkedAt, freshUntil: displayFreshUntil };
        this.retryAfter = 0;
        return value;
      }
      if (!response.ok) throw new Error("Catalogue unavailable");
      const data = Buffer.from(await response.arrayBuffer());
      if (data.byteLength > this.maxBytes) throw new Error("Catalogue too large");
      const value = this.parse(data);
      // no-store must not leave a reusable index or conditional validators.
      this.entry = /(?:^|,)\s*no-store\b/i.test(cacheControl)
        ? undefined
        : {
            value,
            checkedAt,
            freshUntil: checkedAt + ttl,
            displayFreshUntil,
            cacheControl,
            etag: response.headers.get("etag") ?? undefined,
            modified: response.headers.get("last-modified") ?? undefined
          };
      if (!this.entry) this.uncachedResponse = { checkedAt, freshUntil: displayFreshUntil };
      this.retryAfter = 0;
      return value;
    } catch {
      this.lastRequestFailed = true;
      this.uncachedResponse = undefined;
      this.retryAfter = Date.now() + retryDelayMS;
      return this.lastGood();
    }
  }
}
