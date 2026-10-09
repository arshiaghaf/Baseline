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
    etag?: string;
    modified?: string;
  };
  private task?: Promise<T>;
  private retryAfter = 0;

  constructor(
    private readonly url: string,
    private readonly empty: T,
    private readonly maxBytes: number,
    private readonly parse: (data: Buffer) => T
  ) {}

  get status(): CatalogueStatus {
    const now = Date.now();
    const usable = this.entry && now - this.entry.checkedAt <= maxStaleMS;
    return {
      checkedAt: this.entry ? new Date(this.entry.checkedAt).toISOString() : undefined,
      stale: Boolean(usable && now >= this.entry!.freshUntil),
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
      const cacheControl = response.headers.get("cache-control") ?? "";
      const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl)?.[1];
      const ttl = /(?:^|,)\s*(?:no-cache|no-store)\b/i.test(cacheControl)
        ? 0
        : Math.max(
            0,
            Math.min(freshnessMS, maxAge === undefined ? freshnessMS : Number(maxAge) * 1000) -
              Math.max(0, Number(response.headers.get("age")) || 0) * 1000
          );
      if (response.status === 304 && this.entry) {
        const value = this.entry.value;
        this.entry = /(?:^|,)\s*no-store\b/i.test(cacheControl)
          ? undefined
          : { ...this.entry, checkedAt, freshUntil: checkedAt + ttl };
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
            etag: response.headers.get("etag") ?? undefined,
            modified: response.headers.get("last-modified") ?? undefined
          };
      this.retryAfter = 0;
      return value;
    } catch {
      this.retryAfter = Date.now() + retryDelayMS;
      return this.lastGood();
    }
  }
}
