// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";
import type { CatalogueDecodeStatus } from "./catalogueDecode";
import type { CatalogueStorage } from "./catalogueStorage";

export type CatalogueFetchOptions = { force?: boolean };
export type CatalogueStatus = {
  checkedAt?: string;
  stale: boolean;
  unavailable: boolean;
  decode?: CatalogueDecodeStatus;
};

const freshnessMS = 10 * 60 * 1000;
const maxStaleMS = 24 * 60 * 60 * 1000;
const retryDelayMS = 30 * 1000;
const maxHeaderBytes = 8192;

type Entry<T> = {
  value: T;
  payload?: Buffer;
  checkedAt: number;
  freshUntil: number;
  displayFreshUntil: number;
  staleUntil: number;
  cacheControl: string;
  etag?: string;
  modified?: string;
};

export class CatalogueCache<T> {
  private entry?: Entry<T>;
  private task?: Promise<T>;
  private preparation?: Promise<void>;
  private retryAfter = 0;
  private lastRequestFailed = false;
  private uncachedResponse?: { checkedAt: number; freshUntil: number; staleUntil: number };

  constructor(
    private readonly url: string,
    private readonly empty: T,
    private readonly maxBytes: number,
    private readonly parse: (data: Buffer) => T,
    private readonly storage?: CatalogueStorage
  ) {}

  get status(): CatalogueStatus {
    const now = Date.now();
    const metadata = this.entry ?? this.uncachedResponse;
    const usable =
      metadata && now >= metadata.checkedAt && now <= metadata.staleUntil && !this.staleForbidden();
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
    // Preparation is shared independently from network work. A cache-only caller
    // must never make a concurrent forced caller inherit its freshness decision.
    this.preparation ??= this.prepare();
    await this.preparation;
    if (this.task) return this.task;
    if (this.retryAfter > Date.now() + retryDelayMS) this.retryAfter = 0;
    const clockRolledBack = Boolean(this.entry && Date.now() < this.entry.checkedAt);
    if (!clockRolledBack && !options.force) {
      if (this.entry && Date.now() < this.entry.freshUntil) return this.entry.value;
      if (Date.now() < this.retryAfter) return this.lastGood();
    }
    // Only actual revalidation (including a necessary disk eviction) coalesces.
    const task = this.revalidate(clockRolledBack);
    this.task = task;
    try {
      return await task;
    } finally {
      if (this.task === task) this.task = undefined;
    }
  }

  private staleForbidden(): boolean {
    return Boolean(
      this.entry &&
      this.lastRequestFailed &&
      Date.now() >= this.entry.freshUntil &&
      /(?:^|,)\s*must-revalidate\b/i.test(this.entry.cacheControl)
    );
  }

  private lastGood(): T {
    return this.entry &&
      Date.now() >= this.entry.checkedAt &&
      Date.now() <= this.entry.staleUntil &&
      !this.staleForbidden()
      ? this.entry.value
      : this.empty;
  }

  private async prepare(): Promise<void> {
    if (!this.storage) return;
    try {
      const data = await this.storage.load(this.maxBytes + maxHeaderBytes);
      if (!data) return;
      const newline = data.indexOf(10);
      if (newline < 0 || newline >= maxHeaderBytes) throw new Error("Invalid catalogue header");
      const meta = JSON.parse(data.subarray(0, newline).toString("utf8"));
      const payload = data.subarray(newline + 1);
      const now = Date.now();
      if (
        meta.schema !== 1 ||
        meta.url !== this.url ||
        payload.length > this.maxBytes ||
        meta.digest !== digest(payload) ||
        !Number.isSafeInteger(meta.checkedAt) ||
        meta.checkedAt < 0 ||
        meta.checkedAt > now ||
        !validDeadline(meta.freshUntil, meta.checkedAt, freshnessMS) ||
        !validDeadline(meta.displayFreshUntil, meta.checkedAt, freshnessMS) ||
        !validDeadline(meta.staleUntil, meta.checkedAt, maxStaleMS) ||
        meta.staleUntil < now ||
        !validHeader(meta.cacheControl, false) ||
        !validHeader(meta.etag) ||
        !validHeader(meta.modified) ||
        /(?:^|,)\s*no-store\b/i.test(meta.cacheControl)
      )
        throw new Error("Invalid catalogue cache");
      // Always rebuild the index through the current parser. Disk data cannot inject indexes.
      const value = this.parse(payload);
      const policy = cachePolicy(meta.cacheControl, 0, meta.checkedAt);
      this.entry = {
        value,
        payload,
        checkedAt: meta.checkedAt,
        freshUntil: Math.min(meta.freshUntil, policy.freshUntil),
        displayFreshUntil: meta.displayFreshUntil,
        staleUntil: meta.staleUntil,
        cacheControl: meta.cacheControl,
        etag: meta.etag,
        modified: meta.modified
      };
    } catch {
      // Corruption/cache IO failures are rebuildable and never expose payloads in logs.
      await this.storage.clear().catch(() => undefined);
    }
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    try {
      const entry = this.entry;
      if (!entry?.payload) {
        await this.storage.clear();
        return;
      }
      const {
        payload,
        checkedAt,
        freshUntil,
        displayFreshUntil,
        staleUntil,
        cacheControl,
        etag,
        modified
      } = entry;
      const metadata = {
        checkedAt,
        freshUntil,
        displayFreshUntil,
        staleUntil,
        cacheControl,
        etag,
        modified
      };
      const header = Buffer.from(
        JSON.stringify({
          schema: 1,
          url: this.url,
          ...metadata,
          digest: digest(payload)
        }) + "\n"
      );
      if (header.length > maxHeaderBytes) throw new Error("Catalogue header too large");
      await this.storage.save(Buffer.concat([header, payload]));
    } catch {
      // A failed write must not leave older validators/payload reusable on restart.
      await this.storage.clear().catch(() => undefined);
    }
  }

