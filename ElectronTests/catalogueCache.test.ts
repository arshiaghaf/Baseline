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

  it.each(["no-store", "no-cache"])(
    "reports a live %s response as current while still revalidating the next request",
    async (directive) => {
      const { cache, fetchMock } = fixture();
      fetchMock.mockResolvedValueOnce(
        new Response('["fresh"]', {
          headers: { "cache-control": directive, etag: '"fresh"' }
        })
      );
      expect(await cache.fetch()).toEqual(["fresh"]);
      expect(cache.status).toMatchObject({ stale: false, unavailable: false });
      fetchMock.mockRejectedValueOnce(new Error("offline"));
      expect(await cache.fetch()).toEqual(directive === "no-store" ? [] : ["fresh"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(cache.status).toMatchObject(
        directive === "no-store"
          ? { stale: false, unavailable: true }
          : { stale: true, unavailable: false }
      );
    }
  );

  it("reports a no-store 304 as a live success and discards its validators", async () => {
    const { cache, fetchMock, response } = fixture();
    fetchMock.mockResolvedValueOnce(response());
    const first = await cache.fetch();
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 304,
        headers: { "cache-control": "no-store" }
      })
    );
    expect(await cache.fetch({ force: true })).toBe(first);
    expect(cache.status).toMatchObject({ stale: false, unavailable: false });
    fetchMock.mockResolvedValueOnce(new Response('["next"]'));
    await cache.fetch();
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ headers: {} })
    );
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
