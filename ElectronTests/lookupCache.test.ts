// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { LookupCache } from "../src/main/lookupCache";

afterEach(() => vi.useRealTimers());
const url = "https://example.com/source";

describe("remote lookup metadata scheduling", () => {
  it("shares in-flight source requests and caches successful metadata across consumers", async () => {
    const cache = new LookupCache(0);
    const load = vi.fn(async () => Buffer.from("metadata"));
    const [one, two] = await Promise.all([cache.get(url, load), cache.get(url, load)]);
    expect(two).toBe(one);
    expect(await cache.get(url, load)).toBe(one);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get(url, load, { force: true });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("cancels one consumer without cancelling a request still needed by another", async () => {
    const cache = new LookupCache(0);
    const controller = new AbortController();
    let finish!: (value: Buffer) => void;
    let sourceSignal!: AbortSignal;
    const load = (signal: AbortSignal) => {
      sourceSignal = signal;
      return new Promise<Buffer>((resolve) => {
        finish = resolve;
      });
    };
    const first = cache.get(url, load, { signal: controller.signal });
    const cancelled = expect(first).rejects.toThrow();
    const second = cache.get(url, load);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    controller.abort();
    await cancelled;
    expect(sourceSignal.aborted).toBe(false);
    finish(Buffer.from("shared"));
    expect((await second).toString()).toBe("shared");
  });

  it("aborts the source when its last consumer leaves and allows a replacement request", async () => {
    const cache = new LookupCache(0);
    const controller = new AbortController();
    let sourceSignal!: AbortSignal;
    const first = cache.get(
      url,
      (signal) => {
        sourceSignal = signal;
        return new Promise<Buffer>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
        );
      },
      { signal: controller.signal }
    );
    const cancelled = expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(sourceSignal).toBeDefined());
    controller.abort();
    await cancelled;
    expect(sourceSignal.aborted).toBe(true);
    expect((await cache.get(url, async () => Buffer.from("replacement"))).toString()).toBe(
      "replacement"
    );
  });

  it("paces a host while allowing independent hosts and skipping cancelled queued work", async () => {
    vi.useFakeTimers();
    const cache = new LookupCache(3100);
    const starts: number[] = [];
    const load = vi.fn(async () => {
      starts.push(Date.now());
      return Buffer.from("ok");
    });
    await cache.get(url, load);
    const controller = new AbortController();
    const skipped = cache.get(`${url}/skipped`, load, { signal: controller.signal });
    const cancelled = expect(skipped).rejects.toThrow();
    controller.abort();
    await cancelled;
    await cache.get("https://other.example.com/feed", load);
    const next = cache.get(`${url}/next`, load);
    await vi.advanceTimersByTimeAsync(3099);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(starts[2]! - starts[0]!).toBeGreaterThanOrEqual(3100);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("retries failures, expires old metadata, and bounds retained bytes and entries", async () => {
    vi.useFakeTimers();
    const cache = new LookupCache(0, 100, 2, 4);
    const load = vi.fn(async () => Buffer.from("ok"));
    await expect(
      cache.get(url, async () => {
        throw new Error("offline");
      })
    ).rejects.toThrow("offline");
    await cache.get(url, load);
    await cache.get(`${url}/two`, load);
    await cache.get(`${url}/three`, load);
    await cache.get(url, load);
    expect(load).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(100);
    await cache.get(url, load);
    expect(load).toHaveBeenCalledTimes(5);
    const noBytes = new LookupCache(0, 100, 2, 1);
    await noBytes.get(url, load);
    await noBytes.get(url, load);
    expect(load).toHaveBeenCalledTimes(7);
  });
});
