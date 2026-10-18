// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStoreLookupClient, type AppStoreLookupRequest } from "../src/main/appStoreLookupClient";
import { byteLimits } from "../src/shared/security";
import { version } from "../src/shared/version";

const request = (
  id: number,
  local = "1",
  platform: "mac" | "ios" = "mac"
): AppStoreLookupRequest => ({
  bundleIdentifier: `com.example.app${id}`,
  localVersion: version(local),
  platform,
  identity: { productID: id, platform, storefront: "us" }
});
const entry = (id: number, kind = "mac-software", remote = "2") => ({
  bundleId: `com.example.app${id}`,
  kind,
  version: remote,
  trackId: id,
  trackViewUrl: `https://apps.apple.com/app/id${id}`
});
const response = (results: unknown[]) =>
  new Response(JSON.stringify({ resultCount: results.length, results }));
const identifiers = (url: URL) =>
  (url.searchParams.get("id") ?? url.searchParams.get("bundleId")!).split(",");

async function settle<T>(task: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return task;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("platform-qualified App Store metadata", () => {
  it("recognizes a current matching provider even when its product ID is omitted", async () => {
    const fetch = vi.fn(async () =>
      response([{ bundleId: "com.example.app1", kind: "mac-software", version: "2" }])
    );
    vi.stubGlobal("fetch", fetch);
    const result = await new AppStoreLookupClient().lookupOutcomes(
      [{ ...request(1, "2"), identity: undefined }],
      { force: true }
    );
    expect(result).toMatchObject([
      { type: "completed", providerFound: true, value: undefined, identity: undefined }
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains current-product identities and compares duplicate installed copies independently", async () => {
    const fetch = vi.fn(async () =>
      response([entry(2), { ...entry(1, "software"), supportedDevices: ["MacDesktop-MacDesktop"] }])
    );
    vi.stubGlobal("fetch", fetch);
    const result = await new AppStoreLookupClient().lookupOutcomes(
      [request(1), request(2, "3"), request(1, "2")],
      { force: true }
    );
    expect(result).toMatchObject([
      { type: "completed", value: { remoteVersion: version("2") }, identity: request(1).identity },
      { type: "completed", value: undefined, identity: request(2).identity },
      { type: "completed", value: undefined, identity: request(1).identity }
    ]);
    expect(result.every((outcome) => outcome.type === "completed" && outcome.checkedAt)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL((fetch.mock.calls as unknown as [string][])[0]![0]);
    expect(url.searchParams.get("id")).toBe("1,2");
    expect(url.searchParams.get("bundleId")).toBeNull();
    expect(url.searchParams.get("entity")).toBe("desktopSoftware");
    expect(url.searchParams.get("country")).toBe("us");
  });

  it("keeps platform versions separate when a universal product shares one numeric ID", async () => {
    vi.useFakeTimers();
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        urls.push(url);
        return response([
          {
            ...entry(
              1,
              "software",
              url.searchParams.get("entity") === "desktopSoftware" ? "3" : "7"
            ),
            supportedDevices: ["MacDesktop-MacDesktop", "iPhone15-iPhone15"]
          }
        ]);
      })
    );
    const mac = request(1);
    const ios = request(1, "1", "ios");
    const result = await settle(
      new AppStoreLookupClient().lookupOutcomes([mac, ios], { force: true })
    );
    expect(result).toMatchObject([
      { value: { remoteVersion: version("3") }, identity: mac.identity },
      { value: { remoteVersion: version("7") }, identity: ios.identity }
    ]);
    expect(
      urls.map((url) => [url.searchParams.get("entity"), url.searchParams.get("country")])
    ).toEqual([
      ["desktopSoftware", "us"],
      ["software", "us"]
    ]);
  });

  it("discovers a current Mac product by bundle independently of update availability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response([{ ...entry(1), bundleId: "COM.EXAMPLE.APP1" }]))
    );
    const result = await new AppStoreLookupClient("GB").lookupOutcomes([
      { ...request(1, "2"), identity: undefined }
    ]);
    expect(result).toMatchObject([
      {
        type: "completed",
        value: undefined,
        identity: { ...request(1).identity!, storefront: "gb" }
      }
    ]);
  });

  it("rejects a native record with the wrong bundle and never uses a native version for an iOS app", () => {
    const client = new AppStoreLookupClient();
    expect(
      client.parseLookupResponse(
        Buffer.from(JSON.stringify({ results: [entry(2)] })),
        version("1"),
        {
          bundleIdentifier: request(1).bundleIdentifier
        }
      )
    ).toBeUndefined();
    expect(
      client.parseLookupResponse(
        Buffer.from(JSON.stringify({ results: [entry(1)] })),
        version("1"),
        {
          bundleIdentifier: request(1).bundleIdentifier,
          includeIOSAppStoreSoftware: true
        }
      )
    ).toBeUndefined();
  });

  it("uses macSoftware only as a native compatibility fallback and rejects its ambiguous software versions", async () => {
    vi.useFakeTimers();
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        urls.push(url);
        return response(
          url.searchParams.get("entity") === "desktopSoftware"
            ? []
            : [{ ...entry(1, "software", "99"), supportedDevices: ["MacDesktop-MacDesktop"] }]
        );
      })
    );
    const result = await settle(
      new AppStoreLookupClient().lookupOutcomes([{ ...request(1), identity: undefined }])
    );
    expect(result).toMatchObject([{ type: "completed", value: undefined }]);
    expect(result[0]).not.toHaveProperty("identity");
    expect(urls.map((url) => url.searchParams.get("entity"))).toEqual([
      "desktopSoftware",
      "macSoftware"
    ]);
  });

  it("recovers native compatibility products and iOS products through their distinct fallback scopes", async () => {
    vi.useFakeTimers();
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        urls.push(url);
        const id = identifiers(url)[0]!.endsWith("1") ? 1 : 2;
        const entity = url.searchParams.get("entity");
        return response(
          entity === "macSoftware" ? [entry(id)] : entity === null ? [entry(id, "software")] : []
        );
      })
    );
    const result = await settle(
      new AppStoreLookupClient().lookupOutcomes([
        { ...request(1), identity: undefined },
        { ...request(2, "1", "ios"), identity: undefined }
      ])
    );
    expect(result).toMatchObject([
      { value: { appStoreItemID: 1 } },
      { value: { appStoreItemID: 2 } }
    ]);
    expect(urls.map((url) => url.searchParams.get("entity"))).toEqual([
      "desktopSoftware",
      "software",
      "macSoftware",
      null
    ]);
  });

  it("rediscovers a missing known numeric identity without trusting a different bundle's product", async () => {
    vi.useFakeTimers();
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        urls.push(url);
        return response(
          url.searchParams.has("id")
            ? [{ ...entry(1), bundleId: "com.example.other" }]
            : [{ ...entry(1), trackId: 8 }]
        );
      })
    );
    const result = await settle(new AppStoreLookupClient().lookupOutcomes([request(1)]));
    expect(result).toMatchObject([
      { identity: { productID: 8, platform: "mac", storefront: "us" } }
    ]);
    expect(urls.map((url) => url.searchParams.has("id"))).toEqual([true, false]);
  });

  it("does not treat a lower-platform bulk record as evidence that the requested platform is absent", async () => {
    vi.useFakeTimers();
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        urls.push(url);
        return response(
          identifiers(url).map((id) =>
            entry(
              Number(id),
              identifiers(url).length > 1 ? "software" : "mac-software",
              identifiers(url).length > 1 ? "99" : "3"
            )
          )
        );
      })
    );
    const result = await settle(
      new AppStoreLookupClient().lookupOutcomes([request(1), request(2)], { force: true })
    );
    expect(result).toMatchObject([
      { value: { remoteVersion: version("3") } },
      { value: { remoteVersion: version("3") } }
    ]);
    expect(urls).toHaveLength(3);
  });

  it("individually confirms conflicting platform-qualified versions rather than selecting the first record", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (input: string) => {
      const ids = identifiers(new URL(input)).map(Number);
      return response(
        ids.length > 1
          ? ids.flatMap((id) => [
              entry(id),
              { ...entry(id, "software", "9"), supportedDevices: ["MacDesktop-MacDesktop"] }
            ])
          : ids.map((id) => entry(id, "mac-software", "3"))
      );
    });
    vi.stubGlobal("fetch", fetch);
    const result = await settle(
      new AppStoreLookupClient().lookupOutcomes([request(1), request(2)], { force: true })
    );
    expect(result).toMatchObject([
      { value: { remoteVersion: version("3") } },
      { value: { remoteVersion: version("3") } }
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("App Store batching and lifecycle", () => {
  it.each([false, true])(
    "bounds batches and URLs while keeping 3100ms host pacing (long bundle IDs: %s)",
    async (long) => {
      vi.useFakeTimers();
      const starts: number[] = [],
        urls: URL[] = [];
      const records = Array.from({ length: 70 }, (_, index) =>
        long
          ? {
              ...request(index + 1),
              bundleIdentifier: `com.example.${"x".repeat(220)}${index}`,
              identity: undefined
            }
          : request(index + 1)
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          starts.push(Date.now());
          const url = new URL(input);
          urls.push(url);
          return response(
            identifiers(url).map((id) => (long ? { ...entry(1), bundleId: id } : entry(Number(id))))
          );
        })
      );
      const result = await settle(
        new AppStoreLookupClient().lookupOutcomes(records, { force: true })
      );
      expect(
        result.filter((outcome) => outcome.type === "completed" && outcome.value)
      ).toHaveLength(70);
      expect(urls).toHaveLength(long ? 5 : 3);
      expect(
        urls.every(
          (url) =>
            url.href.length <= 4000 &&
            identifiers(url).length <= 32 &&
            url.searchParams.get("limit") === "200"
        )
      ).toBe(true);
      for (let index = 1; index < starts.length; index++)
        expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(3100);
    }
  );

  it.each(["missing-count", "wrong-count", "unknown-id", "ambiguous", "oversize", "http"])(
    "recovers malformed or failed bulk %s responses using paced individual requests",
    async (failure) => {
      vi.useFakeTimers();
      const starts: number[] = [];
      const fetch = vi.fn(async (input: string) => {
        starts.push(Date.now());
        const ids = identifiers(new URL(input)).map(Number);
        if (ids.length === 1) return response([entry(ids[0]!)]);
        if (failure === "http") return new Response(null, { status: 503 });
        if (failure === "oversize")
          return new Response(" ".repeat(byteLimits.appStoreLookupMaxBytes + 1));
        if (failure === "missing-count") return new Response(JSON.stringify({ results: [] }));
        if (failure === "wrong-count")
          return new Response(JSON.stringify({ resultCount: 1, results: [] }));
        if (failure === "unknown-id") return response([entry(999)]);
        return response([entry(1), entry(1)]);
      });
      vi.stubGlobal("fetch", fetch);
      const result = await settle(
        new AppStoreLookupClient().lookupOutcomes([request(1), request(2)], { force: true })
      );
      expect(result).toMatchObject([
        { value: { appStoreItemID: 1 } },
        { value: { appStoreItemID: 2 } }
      ]);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(starts[1]! - starts[0]!).toBe(3100);
      expect(starts[2]! - starts[1]!).toBe(3100);
    }
  );

  it.each([false, true])(
    "confirms a partial response for cold/previously positive identity discovery (prior positive: %s)",
    async (known) => {
      vi.useFakeTimers();
      let partial = !known;
      const urls: URL[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          const url = new URL(input);
          urls.push(url);
          return response(
            identifiers(url).length > 1
              ? partial
                ? [entry(1)]
                : [entry(1), entry(2)]
              : [entry(2, "mac-software", "3")]
          );
        })
      );
      const client = new AppStoreLookupClient();
      const records = [request(1), request(2)];
      if (known)
        expect((await client.lookupOutcomes(records))[1]).toMatchObject({
          value: { remoteVersion: version("2") }
        });
      partial = true;
      const result = await settle(client.lookupOutcomes(records, { force: true }));
      expect(result[1]).toMatchObject({ value: { remoteVersion: version("3") } });
      expect(urls.at(-1)!.searchParams.get("id")).toBe("2");
      expect(urls).toHaveLength(known ? 3 : 2);
    }
  );

  it("keeps cached omissions transient until an individual confirmation succeeds", async () => {
    vi.useFakeTimers();
    let singles = 0;
    const fetch = vi.fn(async (input: string) => {
      if (identifiers(new URL(input)).length > 1) return response([entry(1)]);
      singles++;
      return singles === 1 ? new Response(null, { status: 503 }) : response([entry(2)]);
    });
    vi.stubGlobal("fetch", fetch);
    const client = new AppStoreLookupClient(),
      records = [request(1), request(2)];
    expect((await settle(client.lookupOutcomes(records, { force: true })))[1]).toEqual({
      type: "transientFailure"
    });
    expect((await settle(client.lookupOutcomes(records)))[1]).toMatchObject({
      value: { appStoreItemID: 2 }
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("records a negative only after individual bundle confirmation and both native scopes", async () => {
    vi.useFakeTimers();
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        urls.push(url);
        return response(identifiers(url).length > 1 ? [entry(1)] : []);
      })
    );
    const records = [request(1), request(2)].map((record) => ({ ...record, identity: undefined }));
    const result = await settle(
      new AppStoreLookupClient().lookupOutcomes(records, { force: true })
    );
    expect(result[1]).toMatchObject({ type: "completed", value: undefined });
    expect(result[1]).not.toHaveProperty("identity");
    expect(
      urls.map((url) => [url.searchParams.get("bundleId"), url.searchParams.get("entity")])
    ).toEqual([
      ["com.example.app1,com.example.app2", "desktopSoftware"],
      ["com.example.app2", "desktopSoftware"],
      ["com.example.app2", "macSoftware"]
    ]);
  });

  it("compares cached metadata to newly scanned versions and refreshes forced manual checks", async () => {
    vi.useFakeTimers();
    let remote = "2";
    const fetch = vi.fn(async () => response([entry(1, "mac-software", remote), entry(2)]));
    vi.stubGlobal("fetch", fetch);
    const client = new AppStoreLookupClient();
    expect((await client.lookupOutcomes([request(1), request(2, "3")]))[0]).toMatchObject({
      value: { remoteVersion: version("2") }
    });
    expect((await client.lookupOutcomes([request(1, "2"), request(2, "3")]))[0]).toMatchObject({
      value: undefined,
      identity: request(1).identity
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    remote = "3";
    expect(
      (await settle(client.lookupOutcomes([request(1, "2"), request(2, "3")], { force: true })))[0]
    ).toMatchObject({ value: { remoteVersion: version("3") } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight batch while allowing one consumer to cancel independently", async () => {
    let finish!: () => void, source!: AbortSignal;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fetch = vi.fn(async (_input: string, options: RequestInit) => {
      source = options.signal!;
      await gate;
      return response([entry(1), entry(2)]);
    });
    vi.stubGlobal("fetch", fetch);
    const client = new AppStoreLookupClient(),
      controller = new AbortController();
    const first = client.lookupOutcomes([request(1), request(2)], {
      force: true,
      signal: controller.signal
    });
    const second = client.lookupOutcomes([request(2, "3"), request(1, "3")], { force: true });
    try {
      await vi.waitFor(() => expect(source).toBeDefined());
      controller.abort();
      expect(await first).toEqual([{ type: "transientFailure" }, { type: "transientFailure" }]);
      expect(source.aborted).toBe(false);
      finish();
      expect(await second).toMatchObject([
        { value: undefined, identity: request(2).identity },
        { value: undefined, identity: request(1).identity }
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await Promise.all([first, second]);
    }
  });

  it("does not cache cancelled work or dispatch fallbacks after all consumers leave", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      return response([entry(1), entry(2)]);
    });
    vi.stubGlobal("fetch", fetch);
    const client = new AppStoreLookupClient(),
      controller = new AbortController(),
      records = [request(1), request(2)];
    const first = client.lookupOutcomes(records, { force: true, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await first).toEqual([{ type: "transientFailure" }, { type: "transientFailure" }]);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await settle(client.lookupOutcomes(records)))[0]).toMatchObject({
      value: { appStoreItemID: 1 }
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("honors a batch Retry-After without making fallback requests", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 429, headers: { "retry-after": "60" } })
    );
    vi.stubGlobal("fetch", fetch);
    expect(
      await new AppStoreLookupClient().lookupOutcomes([request(1), request(2)], { force: true })
    ).toEqual([{ type: "transientFailure" }, { type: "transientFailure" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors a late 429 with independent batches already queued and in flight", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const fetch = vi.fn(async (input: string) => {
      starts.push(Date.now());
      const first = starts.length === 1;
      await new Promise((resolve) => setTimeout(resolve, first ? 4000 : 100));
      return first
        ? new Response(null, { status: 429, headers: { "retry-after": "60" } })
        : response(identifiers(new URL(input)).map((id) => entry(Number(id))));
    });
    vi.stubGlobal("fetch", fetch);
    const result = await settle(
      new AppStoreLookupClient().lookupOutcomes(
        Array.from({ length: 70 }, (_, i) => request(i + 1)),
        { force: true }
      )
    );
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBe(3100);
    expect(result.filter((outcome) => outcome.type === "completed" && outcome.value)).toHaveLength(
      32
    );
  });

  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])(
    "does not send invalid persisted numeric identity %s",
    async (productID) => {
      const fetch = vi.fn(async () => response([entry(1)]));
      vi.stubGlobal("fetch", fetch);
      const client = new AppStoreLookupClient();
      expect(
        (
          await client.lookupOutcomes([
            { ...request(1), identity: { ...request(1).identity!, productID } }
          ])
        )[0]
      ).toMatchObject({ identity: request(1).identity });
      expect(
        new URL((fetch.mock.calls as unknown as [string][])[0]![0]).searchParams.has("id")
      ).toBe(false);
    }
  );
});

