// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogueCache } from "../src/main/catalogueCache";
import { FileCatalogueStorage, type CatalogueStorage } from "../src/main/catalogueStorage";

const url = "https://example.com/catalogue";
const tenMinutes = 10 * 60 * 1000;
const day = 24 * 60 * 60 * 1000;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "baseline-catalogue-test-"));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

function fixture(storage: CatalogueStorage = new FileCatalogueStorage(root, "formula")) {
  const parse = vi.fn((data: Buffer) => {
    const result: unknown = JSON.parse(data.toString());
    if (!Array.isArray(result) || !result.every((value) => typeof value === "string"))
      throw new Error("schema");
    return result as string[];
  });
  return { cache: new CatalogueCache(url, [], 100, parse, storage), parse, storage };
}
function live(body = '["first"]', headers: Record<string, string> = {}) {
  return new Response(body, {
    headers: { etag: '"one"', "cache-control": "max-age=600", ...headers }
  });
}
async function editHeader(edit: (header: any) => void) {
  const file = path.join(root, "formula-catalogue-v1.cache");
  const data = await readFile(file);
  const newline = data.indexOf(10);
  const header = JSON.parse(data.subarray(0, newline).toString());
  edit(header);
  await writeFile(
    file,
    Buffer.concat([Buffer.from(JSON.stringify(header) + "\n"), data.subarray(newline + 1)])
  );
}

