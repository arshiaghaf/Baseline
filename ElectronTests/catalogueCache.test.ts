// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogueCache } from "../src/main/catalogueCache";
import { HomebrewCaskClient } from "../src/main/homebrewCaskClient";
import { HomebrewFormulaClient } from "../src/main/homebrewFormulaClient";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  const parse = vi.fn((data: Buffer) => JSON.parse(data.toString()) as string[]);
  const cache = new CatalogueCache("https://example.com/catalogue", [], 100, parse);
  const fetchMock = vi.spyOn(globalThis, "fetch");
  const response = () =>
    new Response('["first"]', {
      headers: {
        etag: '"one"',
        "last-modified": "Thu, 08 Oct 2026 00:00:00 GMT",
        "cache-control": "max-age=600"
      }
    });
  return { cache, parse, fetchMock, response };
}

describe("catalogue freshness and last-good indexes", () => {
  it("cancels a subscriber without aborting another consumer of the same catalogue", async () => {
    const { cache, fetchMock, response } = fixture();
    let deliver!: (response: Response) => void;
    let networkSignal!: AbortSignal;
    fetchMock.mockImplementation((_url, options) => {
      networkSignal = options!.signal!;
      return new Promise<Response>((resolve) => {
        deliver = resolve;
      });
    });
    const controller = new AbortController();
    const first = cache.fetch({ signal: controller.signal });
    let failure: unknown;
    const observed = first.catch((error: unknown) => {
      failure = error;
    });
    const second = cache.fetch();
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      controller.abort(new Error("superseded"));
      await vi.waitFor(() => expect(failure).toMatchObject({ message: "superseded" }), {
        timeout: 200
      });
      expect(networkSignal.aborted).toBe(false);
      deliver(response());
      expect(await second).toEqual(["first"]);
      expect(await cache.fetch()).toEqual(["first"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      deliver(response());
      await Promise.allSettled([first, second, observed]);
    }
  });

  it("aborts the last cancelled network consumer and retries without poisoning last-good metadata", async () => {
    const { cache, fetchMock, response } = fixture();
    fetchMock.mockResolvedValueOnce(response());
    const first = await cache.fetch();
    const before = cache.status;
    let networkSignal!: AbortSignal;
    let rejectNetwork!: (reason: Error) => void;
    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          rejectNetwork = reject;
          networkSignal = options!.signal!;
          networkSignal.addEventListener("abort", () => reject(networkSignal.reason), {
            once: true
          });
        })
    );
    const controller = new AbortController();
    const task = cache.fetch({ force: true, signal: controller.signal });
    let failure: unknown;
    const observed = task.catch((error: unknown) => {
      failure = error;
    });
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      controller.abort(new Error("superseded"));
      await vi.waitFor(() => expect(failure).toMatchObject({ message: "superseded" }), {
        timeout: 200
      });
      expect(networkSignal.aborted).toBe(true);
      expect(cache.status).toEqual(before);
      fetchMock.mockResolvedValueOnce(new Response('["new"]'));
      expect(await cache.fetch({ force: true })).toEqual(["new"]);
      expect(first).toEqual(["first"]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      rejectNetwork(new Error("test teardown"));
      await Promise.allSettled([task, observed]);
    }
  });

  it("falls back to the network after a cache read deadline without clearing unavailable disk data", async () => {
    vi.useRealTimers();
    let rejectLoad!: (reason: Error) => void;
    const load = new Promise<Buffer | undefined>((_resolve, reject) => {
      rejectLoad = reject;
    });
    const storage = {
      load: vi.fn(() => load),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    };
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('["online"]'));
    const cache = new CatalogueCache(
      "https://example.com/catalogue",
      [],
      100,
      (data) => JSON.parse(data.toString()) as string[],
      storage
    );
    const task = cache.fetch();
    try {
      deadline.abort(Object.assign(new Error("cache read deadline"), { name: "TimeoutError" }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 200 });
      expect(await task).toEqual(["online"]);
      expect(storage.clear).not.toHaveBeenCalled();
    } finally {
      rejectLoad(new Error("late cache failure"));
      await Promise.allSettled([load, task]);
    }
  });

  it("shares concurrent requests and reuses fresh parsed indexes without fetching or parsing", async () => {
    const { cache, parse, fetchMock, response } = fixture();
    fetchMock.mockResolvedValue(response());
    const [first, second] = await Promise.all([cache.fetch(), cache.fetch()]);
    expect(second).toBe(first);
    expect(await cache.fetch()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(cache.status).toEqual({
      checkedAt: "2026-10-09T12:00:00.000Z",
      stale: false,
      unavailable: false
    });
  });

  it("force-revalidates fresh metadata and skips parsing an unchanged 304 response", async () => {
    const { cache, parse, fetchMock, response } = fixture();
    fetchMock
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const first = await cache.fetch();
    expect(await cache.fetch({ force: true })).toBe(first);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://example.com/catalogue",
      expect.objectContaining({
        headers: {
          "If-None-Match": '"one"',
          "If-Modified-Since": "Thu, 08 Oct 2026 00:00:00 GMT"
        }
      })
    );
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("retains last-good data on failure, reports staleness, retries forcefully, and expires after a day", async () => {
    const { cache, fetchMock, response } = fixture();
    fetchMock.mockResolvedValueOnce(response()).mockRejectedValue(new Error("offline"));
    const first = await cache.fetch();
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(await cache.fetch()).toBe(first);
    expect(cache.status).toMatchObject({ stale: true, unavailable: false });
    expect(await cache.fetch()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await cache.fetch({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(await cache.fetch()).toEqual([]);
    expect(cache.status.unavailable).toBe(true);
  });

  it.each(["malformed", "oversized", "server error"])(
    "does not replace a validated index after %s",
    async (kind) => {
      const { cache, fetchMock, response } = fixture();
      fetchMock.mockResolvedValueOnce(response());
      const first = await cache.fetch();
      fetchMock.mockResolvedValueOnce(
        new Response(kind === "malformed" ? "{" : "x".repeat(101), {
          status: kind === "server error" ? 503 : 200
        })
      );
      expect(await cache.fetch({ force: true })).toBe(first);
      expect(cache.status).toMatchObject({ stale: true, unavailable: false });
      fetchMock.mockResolvedValueOnce(new Response('["second"]', { headers: { etag: '"two"' } }));
      expect(await cache.fetch({ force: true })).toEqual(["second"]);
    }
  );

  it("respects no-store and shortened freshness after an upstream cache Age", async () => {
    const { cache, fetchMock } = fixture();
    fetchMock.mockResolvedValueOnce(
      new Response('["one"]', { headers: { "cache-control": "no-store", etag: '"one"' } })
    );
    await cache.fetch();
    fetchMock.mockResolvedValueOnce(
      new Response('["two"]', { headers: { "cache-control": "max-age=600", age: "590" } })
    );
    await cache.fetch();
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ headers: {} })
    );
    vi.advanceTimersByTime(10_000);
    fetchMock.mockResolvedValueOnce(new Response('["three"]'));
    expect(await cache.fetch()).toEqual(["three"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(
    [200, 304].flatMap((status) =>
      ["no-store", "no-cache", "max-age=0"].map((directive) => ({ status, directive }))
    )
  )(
    "reports live $status/$directive separately from stale fallback",
    async ({ status, directive }) => {
      const { cache, fetchMock, response } = fixture();
      let delivered = ["fresh"];
      if (status === 304) {
        fetchMock.mockResolvedValueOnce(response());
        delivered = await cache.fetch();
      }
      fetchMock.mockResolvedValueOnce(
        new Response(status === 304 ? null : '["fresh"]', {
          status,
          headers: { "cache-control": directive, etag: '"fresh"' }
        })
      );
      expect(await cache.fetch({ force: true })).toEqual(delivered);
      expect(cache.status).toEqual({
        checkedAt: "2026-10-09T12:00:00.000Z",
        stale: false,
        unavailable: false
      });
      fetchMock.mockRejectedValueOnce(new Error("offline"));
      expect(await cache.fetch()).toEqual(directive === "no-store" ? [] : delivered);
      expect(fetchMock).toHaveBeenCalledTimes(status === 304 ? 3 : 2);
      if (directive === "no-store") {
        expect(fetchMock).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({ headers: {} })
        );
      }
      expect(cache.status).toMatchObject(
        directive === "no-store"
          ? { stale: false, unavailable: true }
          : { stale: true, unavailable: false }
      );
    }
  );

  it("retains revalidation policy and updated validators when a 304 omits cache-control", async () => {
    const { cache, fetchMock, parse } = fixture();
    fetchMock.mockResolvedValueOnce(
      new Response('["fresh"]', {
        headers: { "cache-control": "no-cache", etag: '"first"' }
      })
    );
    const first = await cache.fetch();
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 304, headers: { etag: '"second"' } })
    );
    expect(await cache.fetch()).toBe(first);
    expect(cache.status).toMatchObject({ stale: false, unavailable: false });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect(await cache.fetch()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: { "If-None-Match": '"second"' }
      })
    );
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it.each([HomebrewCaskClient, HomebrewFormulaClient])(
    "rejects wrong JSON shape without poisoning a client cache",
    async (Client) => {
      const client = new Client();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("[]"));
      const good = await client.fetchIndex();
      fetchMock.mockResolvedValueOnce(new Response('"wrong shape"'));
      expect(await client.fetchIndex({ force: true })).toBe(good);
    }
  );
});
