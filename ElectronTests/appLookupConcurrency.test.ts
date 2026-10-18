// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, expect, it, vi } from "vitest";
import { AppStoreLookupClient } from "../src/main/appStoreLookupClient";
import { SparkleAppcastClient } from "../src/main/sparkleAppcastClient";
import { lookupAppUpdates } from "../src/main/appUpdateLookupService";
import { emptyHomebrewCaskIndex, type AppRecord } from "../src/shared/domain";
import { version } from "../src/shared/version";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const feed =
  '<rss><channel><item><enclosure url="https://example.com/update.zip" sparkle:shortVersionString="2.0" sparkle:version="2" /></item></channel></rss>';
const records: AppRecord[] = Array.from({ length: 8 }, (_, i) => ({
  id: `app-${i}`,
  bundlePath: `/fixture/${i}.app`,
  displayName: `Example ${i}`,
  localVersion: version(i % 2 ? "3" : "1"),
  sourceHint: "unknown",
  sparkleFeedURL: "https://example.com/shared.xml"
}));
const input = (apps = records, signal = new AbortController().signal) => ({
  apps,
  previousUpdates: new Map(),
  homebrewItems: [],
  homebrewIndex: emptyHomebrewCaskIndex,
  now: "2026-10-18T00:00:00Z",
  force: true,
  signal,
  isCurrent: () => true,
  isSelfApp: () => false,
  canUseHomebrewAppUpdate: () => false
});

it("shares overlapping feeds but compares each installed version independently", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 100));
    return new Response(feed);
  });
  vi.stubGlobal("fetch", fetch);
  const task = lookupAppUpdates(
    {
      appStore: new AppStoreLookupClient(),
      sparkle: new SparkleAppcastClient(),
      homebrew: { lookupUpdate: () => undefined }
    },
    input()
  );
  await vi.runAllTimersAsync();
  expect((await task)?.map((u) => u.appID)).toEqual(["app-0", "app-2", "app-4", "app-6"]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("honors late App Store 429 backoff with work queued and in flight", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      starts.push(Date.now());
      const first = starts.length === 1;
      await new Promise((r) => setTimeout(r, first ? 4000 : 100));
      return first
        ? new Response("", { status: 429, headers: { "retry-after": "60" } })
        : new Response('{"results":[]}');
    })
  );
  const apps = records.map((app, i) => ({
    ...app,
    bundleIdentifier: `com.example.${i}`,
    sparkleFeedURL: undefined
  }));
  const task = lookupAppUpdates(
    {
      appStore: new AppStoreLookupClient(),
      sparkle: new SparkleAppcastClient(),
      homebrew: { lookupUpdate: () => undefined }
    },
    input(apps)
  );
  await vi.runAllTimersAsync();
  expect(await task).toEqual([]);
  expect(starts).toHaveLength(2);
  expect(starts[1]! - starts[0]!).toBe(3100);
});

it("cancels queued real-client work and prevents stale cache insertion", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const client = new AppStoreLookupClient();
  const fetch = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 6000));
    return new Response('{"results":[]}');
  });
  vi.stubGlobal("fetch", fetch);
  const apps = records.map((app, i) => ({
    ...app,
    bundleIdentifier: `com.example.${i}`,
    sparkleFeedURL: undefined
  }));
  const clients = {
    appStore: client,
    sparkle: new SparkleAppcastClient(),
    homebrew: { lookupUpdate: () => undefined }
  };
  const task = lookupAppUpdates(clients, input(apps, controller.signal));
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  expect(await task).toBeUndefined();
  await vi.runAllTimersAsync();
  expect(fetch).toHaveBeenCalledTimes(1);
  const replacement = lookupAppUpdates(clients, { ...input([apps[0]!]), force: false });
  await vi.runAllTimersAsync();
  expect(await replacement).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