describe("durable catalogue records", () => {
  it("loads once, reparses through the schema, and shares fresh restart calls without network", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(live());
    await fixture().cache.fetch();
    const storage = new FileCatalogueStorage(root, "formula");
    const load = vi.spyOn(storage, "load");
    const restarted = fixture(storage);
    const [first, second] = await Promise.all([restarted.cache.fetch(), restarted.cache.fetch()]);
    expect(first).toEqual(["first"]);
    expect(second).toBe(first);
    expect(network).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(restarted.parse).toHaveBeenCalledTimes(1);
    expect(restarted.cache.status).toMatchObject({ stale: false, unavailable: false });
    expect((await stat(path.join(root, "formula-catalogue-v1.cache"))).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["formula-catalogue-v1.cache"]);
  });

  it("persists renewed 304 freshness and validators together with the original payload", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(live());
    const first = fixture();
    await first.cache.fetch();
    vi.advanceTimersByTime(tenMinutes);
    network.mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"two"' } }));
    const second = fixture();
    expect(await second.cache.fetch()).toEqual(["first"]);
    expect(network).toHaveBeenLastCalledWith(
      url,
      expect.objectContaining({ headers: { "If-None-Match": '"one"' } })
    );
    const third = fixture();
    expect(await third.cache.fetch()).toEqual(["first"]);
    expect(network).toHaveBeenCalledTimes(2);
    network.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await third.cache.fetch({ force: true });
    expect(network).toHaveBeenLastCalledWith(
      url,
      expect.objectContaining({ headers: { "If-None-Match": '"two"' } })
    );
    expect(second.parse).toHaveBeenCalledTimes(1);
  });

  it("serves bounded stale data offline after restart, without refreshing its checked time", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(live());
    await fixture().cache.fetch();
    vi.advanceTimersByTime(tenMinutes);
    network.mockRejectedValue(new Error("offline"));
    const restarted = fixture();
    expect(await restarted.cache.fetch()).toEqual(["first"]);
    expect(restarted.cache.status).toEqual({
      checkedAt: "2026-10-09T12:00:00.000Z",
      stale: true,
      unavailable: false
    });
    vi.advanceTimersByTime(day);
    expect(await fixture().cache.fetch()).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([200, 304])(
    "evicts disk payload and validators across a %s no-store response",
    async (status) => {
      const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(live());
      const { cache } = fixture();
      await cache.fetch();
      network.mockResolvedValueOnce(
        new Response(status === 304 ? null : '["second"]', {
          status,
          headers: { "cache-control": "no-store", etag: '"private"' }
        })
      );
      expect(await cache.fetch({ force: true })).toEqual(status === 304 ? ["first"] : ["second"]);
      expect(await readdir(root)).toEqual([]);
      network.mockRejectedValue(new Error("offline"));
      const restarted = fixture();
      expect(await restarted.cache.fetch()).toEqual([]);
      expect(network).toHaveBeenLastCalledWith(url, expect.objectContaining({ headers: {} }));
    }
  );

  it("evicts an earlier record even if a no-store body is malformed", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(live());
    const { cache } = fixture();
    await cache.fetch();
    network.mockResolvedValueOnce(live("{", { "cache-control": "no-store" }));
    expect(await cache.fetch({ force: true })).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    "malformed JSON",
    "wrong schema",
    "digest mismatch",
    "oversized record",
    "missing header"
  ])(
    "discards %s and recovers from 304 without a body by retrying unconditionally",
    async (kind) => {
      const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(live());
      await fixture().cache.fetch();
      const file = path.join(root, "formula-catalogue-v1.cache");
      if (kind === "malformed JSON") await writeFile(file, "{\n[]");
      if (kind === "wrong schema")
        await editHeader((header) => {
          header.schema = 99;
        });
      if (kind === "digest mismatch") {
        const data = await readFile(file);
        data[data.length - 3] = 120;
        await writeFile(file, data);
      }
      if (kind === "oversized record") await writeFile(file, " ".repeat(8293));
      if (kind === "missing header") await writeFile(file, "[]");
      network
        .mockResolvedValueOnce(new Response(null, { status: 304 }))
        .mockResolvedValueOnce(live('["recovered"]'));
      expect(await fixture().cache.fetch()).toEqual(["recovered"]);
      expect(network).toHaveBeenCalledTimes(3);
      expect(
        network.mock.calls
          .slice(1)
          .every(([, init]) => Object.keys(init?.headers ?? {}).length === 0)
      ).toBe(true);
    }
  );

  it("bounds a repeated bodyless 304 to two requests", async () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 304 }));
    const { cache } = fixture();
    expect(await cache.fetch()).toEqual([]);
    expect(network).toHaveBeenCalledTimes(2);
    expect(cache.status.unavailable).toBe(true);
  });

  it("keeps the valid record and validators after an invalid network replacement", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(live());
    const { cache } = fixture();
    await cache.fetch();
    network.mockResolvedValueOnce(live('[{"wrong":"schema"}]', { etag: '"bad"' }));
    expect(await cache.fetch({ force: true })).toEqual(["first"]);
    network.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect(await fixture().cache.fetch({ force: true })).toEqual(["first"]);
    expect(network).toHaveBeenLastCalledWith(
      url,
      expect.objectContaining({ headers: { "If-None-Match": '"one"' } })
    );
  });

  it("rejects records whose payload no longer passes the current parser", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(live("[1]"))
      .mockRejectedValue(new Error("offline"));
    const storage = new FileCatalogueStorage(root, "formula");
    const old = new CatalogueCache(url, [], 100, (data) => JSON.parse(data.toString()), storage);
    await old.fetch();
    expect(await fixture().cache.fetch()).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    "future checked time",
    "future deadline",
    "non-number deadline",
    "no-store record",
    "invalid validator"
  ])("rejects persisted %s", async (kind) => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(live());
    await fixture().cache.fetch();
    await editHeader((header) => {
      if (kind === "future checked time") header.checkedAt += day;
      if (kind === "future deadline") header.freshUntil += day;
      if (kind === "non-number deadline") header.staleUntil = "infinite";
      if (kind === "no-store record") header.cacheControl = "no-store";
      if (kind === "invalid validator") header.etag = "bad\r\nheader";
    });
    network.mockRejectedValue(new Error("offline"));
    expect(await fixture().cache.fetch()).toEqual([]);
    expect(network).toHaveBeenLastCalledWith(url, expect.objectContaining({ headers: {} }));
  });

  it("never calls a day-backward in-memory or restarted cache fresh", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(live());
    const { cache } = fixture();
    await cache.fetch();
    const original = Date.now();
    vi.setSystemTime(original - day);
    expect(cache.status.unavailable).toBe(true);
    network.mockRejectedValue(new Error("offline"));
    expect(await fixture().cache.fetch()).toEqual([]);
    expect(await cache.fetch()).toEqual([]);
    expect(cache.status.unavailable).toBe(true);
    expect(network).toHaveBeenLastCalledWith(url, expect.objectContaining({ headers: {} }));
  });

  it("bounds stale age using upstream Age and Date rather than restart time", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      live('["old"]', {
        age: String(24 * 60 * 60 - 5),
        date: new Date(Date.now() - day + 5000).toUTCString()
      })
    );
    await fixture().cache.fetch();
    vi.advanceTimersByTime(6000);
    network.mockRejectedValue(new Error("offline"));
    expect(await fixture().cache.fetch()).toEqual([]);
  });

  it("retains no-cache/quoted max-age policy and respects must-revalidate offline", async () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        live('["one"]', { "cache-control": 'max-age="10", must-revalidate', age: "5" })
      );
    const { cache } = fixture();
    await cache.fetch();
    vi.advanceTimersByTime(5000);
    network.mockRejectedValue(new Error("offline"));
    expect(await fixture().cache.fetch()).toEqual([]);
    expect(await cache.fetch()).toEqual([]);
    expect(cache.status.unavailable).toBe(true);
  });

  it("does not turn disk errors into network failures or unusable live indexes", async () => {
    const storage: CatalogueStorage = {
      load: vi.fn().mockRejectedValue(new Error("unreadable")),
      save: vi.fn().mockRejectedValue(new Error("disk full")),
      clear: vi.fn().mockRejectedValue(new Error("read only"))
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(live());
    const { cache } = fixture(storage);
    expect(await cache.fetch()).toEqual(["first"]);
    expect(cache.status).toMatchObject({ stale: false, unavailable: false });
  });

  it("rejects symlink cache inputs and never overwrites their target", async () => {
    const target = path.join(root, "untouched");
    await writeFile(target, "private fixture");
    await symlink(target, path.join(root, "formula-catalogue-v1.cache"));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(live());
    expect(await fixture().cache.fetch()).toEqual(["first"]);
    expect(await readFile(target, "utf8")).toBe("private fixture");
  });
});

