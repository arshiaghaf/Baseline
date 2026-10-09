// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

export type LookupRequestOptions = { signal?: AbortSignal; force?: boolean };
type Pending = { controller: AbortController; consumers: Set<symbol>; task: Promise<Buffer> };
type HostSlot = { tail: Promise<void>; nextStart: number; queued: number; pauseUntil: number };

// Cache source metadata, not the answer for an installed version. Callers
// compare cached metadata with the newly scanned version on every lookup.
export class LookupCache {
  private readonly entries = new Map<
    string,
    { data: Buffer; expiresAt: number; checkedAt: number }
  >();
  private readonly pending = new Map<string, Pending>();
  private readonly hosts = new Map<string, HostSlot>();
  private bytes = 0;

  constructor(
    private readonly minIntervalMS: number,
    private readonly ttlMS: number | ((data: Buffer) => number) = 10 * 60 * 1000,
    private readonly maxEntries = 512,
    private readonly maxBytes = 8 * 1024 * 1024
  ) {}

  checkedAt(url: string): string | undefined {
    const entry = this.entries.get(url);
    return entry ? new Date(entry.checkedAt).toISOString() : undefined;
  }

  backoff(url: string, retryAfter: string | null): void {
    const slot = this.hosts.get(new URL(url).host) ?? this.hosts.get("overflow");
    if (!slot) return;
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const requested = Number.isFinite(seconds)
      ? Date.now() + Math.max(0, seconds) * 1000
      : retryAfter
        ? Date.parse(retryAfter)
        : NaN;
    slot.pauseUntil = Math.max(
      slot.pauseUntil,
      Number.isFinite(requested)
        ? Math.min(Date.now() + 24 * 60 * 60 * 1000, requested)
        : Date.now() + 60_000
    );
  }

  async get(
    url: string,
    load: (signal: AbortSignal) => Promise<Buffer>,
    options: LookupRequestOptions = {}
  ): Promise<Buffer> {
    options.signal?.throwIfAborted();
    const cached = this.entries.get(url);
    if (!options.force && cached && Date.now() < cached.expiresAt) {
      this.entries.delete(url);
      this.entries.set(url, cached);
      return cached.data;
    }
    let pending = this.pending.get(url);
    if (!pending) {
      if (this.pending.size >= this.maxEntries) throw new Error("Too many pending source requests");
      const controller = new AbortController();
      const consumers = new Set<symbol>();
      const task = this.request(url, load, controller.signal);
      pending = { controller, consumers, task };
      this.pending.set(url, pending);
      const current = pending;
      void task
        .finally(() => {
          if (this.pending.get(url) === current) this.pending.delete(url);
        })
        .catch(() => undefined);
    }
    return this.subscribe(url, pending, options.signal);
  }

  private subscribe(url: string, pending: Pending, signal?: AbortSignal): Promise<Buffer> {
    const consumer = Symbol();
    pending.consumers.add(consumer);
    return new Promise((resolve, reject) => {
      const release = () => {
        signal?.removeEventListener("abort", abort);
        pending.consumers.delete(consumer);
      };
      const abort = () => {
        release();
        reject(signal?.reason ?? new Error("Lookup cancelled"));
        if (pending.consumers.size === 0) {
          if (this.pending.get(url) === pending) this.pending.delete(url);
          pending.controller.abort();
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      pending.task.then(
        (data) => {
          release();
          resolve(data);
        },
        (error: unknown) => {
          release();
          reject(error);
        }
      );
      if (signal?.aborted) abort();
    });
  }

  private async request(
    url: string,
    load: (signal: AbortSignal) => Promise<Buffer>,
    signal: AbortSignal
  ): Promise<Buffer> {
    let host = new URL(url).host;
    if (!this.hosts.has(host) && this.hosts.size >= 256) {
      for (const [key, slot] of this.hosts) {
        if (slot.queued === 0 && Date.now() >= Math.max(slot.nextStart, slot.pauseUntil))
          this.hosts.delete(key);
      }
      // A bounded shared bucket is conservative when many hosts are active.
      if (this.hosts.size >= 256) host = "overflow";
    }
    let slot = this.hosts.get(host);
    if (!slot) {
      slot = { tail: Promise.resolve(), nextStart: 0, queued: 0, pauseUntil: 0 };
      this.hosts.set(host, slot);
    }
    slot.queued++;
    const previous = slot.tail;
    const ready = previous
      .catch(() => undefined)
      .then(async () => {
        signal.throwIfAborted();
        if (Date.now() < slot.pauseUntil) throw new Error("Source requests are temporarily paused");
        const wait = Math.max(0, slot.nextStart - Date.now());
        if (wait > 0) await waitForSlot(wait, signal);
        signal.throwIfAborted();
        if (Date.now() < slot.pauseUntil) throw new Error("Source requests are temporarily paused");
        slot.nextStart = Date.now() + this.minIntervalMS;
      });
    slot.tail = ready.catch(() => undefined);
    try {
      await ready;
      const data = await load(signal);
      signal.throwIfAborted();
      const existing = this.entries.get(url);
      if (existing) {
        this.bytes -= existing.data.byteLength;
        this.entries.delete(url);
      }
      if (data.byteLength <= this.maxBytes) {
        const checkedAt = Date.now();
        this.entries.set(url, {
          data,
          checkedAt,
          expiresAt: checkedAt + (typeof this.ttlMS === "number" ? this.ttlMS : this.ttlMS(data))
        });
        this.bytes += data.byteLength;
        while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
          const oldest = this.entries.keys().next().value!;
          this.bytes -= this.entries.get(oldest)!.data.byteLength;
          this.entries.delete(oldest);
        }
      }
      return data;
    } finally {
      slot.queued--;
    }
  }
}

function waitForSlot(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