it("keeps unresolved single-product platform ambiguity transient", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response([
        entry(1),
        { ...entry(1, "software", "9"), supportedDevices: ["MacDesktop-MacDesktop"] }
      ])
    )
  );
  expect(await new AppStoreLookupClient().lookupOutcomes([request(1)])).toEqual([
    { type: "transientFailure" }
  ]);
});

it("does not accept a completed miss when the final compatibility confirmation fails", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (input: string) =>
    new URL(input).searchParams.get("entity") === "macSoftware"
      ? new Response(null, { status: 503 })
      : response([])
  );
  vi.stubGlobal("fetch", fetch);
  expect(
    await settle(
      new AppStoreLookupClient().lookupOutcomes([{ ...request(1), identity: undefined }])
    )
  ).toEqual([{ type: "transientFailure" }]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("reuses confirmed negative discovery for six hours while manual checks discover new products immediately", async () => {
  vi.useFakeTimers();
  let available = false;
  const fetch = vi.fn(async () => response(available ? [entry(1)] : []));
  vi.stubGlobal("fetch", fetch);
  const client = new AppStoreLookupClient(),
    records = [{ ...request(1), identity: undefined }];
  expect(await settle(client.lookupOutcomes(records))).toMatchObject([
    { type: "completed", value: undefined }
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
  available = true;
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(await client.lookupOutcomes(records)).toMatchObject([
    { type: "completed", value: undefined }
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await settle(client.lookupOutcomes(records, { force: true }))).toMatchObject([
    { value: { appStoreItemID: 1 }, identity: request(1).identity }
  ]);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("expires confirmed negative discovery after six hours", async () => {
  vi.useFakeTimers();
  let available = false;
  const fetch = vi.fn(async () => response(available ? [entry(1)] : []));
  vi.stubGlobal("fetch", fetch);
  const client = new AppStoreLookupClient(),
    records = [{ ...request(1), identity: undefined }];
  await settle(client.lookupOutcomes(records));
  available = true;
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  expect(await settle(client.lookupOutcomes(records))).toMatchObject([
    { identity: request(1).identity }
  ]);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("does not dispatch queued batches after cancellation", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn(async (input: string) => {
    await gate;
    return response(identifiers(new URL(input)).map((id) => entry(Number(id))));
  });
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const task = new AppStoreLookupClient().lookupOutcomes(
    Array.from({ length: 70 }, (_, i) => request(i + 1)),
    { force: true, signal: controller.signal }
  );
  try {
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect((await task).every((outcome) => outcome.type === "transientFailure")).toBe(true);
    release();
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    release();
    await vi.runAllTimersAsync();
    await task;
  }
});

it.each(["bundle", "metadata", "devices", "invalid-product"])(
  "does not cache invalid individual %s metadata as a miss",
  async (field) => {
    vi.useFakeTimers();
    let malformed = true;
    const fetch = vi.fn(async () =>
      response([
        malformed
          ? {
              ...entry(1),
              ...(field === "bundle"
                ? { bundleId: "com.example.other" }
                : field === "metadata"
                  ? { trackViewUrl: 42 }
                  : field === "devices"
                    ? { supportedDevices: { MacDesktop: true } }
                    : { trackId: 0 })
            }
          : entry(1)
      ])
    );
    vi.stubGlobal("fetch", fetch);
    const client = new AppStoreLookupClient();
    expect(await settle(client.lookupOutcomes([{ ...request(1), identity: undefined }]))).toEqual([
      { type: "transientFailure" }
    ]);
    malformed = false;
    expect(
      await settle(client.lookupOutcomes([{ ...request(1), identity: undefined }]))
    ).toMatchObject([{ identity: request(1).identity }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  }
);

it("publishes confirmed batch outcomes before a missing product's slow individual confirmation", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (identifiers(new URL(input)).length > 1) return response([entry(1)]);
      await gate;
      return response([entry(2)]);
    })
  );
  const observed: number[] = [];
  const task = new AppStoreLookupClient().lookupOutcomes([request(1), request(2)], {
    force: true,
    onOutcome: (index) => {
      observed.push(index);
    }
  });
  try {
    await vi.advanceTimersByTimeAsync(3100);
    expect(observed).toEqual([0]);
    release();
    await vi.runAllTimersAsync();
    expect(await task).toMatchObject([
      { value: { appStoreItemID: 1 } },
      { value: { appStoreItemID: 2 } }
    ]);
    expect(observed).toEqual([0, 1]);
  } finally {
    release();
    await vi.runAllTimersAsync();
    await task;
  }
});

it("reports each remaining cancelled index once and keeps earlier outcomes aligned", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (identifiers(new URL(input)).length > 1) return response([entry(1)]);
      await gate;
      return response([entry(2)]);
    })
  );
  const controller = new AbortController(),
    observed: { index: number; type: string }[] = [];
  const task = new AppStoreLookupClient().lookupOutcomes([request(1), request(2)], {
    force: true,
    signal: controller.signal,
    onOutcome: (index, outcome) => {
      observed.push({ index, type: outcome.type });
    }
  });
  try {
    await vi.advanceTimersByTimeAsync(3100);
    controller.abort();
    expect(await task).toMatchObject([
      { value: { appStoreItemID: 1 } },
      { type: "transientFailure" }
    ]);
    expect(observed).toEqual([
      { index: 0, type: "completed" },
      { index: 1, type: "transientFailure" }
    ]);
    release();
    await vi.runAllTimersAsync();
    expect(observed).toHaveLength(2);
  } finally {
    controller.abort();
    release();
    await vi.runAllTimersAsync();
    await task;
  }
});

it("does not let a failing progress observer discard verified metadata", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response([entry(1), entry(2)]))
  );
  const onOutcome = vi.fn(() => {
    throw new Error("observer failed");
  });
  expect(
    await new AppStoreLookupClient().lookupOutcomes([request(1), request(2)], { onOutcome })
  ).toMatchObject([{ identity: request(1).identity }, { identity: request(2).identity }]);
  expect(onOutcome).toHaveBeenCalledTimes(2);
});