  private async revalidate(clockRolledBack = false): Promise<T> {
    let response: Response | undefined;
    try {
      if (clockRolledBack) {
        this.entry = undefined;
        this.retryAfter = 0;
        await this.persist();
      }
      const headers: Record<string, string> = {};
      if (this.entry?.etag) headers["If-None-Match"] = this.entry.etag;
      if (this.entry?.modified) headers["If-Modified-Since"] = this.entry.modified;
      response = await fetch(this.url, { headers, signal: AbortSignal.timeout(12000) });
      // Recover from a server/proxy 304 when no validated body survived startup.
      if (response.status === 304 && !this.entry) {
        await response.body?.cancel();
        response = await fetch(this.url, { headers: {}, signal: AbortSignal.timeout(12000) });
      }
      if (response.status !== 304 && !response.ok) {
        await response.body?.cancel();
        throw new Error("Catalogue unavailable");
      }
      if (response.status === 304 && !this.entry) throw new Error("Catalogue body missing");
      const checkedAt = Date.now();
      const cacheControl =
        response.headers.get("cache-control") ??
        (response.status === 304 ? this.entry?.cacheControl : undefined) ??
        "";
      if (!validHeader(cacheControl, false)) throw new Error("Invalid catalogue policy");
      const policy = cachePolicy(cacheControl, responseAge(response), checkedAt);
      const noStore = /(?:^|,)\s*no-store\b/i.test(cacheControl);
      const previous = this.entry;
      // Evict before decoding a no-store response, including a malformed one.
      if (noStore) {
        this.entry = undefined;
        await this.persist();
      }
      const payload =
        response.status === 304
          ? previous?.payload
          : await readCatalogueBody(response, this.maxBytes);
      const value = response.status === 304 ? previous!.value : this.parse(payload!);
      this.entry = noStore
        ? undefined
        : {
            value,
            payload: this.storage ? payload : undefined,
            checkedAt,
            ...policy,
            cacheControl,
            etag:
              responseHeader(response, "etag") ??
              (response.status === 304 ? previous?.etag : undefined),
            modified:
              responseHeader(response, "last-modified") ??
              (response.status === 304 ? previous?.modified : undefined)
          };
      this.uncachedResponse = noStore
        ? {
            checkedAt,
            freshUntil: policy.displayFreshUntil,
            staleUntil: policy.staleUntil
          }
        : undefined;
      this.lastRequestFailed = false;
      this.retryAfter = 0;
      await this.persist();
      return value;
    } catch {
      this.lastRequestFailed = true;
      this.uncachedResponse = undefined;
      this.retryAfter = Date.now() + retryDelayMS;
      return this.lastGood();
    } finally {
      if (response?.body && !response.body.locked) {
        await response.body.cancel().catch(() => undefined);
      }
    }
  }
}

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function validDeadline(value: unknown, checkedAt: number, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= checkedAt &&
    value <= checkedAt + maximum
  );
}

function validHeader(value: unknown, optional = true): boolean {
  return (
    (optional && value === undefined) ||
    (typeof value === "string" && value.length <= 2048 && !/[\r\n\0]/u.test(value))
  );
}

function responseHeader(response: Response, name: string): string | undefined {
  const value = response.headers.get(name) ?? undefined;
  return validHeader(value) ? value : undefined;
}

function responseAge(response: Response): number {
  const age = Number(response.headers.get("age"));
  const date = Date.parse(response.headers.get("date") ?? "");
  return Math.max(
    Number.isFinite(age) ? Math.max(0, age * 1000) : 0,
    Number.isFinite(date) ? Math.max(0, Date.now() - date) : 0
  );
}

function cachePolicy(cacheControl: string, age: number, checkedAt: number) {
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(cacheControl)?.[1];
  const revalidate = /(?:^|,)\s*(?:no-cache|no-store)\b/i.test(cacheControl);
  const ttl = revalidate
    ? 0
    : Math.max(
        0,
        Math.min(freshnessMS, maxAge === undefined ? freshnessMS : Number(maxAge) * 1000) - age
      );
  return {
    freshUntil: checkedAt + ttl,
    // A live response is display-current even when it must be revalidated next time.
    displayFreshUntil: checkedAt + (ttl || freshnessMS),
    staleUntil: checkedAt + Math.max(0, maxStaleMS - age)
  };
}

async function readCatalogueBody(response: Response, maxBytes: number): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/u.test(length) && Number(length) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Catalogue too large");
  }
  if (!response.body) throw new Error("Catalogue body missing");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Catalogue too large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
