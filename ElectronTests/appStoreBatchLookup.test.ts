// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStoreLookupClient, type AppStoreLookupRequest } from "../src/main/appStoreLookupClient";
import { version } from "../src/shared/version";

const request = (id: string, local = "1"): AppStoreLookupRequest => ({
  bundleIdentifier: `com.example.${id}`,
  localVersion: version(local)
});
const entry = (id: string, kind = "mac-software") => ({
  bundleId: `com.example.${id}`,
  kind,
  version: "2",
  trackId: id === "one" ? 1 : 2,
  trackViewUrl: "https://apps.apple.com/app/id1"
});
const response = (results: unknown[]) =>
  new Response(JSON.stringify({ resultCount: results.length, results }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("App Store batch lookup", () => {
  it("correlates unordered metadata and compares duplicate consumers' installed versions independently", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      urls.push(url);
      return response([entry("two"), entry("present_with_underscore"), entry("one")]);
    });
    vi.stubGlobal("fetch", fetch);
    const client = new AppStoreLookupClient();
    const result = await client.lookupOutcomes(
      [
        request("one"),
        request("two", "3"),
        request("present_with_underscore", "3"),
        request("one", "2")
      ],
      { force: true }
    );
    expect(result).toMatchObject([
      { type: "completed", value: { appStoreItemID: 1 } },
      { type: "completed", value: undefined },
      { type: "completed", value: undefined },
      { type: "completed", value: undefined }
    ]);
    expect(result.every((outcome) => outcome.type === "completed" && outcome.checkedAt)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(urls[0]!);
    expect(url.searchParams.get("bundleId")?.split(",")).toEqual([
      "com.example.one",
      "com.example.present_with_underscore",
      "com.example.two"
    ]);
  });

  it("separates entity policies and retains each consumer's iOS and Mac-capable eligibility", async () => {
    vi.useFakeTimers();
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url);
        urls.push(parsed);
        return response(
          parsed.searchParams
            .get("bundleId")!
            .split(",")
            .map((bundleId) => ({
              bundleId,
              kind: "software",
              version: "2",
              supportedDevices: ["MacDesktop-MacDesktop"]
            }))
        );
      })
    );
    const records = [
      request("native"),
      { ...request("extension"), includeMacCapableAppStoreSoftware: true },
      { ...request("ios-one"), includeIOSAppStoreSoftware: true },
      { ...request("ios-two"), includeIOSAppStoreSoftware: true }
    ];
    const task = new AppStoreLookupClient().lookupOutcomes(records, { force: true });
    try {
      await vi.runAllTimersAsync();
      const result = await task;
      expect(result[0]).toMatchObject({ type: "completed", value: undefined });
      expect(
        result.slice(1).every((outcome) => outcome.type === "completed" && outcome.value)
      ).toBe(true);
      expect(urls.map((url) => url.searchParams.get("entity"))).toEqual([
        "macSoftware",
        "macSoftware",
        "macSoftware",
        null
      ]);
    } finally {
      await vi.runAllTimersAsync();
      await task;
    }
  });

  it.each([false, true])(
    "bounds batch size and URL length while retaining every identifier (long IDs: %s)",
    async (longIDs) => {
      vi.useFakeTimers();
      const starts: number[] = [];
      const urls: URL[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          starts.push(Date.now());
          urls.push(new URL(url));
          return response(
            new URL(url).searchParams
              .get("bundleId")!
              .split(",")
              .map((bundleId) => ({ ...entry("one"), bundleId }))
          );
        })
      );
      const records = Array.from({ length: 70 }, (_, index) =>
        request(`${longIDs ? "x".repeat(220) : "app"}${index}`)
      );
      const task = new AppStoreLookupClient().lookupOutcomes(records, { force: true });
      try {
        await vi.runAllTimersAsync();
        expect(await task).toHaveLength(70);
        expect(urls).toHaveLength(longIDs ? 5 : 3);
        expect(urls.flatMap((url) => url.searchParams.get("bundleId")!.split(",")).sort()).toEqual(
          records.map((record) => record.bundleIdentifier).sort()
        );
        expect(
          urls.every(
            (url) =>
              url.href.length <= 4000 &&
              url.searchParams.get("bundleId")!.split(",").length <= 32 &&
              url.searchParams.get("limit") === "200"
          )
        ).toBe(true);
        expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(3100);
        expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(3100);
      } finally {
        await vi.runAllTimersAsync();
        await task;
      }
    }
  );

  it.each(["missing-count", "wrong-count", "unknown-id", "ambiguous", "oversize", "http"])(
    "falls back to fresh paced individual checks on %s",
    async (failure) => {
      vi.useFakeTimers();
      const starts: number[] = [];
      const fetch = vi.fn(async (url: string) => {
        starts.push(Date.now());
        const ids = new URL(url).searchParams.get("bundleId")!.split(",");
        if (ids.length === 1) return response([entry(ids[0]!.endsWith("one") ? "one" : "two")]);
        if (failure === "http") return new Response(null, { status: 503 });
        if (failure === "oversize") return new Response(" ".repeat(1024 * 1024 + 1));
        if (failure === "missing-count") return new Response(JSON.stringify({ results: [] }));
        if (failure === "wrong-count")
          return new Response(JSON.stringify({ resultCount: 1, results: [] }));
        if (failure === "unknown-id") return response([entry("other")]);
        return response([entry("one"), entry("one")]);
      });
      vi.stubGlobal("fetch", fetch);
      const task = new AppStoreLookupClient().lookupOutcomes([request("one"), request("two")], {
        force: true
      });
      try {
        await vi.runAllTimersAsync();
        const result = await task;
        expect(result.every((outcome) => outcome.type === "completed" && outcome.value)).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(3100);
        expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(3100);
      } finally {
        await vi.runAllTimersAsync();
        await task;
      }
    }
  );

  it("shares an in-flight batch and cancels only the departing consumer", async () => {
    let finish!: () => void;
    let source!: AbortSignal;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        source = options.signal;
        await gate;
        return response([entry("one"), entry("two")]);
      })
    );
    const client = new AppStoreLookupClient();
    const controller = new AbortController();
    const first = client.lookupOutcomes([request("one"), request("two")], {
      force: true,
      signal: controller.signal
    });
    const second = client.lookupOutcomes([request("two", "3"), request("one", "3")], {
      force: true
    });
    try {
      await vi.waitFor(() => expect(source).toBeDefined());
      controller.abort();
      expect(await first).toEqual([{ type: "transientFailure" }, { type: "transientFailure" }]);
      expect(source.aborted).toBe(false);
      finish();
      expect(await second).toMatchObject([
        { type: "completed", value: undefined },
        { type: "completed", value: undefined }
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      finish?.();
      await Promise.all([first, second]);
    }
  });

  it("honors batch Retry-After without issuing individual fallback requests", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 429, headers: { "retry-after": "60" } })
    );
    vi.stubGlobal("fetch", fetch);
    const result = await new AppStoreLookupClient().lookupOutcomes(
      [request("one"), request("two")],
      { force: true }
    );
    expect(result).toEqual([{ type: "transientFailure" }, { type: "transientFailure" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("reuses fresh metadata for changed installed versions but revalidates forced manual batches", async () => {
  vi.useFakeTimers();
  let remote = "2";
  const fetch = vi.fn(async () => response([{ ...entry("one"), version: remote }, entry("two")]));
  vi.stubGlobal("fetch", fetch);
  const client = new AppStoreLookupClient();
  const first = await client.lookupOutcomes([request("one"), request("two", "3")]);
  expect(first[0]).toMatchObject({ type: "completed", value: { remoteVersion: version("2") } });
  const cached = await client.lookupOutcomes([request("one", "2"), request("two", "3")]);
  expect(cached[0]).toMatchObject({ type: "completed", value: undefined });
  expect(fetch).toHaveBeenCalledTimes(1);
  remote = "3";
  const forced = client.lookupOutcomes([request("one", "2"), request("two", "3")], { force: true });
  try {
    await vi.runAllTimersAsync();
    expect((await forced)[0]).toMatchObject({
      type: "completed",
      value: { remoteVersion: version("3") }
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    await vi.runAllTimersAsync();
    await forced;
  }
});

it("does not cache a cancelled batch or dispatch fallback after its last consumer leaves", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    return response([entry("one"), entry("two")]);
  });
  vi.stubGlobal("fetch", fetch);
  const client = new AppStoreLookupClient();
  const controller = new AbortController();
  const records = [request("one"), request("two")];
  const first = client.lookupOutcomes(records, { force: true, signal: controller.signal });
  try {
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await first).toEqual([{ type: "transientFailure" }, { type: "transientFailure" }]);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    const replacement = client.lookupOutcomes(records);
    await vi.runAllTimersAsync();
    expect((await replacement)[0]).toMatchObject({
      type: "completed",
      value: { remoteVersion: version("2") }
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    await vi.runAllTimersAsync();
    await first;
  }
});

it.each([false, true])(
  "individually confirms a well-shaped partial batch for a previously known match: %s",
  async (known) => {
    vi.useFakeTimers();
    const urls: URL[] = [];
    let partial = !known;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url);
        urls.push(parsed);
        if (parsed.searchParams.get("bundleId")!.includes(","))
          return response(partial ? [entry("one")] : [entry("one"), entry("two")]);
        return response([{ ...entry("two"), version: "3" }]);
      })
    );
    const client = new AppStoreLookupClient();
    const records = [request("one"), request("two")];
    if (known)
      expect((await client.lookupOutcomes(records))[1]).toMatchObject({
        type: "completed",
        value: { remoteVersion: version("2") }
      });
    partial = true;
    const task = client.lookupOutcomes(records, { force: true });
    try {
      await vi.runAllTimersAsync();
      expect((await task)[1]).toMatchObject({
        type: "completed",
        value: { remoteVersion: version("3") }
      });
      expect(urls.at(-1)!.searchParams.get("bundleId")).toBe("com.example.two");
      expect(urls).toHaveLength(known ? 3 : 2);
    } finally {
      await vi.runAllTimersAsync();
      await task;
    }
  }
);