describe("download allocation boundary", () => {
  it.each([true, false])(
    "cancels oversized streams before parsing, content-length=%s",
    async (withLength) => {
      const cancelled = vi.fn();
      const parse = vi.fn();
      let reads = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads++;
            controller.enqueue(new Uint8Array(60));
          },
          cancel: cancelled
        },
        { highWaterMark: 0 }
      );
      const response = new Response(stream, {
        headers: withLength ? { "content-length": "101" } : {}
      });
      const arrayBuffer = vi.spyOn(response, "arrayBuffer");
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
      const cache = new CatalogueCache(url, [], 100, parse);
      expect(await cache.fetch()).toEqual([]);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(reads).toBe(withLength ? 0 : 2);
      expect(parse).not.toHaveBeenCalled();
      expect(arrayBuffer).not.toHaveBeenCalled();
    }
  );

  it("accepts exactly the limit despite multibyte data split across chunks", async () => {
    const bytes = Buffer.from('["é"]');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      }
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(stream));
    const cache = new CatalogueCache(url, [], bytes.length, (data) => JSON.parse(data.toString()));
    expect(await cache.fetch()).toEqual(["é"]);
  });
});

it("retains still-fresh must-revalidate data when a forced request fails", async () => {
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(live('["fresh"]', { "cache-control": "max-age=600, must-revalidate" }));
  const { cache } = fixture();
  await cache.fetch();
  vi.advanceTimersByTime(1000);
  network.mockRejectedValue(new Error("offline"));
  expect(await cache.fetch({ force: true })).toEqual(["fresh"]);
  expect(cache.status).toMatchObject({ unavailable: false });
  vi.advanceTimersByTime(tenMinutes);
  expect(await cache.fetch()).toEqual([]);
  expect(cache.status.unavailable).toBe(true);
});
