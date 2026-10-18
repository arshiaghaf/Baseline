// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { XMLParser } from "fast-xml-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupAppUpdates } from "../src/main/appUpdateLookupService";
import { SparkleAppcastClient } from "../src/main/sparkleAppcastClient";
import type { AppProviderCheck, AppRecord } from "../src/shared/domain";
import { emptyHomebrewCaskIndex } from "../src/shared/domain";
import { byteLimits } from "../src/shared/security";
import { version } from "../src/shared/version";

const feedURL = "https://example.com/appcast.xml";
const release = (marketing = "2.0", build = "201") =>
  `<item><enclosure url="https://example.com/release.zip" sparkle:shortVersionString="${marketing}" sparkle:version="${build}" /></item>`;
const feed = (items = release()) => `<rss><channel><title>Example</title>${items}</channel></rss>`;
const options = () => ({ signal: new AbortController().signal, force: true });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-18T12:00:00Z");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function paced<T>(task: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(1000);
  return task;
}

describe("Sparkle refresh metadata reuse", () => {
  it("shares one fetch/decode across worker waves and revalidates every manual refresh", async () => {
    const fetchMock = vi.fn(async () => new Response(feed()));
    vi.stubGlobal("fetch", fetchMock);
    const parse = vi.spyOn(XMLParser.prototype, "parse");
    const client = new SparkleAppcastClient();
    const apps: AppRecord[] = Array.from({ length: 9 }, (_, i) => ({
      id: `app-${i}`,
      displayName: `Example ${i}`,
      bundlePath: `/Applications/Example ${i}.app`,
      localVersion: version(i % 3 === 0 ? "1.0" : "2.0"),
      bundleVersion: version(i % 3 === 2 ? "201" : "200"),
      sparkleFeedURL: feedURL,
      sourceHint: "sparkle"
    }));
    const checks: Record<string, AppProviderCheck> = {};
    const clients = {
      sparkle: client,
      appStore: { lookupOutcome: vi.fn() },
      homebrew: { lookupUpdate: vi.fn() }
    };
    const input = {
      apps,
      previousUpdates: new Map(),
      homebrewItems: [],
      homebrewIndex: emptyHomebrewCaskIndex,
      now: new Date().toISOString(),
      ...options(),
      isCurrent: () => true,
      isSelfApp: () => false,
      canUseHomebrewAppUpdate: () => false,
      onProgress: (next: Record<string, AppProviderCheck>) => Object.assign(checks, next)
    };
    const firstTask = lookupAppUpdates(clients, input);
    await vi.runAllTimersAsync();
    const first = await firstTask;
    expect(first?.map((update) => update.appID)).toEqual([
      "app-0",
      "app-1",
      "app-3",
      "app-4",
      "app-6",
      "app-7"
    ]);
    expect(first?.every((update) => update.remoteVersion.raw === "2.0")).toBe(true);
    expect(Object.values(checks)).toHaveLength(9);
    expect(Object.values(checks).every((check) => check.status === "checked")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    const checkedAt = first![0]!.checkedAt;

    fetchMock.mockImplementation(async () => new Response(feed(release("3.0", "300"))));
    const nextInput = {
      ...input,
      ...options(),
      previousUpdates: new Map(first!.map((update) => [update.appID, update]))
    };
    const secondTask = lookupAppUpdates(clients, nextInput);
    await vi.runAllTimersAsync();
    const second = await secondTask;
    expect(second).toHaveLength(9);
    expect(second?.every((update) => update.remoteVersion.raw === "3.0")).toBe(true);
    expect(second![0]!.checkedAt).not.toBe(checkedAt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parse).toHaveBeenCalledTimes(2);

    fetchMock.mockImplementation(async () => new Response("Unavailable", { status: 503 }));
    const failedTask = lookupAppUpdates(clients, {
      ...input,
      ...options(),
      previousUpdates: new Map(second!.map((update) => [update.appID, update]))
    });
    // Failure is retryable within a refresh, so later worker waves may retry.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await failedTask).toEqual(second);
    expect(Object.values(checks).every((check) => check.status === "failed")).toBe(true);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("selects per-app releases without exposing mutable shared version objects", async () => {
    const fetchMock = vi.fn(async () => new Response(feed(release() + release("2.0-beta", "205"))));
    vi.stubGlobal("fetch", fetchMock);
    const parse = vi.spyOn(XMLParser.prototype, "parse");
    const client = new SparkleAppcastClient();
    const refresh = options();
    const first = await paced(client.lookupOutcome(feedURL, version("1"), version("100"), refresh));
    expect(first).toMatchObject({ value: { remoteVersion: version("2.0") } });
    if (first.type === "completed" && first.value) {
      first.value.remoteVersion.raw = "999";
      first.value.remoteBuildVersion!.raw = "999";
    }
    expect(
      await client.lookupOutcome(feedURL, version("2"), version("200"), refresh)
    ).toMatchObject({
      providerFound: true,
      value: { remoteVersion: version("2.0"), remoteBuildVersion: version("201") }
    });
    expect(
      await client.lookupOutcome(feedURL, version("2"), version("201"), refresh)
    ).toMatchObject({
      providerFound: true,
      value: undefined
    });
    expect(
      await client.lookupOutcome(feedURL, version("2.0-beta"), version("204"), refresh)
    ).toMatchObject({
      value: { remoteVersion: version("2.0-beta"), remoteBuildVersion: version("205") }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("keeps exact feed URLs separate, including channel and platform parameters", async () => {
    const fetchMock = vi.fn(
      async (url: string) => new Response(feed(release(url.includes("beta") ? "3.0-beta" : "2.0")))
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SparkleAppcastClient();
    const refresh = options();
    const urls = [feedURL, `${feedURL}?channel=beta`, `${feedURL}?platform=arm64`];
    for (const url of urls) {
      const result = await paced(client.lookupOutcome(url, version("1"), undefined, refresh));
      expect(result).toMatchObject({
        value: { remoteVersion: version(url.includes("beta") ? "3.0-beta" : "2.0") }
      });
    }
    for (const url of urls) await client.lookupOutcome(url, version("1"), undefined, refresh);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(urls);
  });

  it("does not let cached reads or unscoped forced calls satisfy fresh forced lookups", async () => {
    const fetchMock = vi.fn(async () => new Response(feed()));
    vi.stubGlobal("fetch", fetchMock);
    const parse = vi.spyOn(XMLParser.prototype, "parse");
    const client = new SparkleAppcastClient();
    const refresh = options();
    const cached = await paced(
      client.lookupOutcome(feedURL, version("1"), undefined, { signal: refresh.signal })
    );
    await client.lookupOutcome(feedURL, version("1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(async () => new Response(feed(release("3.0"))));
    const fresh = await paced(client.lookupOutcome(feedURL, version("1"), undefined, refresh));
    expect(fresh).toMatchObject({ value: { remoteVersion: version("3.0") } });
    expect(fresh).not.toEqual(cached);
    for (let i = 0; i < 2; i++)
      await paced(client.lookupOutcome(feedURL, version("1"), undefined, { force: true }));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(parse).toHaveBeenCalledTimes(4);
  });

  it.each(["http", "malformed", "oversized"])(
    "retries %s failures within a refresh without claiming a provider",
    async (failure) => {
      const fetchMock = vi.fn(async () =>
        failure === "http"
          ? new Response("Unavailable", { status: 503 })
          : new Response(
              failure === "malformed"
                ? "<html>Unavailable</html>"
                : " ".repeat(byteLimits.sparkleAppcastMaxBytes + 1)
            )
      );
      vi.stubGlobal("fetch", fetchMock);
      const client = new SparkleAppcastClient();
      const refresh = options();
      expect(await paced(client.lookupOutcome(feedURL, version("1"), undefined, refresh))).toEqual({
        type: "transientFailure"
      });
      fetchMock.mockImplementation(async () => new Response(feed()));
      expect(
        await paced(client.lookupOutcome(feedURL, version("1"), undefined, refresh))
      ).toMatchObject({
        type: "completed",
        providerFound: true,
        value: { remoteVersion: version("2.0") }
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  it("reuses empty valid responses without claiming a provider, and rechecks them next refresh", async () => {
    const fetchMock = vi.fn(async () => new Response(feed("")));
    vi.stubGlobal("fetch", fetchMock);
    const parse = vi.spyOn(XMLParser.prototype, "parse");
    const client = new SparkleAppcastClient();
    const refresh = options();
    const first = await paced(client.lookupOutcome(feedURL, version("1"), undefined, refresh));
    expect(first).toMatchObject({ type: "completed", providerFound: false, value: undefined });
    expect(await client.lookupOutcome(feedURL, version("1"), undefined, refresh)).toEqual(first);
    expect(parse).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(async () => new Response(feed()));
    expect(
      await paced(client.lookupOutcome(feedURL, version("1"), undefined, options()))
    ).toMatchObject({ providerFound: true, value: { remoteVersion: version("2.0") } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After without retaining a failed refresh response", async () => {
    const fetchMock = vi.fn(
      async () => new Response("Paused", { status: 429, headers: { "Retry-After": "60" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SparkleAppcastClient();
    const refresh = options();
    expect(await paced(client.lookupOutcome(feedURL, version("1"), undefined, refresh))).toEqual({
      type: "transientFailure"
    });
    expect(await paced(client.lookupOutcome(feedURL, version("1"), undefined, refresh))).toEqual({
      type: "transientFailure"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(async () => new Response(feed()));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await client.lookupOutcome(feedURL, version("1"), undefined, refresh)).toMatchObject({
      providerFound: true
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not serve retained metadata to an aborted refresh", async () => {
    const fetchMock = vi.fn(async () => new Response(feed()));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SparkleAppcastClient();
    const controller = new AbortController();
    const refresh = { signal: controller.signal, force: true };
    await paced(client.lookupOutcome(feedURL, version("1"), undefined, refresh));
    controller.abort();
    expect(await client.lookupOutcome(feedURL, version("1"), undefined, refresh)).toEqual({
      type: "transientFailure"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      await paced(client.lookupOutcome(feedURL, version("1"), undefined, options()))
    ).toMatchObject({ providerFound: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a shared in-flight fetch alive while another refresh still needs it", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let releaseResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    });
    let networkSignal!: AbortSignal;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      networkSignal = init!.signal!;
      started();
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SparkleAppcastClient();
    const first = new AbortController();
    const second = options();
    const tasks = [
      client.lookupOutcome(feedURL, version("1"), undefined, { signal: first.signal, force: true }),
      client.lookupOutcome(feedURL, version("2"), version("201"), second)
    ];
    try {
      await ready;
      first.abort();
      expect(await tasks[0]).toEqual({ type: "transientFailure" });
      expect(networkSignal.aborted).toBe(false);
      releaseResponse(new Response(feed()));
      expect(await tasks[1]).toMatchObject({
        type: "completed",
        providerFound: true,
        value: undefined
      });
      expect(await client.lookupOutcome(feedURL, version("1"), undefined, second)).toMatchObject({
        value: { remoteVersion: version("2.0") }
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      first.abort();
      releaseResponse(new Response(feed()));
      await Promise.allSettled(tasks);
    }
  });

  it("aborts a fetch after its last consumer cancels and never reuses its late response", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let releaseResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    });
    let networkSignal!: AbortSignal;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      networkSignal = init!.signal!;
      started();
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SparkleAppcastClient();
    const controller = new AbortController();
    const refresh = { signal: controller.signal, force: true };
    const tasks = [
      client.lookupOutcome(feedURL, version("1"), undefined, refresh),
      client.lookupOutcome(feedURL, version("2"), version("200"), refresh)
    ];
    try {
      await ready;
      controller.abort();
      expect(await Promise.all(tasks)).toEqual([
        { type: "transientFailure" },
        { type: "transientFailure" }
      ]);
      expect(networkSignal.aborted).toBe(true);
      // Model a transport that resolves after cancellation; it must not populate
      // the raw metadata cache or the next refresh's retained feed metadata.
      releaseResponse(new Response(feed()));
      await vi.advanceTimersByTimeAsync(1000);
      fetchMock.mockImplementation(async () => new Response(feed(release("3.0", "300"))));
      expect(await client.lookupOutcome(feedURL, version("1"), undefined, options())).toMatchObject(
        { value: { remoteVersion: version("3.0") } }
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      releaseResponse(new Response(feed()));
      await Promise.allSettled(tasks);
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it.each(["entries", "bytes"])(
    "bounds retained metadata by %s and revalidates evicted feeds",
    async (bound) => {
      const body = bound === "bytes" ? feed() + " ".repeat(1024 * 1024) : feed();
      const fetchMock = vi.fn(async () => new Response(body));
      vi.stubGlobal("fetch", fetchMock);
      const client = new SparkleAppcastClient();
      const refresh = options();
      const count = bound === "entries" ? 513 : 8;
      for (let i = 0; i < count; i++) {
        expect(
          await paced(client.lookupOutcome(`${feedURL}/${i}`, version("1"), undefined, refresh))
        ).toMatchObject({ value: { remoteVersion: version("2.0") } });
      }
      await paced(client.lookupOutcome(`${feedURL}/0`, version("1"), undefined, refresh));
      expect(fetchMock).toHaveBeenCalledTimes(count + 1);
    }
  );
});