it.each(["http", "protocol", "metadata"])(
  "keeps known numeric %s failures transient without authorizing bundle discovery negatives",
  async (failure) => {
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        urls.push(new URL(input));
        return failure === "http"
          ? new Response(null, { status: 503 })
          : failure === "protocol"
            ? new Response(JSON.stringify({ results: [] }))
            : response([{ ...entry(1), releaseNotes: { text: "notes" } }]);
      })
    );
    expect(await new AppStoreLookupClient().lookupOutcomes([request(1)])).toEqual([
      { type: "transientFailure" }
    ]);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.get("id")).toBe("1");
  }
);

it("accepts a known numeric omission as negative only after exact-bundle discovery scopes finish", async () => {
  vi.useFakeTimers();
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      urls.push(new URL(input));
      return response([]);
    })
  );
  expect(await settle(new AppStoreLookupClient().lookupOutcomes([request(1)]))).toMatchObject([
    { type: "completed", value: undefined }
  ]);
  expect(
    urls.map((url) => [
      url.searchParams.get("id"),
      url.searchParams.get("bundleId"),
      url.searchParams.get("entity")
    ])
  ).toEqual([
    ["1", null, "desktopSoftware"],
    [null, "com.example.app1", "desktopSoftware"],
    [null, "com.example.app1", "macSoftware"]
  ]);
});

