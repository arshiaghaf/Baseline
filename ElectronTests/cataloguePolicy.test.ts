// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogueCache } from "../src/main/catalogueCache";
import type { CatalogueStorage } from "../src/main/catalogueStorage";
import { HomebrewCaskClient } from "../src/main/homebrewCaskClient";
import { version } from "../src/shared/version";
import { mergeCatalogueSearchResults } from "../src/main/catalogueSearch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const payload = (value: unknown) => Buffer.from(JSON.stringify(value));
const response = (value: string) =>
  new Response(JSON.stringify([value]), {
    headers: { etag: `"${value}"`, "cache-control": "max-age=600" }
  });
function cache(storage?: CatalogueStorage) {
  return new CatalogueCache(
    "https://example.com/catalogue",
    [],
    100,
    (data) => JSON.parse(data.toString()) as string[],
    storage
  );
}
afterEach(() => vi.restoreAllMocks());

describe("catalogue evidence and searchable representations", () => {
  it.each(
    [false, true].flatMap((optionalFirst) =>
      [false, true].map((nested) => ({ optionalFirst, nested }))
    )
  )(
    "retains artifact evidence regardless of optional-field order ($optionalFirst) and nesting ($nested)",
    ({ optionalFirst, nested }) => {
      const evidence = { app: ["The Unarchiver.app"], bundle_id: "com.example.unarchiver" };
      const optional = Array.from({ length: 300_000 }, () => null);
      const artifact = nested
        ? optionalFirst
          ? { optional, nested: evidence }
          : { nested: evidence, optional }
        : evidence;
      const body = payload([
        {
          token: "unar",
          version: "2",
          ...(optionalFirst
            ? { optional, artifacts: [artifact] }
            : { artifacts: [artifact], optional })
        }
      ]);
      const index = new HomebrewCaskClient().parseIndex(body);
      expect(index.byToken.unar?.appBundleNames).toEqual(["the unarchiver.app"]);
      expect(index.byToken.unar?.presentation).toBe("app");
      expect(index.byBundleIdentifier["com.example.unarchiver"]?.token).toBe("unar");
    }
  );

  it.each([false, true])(
    "preserves sibling artifact evidence beside a large optional object tree, first=%s",
    (optionalFirst) => {
      const branches = Array.from({ length: 2048 }, () => ({
        nested: { nested: { nested: { value: null } } }
      }));
      const optional = { optional: { branches, more: branches, last: branches } };
      const evidence = {
        nested: { nested: { app: ["Sibling.app"], bundle_id: "com.example.sibling" } }
      };
      const artifacts = optionalFirst ? [optional, evidence] : [evidence, optional];
      const index = new HomebrewCaskClient().parseIndex(
        payload([{ token: "sibling", version: "2", artifacts }])
      );
      expect(index.byToken.sibling?.appBundleNames).toEqual(["sibling.app"]);
      expect(index.byToken.sibling?.presentation).toBe("app");
      expect(index.byBundleIdentifier["com.example.sibling"]?.token).toBe("sibling");
    }
  );

  it("preserves explicit app targets, identifiers and tap identity beside wide unrelated maps", () => {
    const optional = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [`field${index}`, null])
    );
    const client = new HomebrewCaskClient();
    const index = client.parseIndex(
      payload([
        {
          token: "renamed-tool",
          full_token: "vendor/tools/renamed-tool",
          tap: "vendor/tools",
          version: "2",
          ...optional,
          artifacts: [{ app: ["Original.app", { target: "/Applications/Renamed.app" }] }],
          bundleIdentifier: ["com.example.tool"]
        }
      ])
    );
    expect(index.byToken["renamed-tool"]).toMatchObject({
      fullToken: "vendor/tools/renamed-tool",
      tap: "vendor/tools",
      presentation: "app",
      appBundleNames: ["original.app", "renamed.app"],
      installedAppPaths: ["/Applications/Renamed.app"]
    });
    expect(client.lookupUpdate("com.example.tool", "Renamed.app", version("1"), index)?.token).toBe(
      "renamed-tool"
    );
  });

  it("keeps valid root evidence while truncating a branch beyond the documented nesting limit", () => {
    let deep: unknown = { app: ["Beyond Limit.app"] };
    for (let depth = 0; depth < 40; depth++) deep = { nested: deep };
    const index = new HomebrewCaskClient().parseIndex(
      payload([
        {
          token: "bounded",
          version: "2",
          artifacts: [{ app: ["Visible.app"] }],
          optional: deep
        }
      ])
    );
    expect(index.byToken.bounded?.appBundleNames).toEqual(["visible.app"]);
    expect(index.byToken.bounded?.presentation).toBe("app");
  });

  it.each(["The Unarchiver", "The Unarchiver.app", "unarchiver.app", "unar", "THE-UNARCHIVER.APP"])(
    "searches token-different casks by preserved and stripped names: %s",
    (query) => {
      const client = new HomebrewCaskClient();
      const index = client.parseIndex(
        payload([{ token: "unar", version: "2", artifacts: [{ app: ["The Unarchiver.app"] }] }])
      );
      const results = client.searchCasks(query, index, new Set());
      expect(results[0]?.token).toBe("unar");
      expect(mergeCatalogueSearchResults(query, results, [])[0]?.token).toBe("unar");
      expect(client.searchCasks(query, index, new Set(["unar"]))).toEqual([]);
    }
  );
});