it("accepts a missing identifier as a completed negative only after its individual confirmation", async () => {
  vi.useFakeTimers();
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const parsed = new URL(url);
      urls.push(parsed);
      return response(parsed.searchParams.get("bundleId")!.includes(",") ? [entry("one")] : []);
    })
  );
  const task = new AppStoreLookupClient().lookupOutcomes([request("one"), request("two")], {
    force: true
  });
  try {
    await vi.runAllTimersAsync();
    expect((await task)[1]).toMatchObject({ type: "completed", value: undefined });
    expect(urls).toHaveLength(2);
    expect(urls[1]!.searchParams.get("bundleId")).toBe("com.example.two");
  } finally {
    await vi.runAllTimersAsync();
    await task;
  }
});

it("never promotes a cached omission to a completed miss after individual confirmation failed", async () => {
  vi.useFakeTimers();
  let singles = 0;
  const fetch = vi.fn(async (url: string) => {
    if (new URL(url).searchParams.get("bundleId")!.includes(",")) return response([entry("one")]);
    singles++;
    return singles === 1 ? new Response(null, { status: 503 }) : response([entry("two")]);
  });
  vi.stubGlobal("fetch", fetch);
  const client = new AppStoreLookupClient();
  const records = [request("one"), request("two")];
  const first = client.lookupOutcomes(records, { force: true });
  try {
    await vi.runAllTimersAsync();
    expect((await first)[1]).toEqual({ type: "transientFailure" });
    const retry = client.lookupOutcomes(records);
    await vi.runAllTimersAsync();
    expect((await retry)[1]).toMatchObject({
      type: "completed",
      value: { remoteVersion: version("2") }
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    await vi.runAllTimersAsync();
    await first;
  }
});

it.each(["ios", "mac-compatible"])(
  "confirms an omitted preferred platform record instead of trusting a lower-priority %s match",
  async (platform) => {
    vi.useFakeTimers();
    const ios = platform === "ios";
    const fetch = vi.fn(async (url: string) => {
      const ids = new URL(url).searchParams.get("bundleId")!.split(",");
      return response(
        ids.map((bundleId) => ({
          ...entry(
            "one",
            ids.length > 1 ? (ios ? "mac-software" : "software") : ios ? "software" : "mac-software"
          ),
          bundleId,
          version: ids.length > 1 ? "2" : "3",
          supportedDevices: ["MacDesktop-MacDesktop"]
        }))
      );
    });
    vi.stubGlobal("fetch", fetch);
    const records = [request("one"), request("two")].map((record) => ({
      ...record,
      includeIOSAppStoreSoftware: ios,
      includeMacCapableAppStoreSoftware: !ios
    }));
    const task = new AppStoreLookupClient().lookupOutcomes(records, { force: true });
    try {
      await vi.runAllTimersAsync();
      expect(
        (await task).every(
          (outcome) => outcome.type === "completed" && outcome.value?.remoteVersion.raw === "3"
        )
      ).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      await vi.runAllTimersAsync();
      await task;
    }
  }
);