it.each([
  { releaseNotes: { text: "notes" } },
  { version: 2 },
  { trackViewUrl: { href: "https://example.com" } },
  { supportedDevices: { MacDesktop: true } },
  { currentVersionReleaseDate: [] }
])("rejects malformed direct-parser metadata %j", async (malformed) => {
  const client = new AppStoreLookupClient();
  expect(
    client.parseLookupResponse(
      Buffer.from(JSON.stringify({ results: [{ ...entry(1), ...malformed }] })),
      version("1"),
      {
        bundleIdentifier: request(1).bundleIdentifier
      }
    )
  ).toBeUndefined();
});

it.each([false, true])(
  "invalidates old-storefront identities and discovers only in the current client storefront (batch: %s)",
  async (batch) => {
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        urls.push(url);
        return response(
          identifiers(url).map((bundleId) => {
            const id = Number(bundleId.replace("com.example.app", ""));
            return { ...entry(id), trackId: id + 100 };
          })
        );
      })
    );
    const client = new AppStoreLookupClient("GB");
    const outcomes = batch
      ? await client.lookupOutcomes([request(1), request(2)], { force: true })
      : [
          await client.lookupOutcome(request(1).bundleIdentifier, version("1"), {
            identity: request(1).identity,
            force: true
          })
        ];
    expect(client.storefront).toBe("gb");
    expect(outcomes).toMatchObject(
      batch
        ? [
            { discovered: true, identity: { productID: 101, storefront: "gb" } },
            { discovered: true, identity: { productID: 102, storefront: "gb" } }
          ]
        : [{ discovered: true, identity: { productID: 101, storefront: "gb" } }]
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.has("id")).toBe(false);
    expect(urls[0]!.searchParams.get("country")).toBe("gb");
    expect(urls[0]!.searchParams.get("bundleId")).toBe(
      batch ? "com.example.app1,com.example.app2" : "com.example.app1"
    );
  }
);