describe("forced catalogue admission and actual network coalescing", () => {
  it.each([0, 2])(
    "cannot inherit a warm-memory-only task after %i microtask turns",
    async (turns) => {
      const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response("cached"));
      const client = cache();
      await client.fetch();
      network.mockClear().mockResolvedValueOnce(response("network"));
      const ordinary = client.fetch();
      for (let turn = 0; turn < turns; turn++) await Promise.resolve();
      const forced = client.fetch({ force: true });
      expect(await ordinary).toEqual(["cached"]);
      expect(await forced).toEqual(["network"]);
      expect(network).toHaveBeenCalledTimes(1);
    }
  );

  it.each([false, true])(
    "honors forced callers during shared disk preparation, force-first=%s",
    async (forceFirst) => {
      let record: Buffer | undefined;
      const storage: CatalogueStorage = {
        load: async () => record,
        save: async (value) => {
          record = value;
        },
        clear: async () => {
          record = undefined;
        }
      };
      const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response("cached"));
      await cache(storage).fetch();
      const prepared = deferred<Buffer | undefined>();
      const load = vi.fn(() => prepared.promise);
      const client = cache({ ...storage, load });
      network.mockClear().mockResolvedValueOnce(response("network"));
      const first = client.fetch({ force: forceFirst });
      const second = client.fetch({ force: !forceFirst });
      const third = client.fetch({ force: true });
      prepared.resolve(record);
      const values = await Promise.all([first, second, third]);
      expect(values).toEqual(
        forceFirst
          ? [["network"], ["network"], ["network"]]
          : [["cached"], ["network"], ["network"]]
      );
      expect(load).toHaveBeenCalledTimes(1);
      expect(network).toHaveBeenCalledTimes(1);
      expect(network).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ headers: { "If-None-Match": '"cached"' } })
      );
    }
  );

  it.each([false, true])(
    "shares only an actual in-flight request, force-first=%s",
    async (forceFirst) => {
      const started = deferred<void>();
      const pending = deferred<Response>();
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        started.resolve();
        return pending.promise;
      });
      const client = cache();
      const first = client.fetch({ force: forceFirst });
      await started.promise;
      const second = client.fetch({ force: !forceFirst });
      const third = client.fetch({ force: true });
      pending.resolve(response("network"));
      expect(await Promise.all([first, second, third])).toEqual([
        ["network"],
        ["network"],
        ["network"]
      ]);
      expect(network).toHaveBeenCalledTimes(1);
    }
  );
});

it("lets force bypass retry-only cache work without duplicating its network request", async () => {
  const expired = response("cached");
  expired.headers.set("cache-control", "max-age=0");
  const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(expired);
  const client = cache();
  await client.fetch();
  network.mockRejectedValueOnce(new Error("offline"));
  await client.fetch({ force: true });
  network.mockClear().mockResolvedValueOnce(response("recovered"));
  const ordinary = client.fetch();
  const forced = client.fetch({ force: true });
  const otherForced = client.fetch({ force: true });
  expect(await ordinary).toEqual(["cached"]);
  expect(await forced).toEqual(["recovered"]);
  expect(await otherForced).toEqual(["recovered"]);
  expect(network).toHaveBeenCalledTimes(1);
});

it("continues coalescing a revalidation while its atomic publication is pending", async () => {
  const publishing = deferred<void>();
  const saved = deferred<void>();
  const storage: CatalogueStorage = {
    load: async () => undefined,
    save: async () => {
      saved.resolve();
      await publishing.promise;
    },
    clear: async () => undefined
  };
  const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response("network"));
  const client = cache(storage);
  const first = client.fetch({ force: true });
  await saved.promise;
  const forced = client.fetch({ force: true });
  const ordinary = client.fetch();
  publishing.resolve();
  expect(await Promise.all([first, forced, ordinary])).toEqual([
    ["network"],
    ["network"],
    ["network"]
  ]);
  expect(network).toHaveBeenCalledTimes(1);
});

it("lets an ordinary warm-memory caller join an already-started forced request", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response("cached"));
  const client = cache();
  await client.fetch();
  const started = deferred<void>();
  const pending = deferred<Response>();
  network.mockClear().mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const forced = client.fetch({ force: true });
  await started.promise;
  const ordinary = client.fetch();
  const otherForced = client.fetch({ force: true });
  pending.resolve(response("network"));
  expect(await Promise.all([forced, ordinary, otherForced])).toEqual([
    ["network"],
    ["network"],
    ["network"]
  ]);
  expect(network).toHaveBeenCalledTimes(1);
});

it("coalesces clock-rollback eviction before any replacement request is published", async () => {
  let record: Buffer | undefined;
  const clearing = deferred<void>();
  const cleared = deferred<void>();
  const clear = vi.fn(async () => {
    clearing.resolve();
    await cleared.promise;
    record = undefined;
  });
  const storage: CatalogueStorage = {
    load: async () => record,
    save: async (value) => {
      record = value;
    },
    clear
  };
  const network = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response("cached"));
  const client = cache(storage);
  await client.fetch();
  const original = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(original - 24 * 60 * 60 * 1000);
  network.mockClear().mockResolvedValueOnce(response("network"));
  const ordinary = client.fetch();
  await clearing.promise;
  const forced = client.fetch({ force: true });
  cleared.resolve();
  expect(await Promise.all([ordinary, forced])).toEqual([["network"], ["network"]]);
  expect(clear).toHaveBeenCalledTimes(1);
  expect(network).toHaveBeenCalledTimes(1);
  expect(network).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ headers: {} })
  );
});