it("reports numeric version checks independently from bundle discovery provenance", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      response(
        identifiers(new URL(input)).map((id) => {
          return entry(
            id.startsWith("com.example.") ? Number(id.replace("com.example.app", "")) : Number(id)
          );
        })
      )
    )
  );
  const client = new AppStoreLookupClient();
  const discovered = await client.lookupOutcomes(
    [
      { ...request(1), identity: undefined },
      { ...request(2), identity: undefined }
    ],
    { force: true }
  );
  expect(discovered).toMatchObject([
    { discovered: true, identity: request(1).identity },
    { discovered: true, identity: request(2).identity }
  ]);
  const discovery = discovered[0]!;
  const discoveryTime = discovery.type === "completed" ? discovery.checkedAt : undefined;
  await vi.advanceTimersByTimeAsync(60_000);
  const checked = await settle(client.lookupOutcomes([request(1), request(2)], { force: true }));
  expect(checked).toMatchObject([
    { discovered: false, identity: request(1).identity },
    { discovered: false, identity: request(2).identity }
  ]);
  const numeric = checked[0]!;
  expect(numeric.type === "completed" && numeric.checkedAt).not.toBe(discoveryTime);
});

it("marks numeric omission recovery as bundle discovery", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      response(new URL(input).searchParams.has("id") ? [] : [entry(1)])
    )
  );
  expect(
    await settle(new AppStoreLookupClient().lookupOutcomes([request(1)], { force: true }))
  ).toMatchObject([{ discovered: true, identity: request(1).identity }]);
});

it("keeps cached discovery provenance tied to the original lookup timestamp", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => response([entry(1)]));
  vi.stubGlobal("fetch", fetch);
  const client = new AppStoreLookupClient(),
    records = [{ ...request(1), identity: undefined }];
  const first = await client.lookupOutcomes(records);
  await vi.advanceTimersByTimeAsync(60_000);
  const reused = await client.lookupOutcomes(records);
  expect(reused).toEqual(first);
  expect(reused).toMatchObject([{ discovered: true }]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects App Store versions with no numeric component and retries without caching malformed metadata", async () => {
  vi.useFakeTimers();
  let remote = "unknown";
  const fetch = vi.fn(async () => response([entry(1, "mac-software", remote)]));
  vi.stubGlobal("fetch", fetch);
  const client = new AppStoreLookupClient();
  expect(
    client.parseLookupResponse(
      Buffer.from(JSON.stringify({ results: [entry(1, "mac-software", remote)] })),
      version("1"),
      {
        bundleIdentifier: request(1).bundleIdentifier
      }
    )
  ).toBeUndefined();
  expect(await client.lookupOutcomes([request(1)])).toEqual([{ type: "transientFailure" }]);
  remote = "v2.0";
  expect(await settle(client.lookupOutcomes([request(1)]))).toMatchObject([
    { type: "completed", identity: request(1).identity, value: { remoteVersion: version("v2.0") } }
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
