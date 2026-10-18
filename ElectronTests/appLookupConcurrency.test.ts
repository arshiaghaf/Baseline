// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, expect, it, vi } from "vitest";
import { AppStoreLookupClient } from "../src/main/appStoreLookupClient";
import { SparkleAppcastClient } from "../src/main/sparkleAppcastClient";
import { appProviderFingerprint, lookupAppUpdates } from "../src/main/appUpdateLookupService";
import {
  emptyHomebrewCaskIndex,
  type AppProviderCheck,
  type AppRecord,
  type UpdateRecord
} from "../src/shared/domain";
import { version } from "../src/shared/version";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const now = "2026-10-18T00:00:00.000Z";
const feed =
  '<rss><channel><item><enclosure url="https://example.com/update.zip" sparkle:shortVersionString="2.0" sparkle:version="2" /></item></channel></rss>';
const records: AppRecord[] = Array.from({ length: 8 }, (_, index) => ({
  id: `app-${index}`,
  bundlePath: `/fixture/${index}.app`,
  displayName: `Example ${index}`,
  localVersion: version(index % 2 ? "3" : "1"),
  sourceHint: "unknown",
  sparkleFeedURL: "https://example.com/shared.xml"
}));
const input = (apps = records, signal = new AbortController().signal) => ({
  apps,
  previousUpdates: new Map<string, UpdateRecord>(),
  homebrewItems: [],
  homebrewIndex: emptyHomebrewCaskIndex,
  now,
  force: true,
  signal,
  isCurrent: () => true,
  isSelfApp: () => false,
  canUseHomebrewAppUpdate: () => false
});
const appleApps = records.map((app, index) => ({
  ...app,
  bundleIdentifier: `com.example.app${index}`,
  sparkleFeedURL: undefined
}));
function knownChecks(apps: AppRecord[]): Record<string, AppProviderCheck> {
  return Object.fromEntries(
    apps.map((app, index) => [
      app.id,
      {
        fingerprint: appProviderFingerprint(app),
        storefront: "us",
        appStoreIdentity: { productID: index + 1, platform: "mac", storefront: "us" },
        discoveryCheckedAt: now,
        status: "checked",
        source: "appStore",
        checkedAt: now
      } satisfies AppProviderCheck
    ])
  );
}
function clients(appStore = new AppStoreLookupClient()) {
  return {
    appStore,
    sparkle: new SparkleAppcastClient(),
    homebrew: { lookupUpdate: () => undefined }
  };
}

it("shares overlapping feeds but compares each installed version independently", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return new Response(feed);
  });
  vi.stubGlobal("fetch", fetch);
  const task = lookupAppUpdates(clients(), input());
  try {
    await vi.runAllTimersAsync();
    expect((await task)?.map((update) => update.appID)).toEqual([
      "app-0",
      "app-2",
      "app-4",
      "app-6"
    ]);
    expect(
      (await task)?.every(
        (update) => update.source === "sparkle" && update.remoteVersion.raw === "2.0"
      )
    ).toBe(true);
    // All worker waves share this refresh's feed metadata; a new manual
    // refresh gets a new signal and revalidates the feed.
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await vi.runAllTimersAsync();
    await task;
  }
});

it("honors late App Store 429 backoff with work queued and in flight", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const starts: number[] = [];
  const urls: URL[] = [];
  const fetch = vi.fn(async (input: string) => {
    starts.push(Date.now());
    urls.push(new URL(input));
    const first = starts.length === 1;
    await new Promise((resolve) => setTimeout(resolve, first ? 4000 : 100));
    return first
      ? new Response(null, { status: 429, headers: { "retry-after": "60" } })
      : new Response(JSON.stringify({ resultCount: 0, results: [] }));
  });
  vi.stubGlobal("fetch", fetch);
  let checks: Record<string, AppProviderCheck> = {};
  const task = lookupAppUpdates(clients(), {
    ...input(appleApps),
    previousChecks: knownChecks(appleApps.slice(0, 4)),
    onProgress: (next) => {
      checks = next;
    }
  });
  try {
    await vi.advanceTimersByTimeAsync(3200);
    expect(starts).toHaveLength(2);
    // The known-ID batch is still in flight while the empty discovery batch
    // has finished and its individual confirmations wait for the next slot.
    expect(checks["app-0"]?.status).toBe("pending");
    expect(checks["app-4"]?.status).toBe("pending");
    await vi.runAllTimersAsync();
    expect(await task).toEqual([]);
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBe(3100);
    expect(urls[0]!.searchParams.get("id")).toBe("1,2,3,4");
    expect(urls[1]!.searchParams.get("bundleId")).toBe(
      "com.example.app4,com.example.app5,com.example.app6,com.example.app7"
    );
    expect(Object.values(checks)).toHaveLength(8);
    expect(Object.values(checks).every((check) => check.status === "failed")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    await vi.runAllTimersAsync();
    await task;
  }
});

it("cancels real-client work and rejects stale metadata for the same replacement batch", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const controller = new AbortController();
  const urls: string[] = [];
  const fetch = vi.fn(async (input: string) => {
    urls.push(input);
    // Deliberately ignore the source abort: a late successful producer must
    // still be prevented from inserting metadata into the shared cache.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const ids = new URL(input).searchParams.get("id")!.split(",").map(Number);
    const results = ids.map((id) => ({
      bundleId: `com.example.app${id - 1}`,
      kind: "mac-software",
      trackId: id,
      version: "2.0",
      trackViewUrl: `https://apps.apple.com/app/id${id}`
    }));
    return new Response(JSON.stringify({ resultCount: results.length, results }));
  });
  vi.stubGlobal("fetch", fetch);
  const source = clients();
  const previousChecks = knownChecks(appleApps);
  const task = lookupAppUpdates(source, {
    ...input(appleApps, controller.signal),
    previousChecks
  });
  let replacement: ReturnType<typeof lookupAppUpdates> | undefined;
  try {
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await task).toBeUndefined();
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    replacement = lookupAppUpdates(source, {
      ...input(appleApps),
      previousChecks,
      force: false
    });
    await vi.runAllTimersAsync();
    expect((await replacement)?.map((update) => update.appID)).toEqual([
      "app-0",
      "app-2",
      "app-4",
      "app-6"
    ]);
    expect(
      (await replacement)?.every(
        (update) => update.source === "appStore" && update.remoteVersion.raw === "2.0"
      )
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(urls[1]).toBe(urls[0]);
    expect(new URL(urls[0]!).searchParams.get("id")).toBe("1,2,3,4,5,6,7,8");
  } finally {
    controller.abort();
    await vi.runAllTimersAsync();
    await Promise.all([task, replacement]);
  }
});

it("preserves a known provider identity when App Store version metadata has no numeric component", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            resultCount: 1,
            results: [
              {
                bundleId: appleApps[0]!.bundleIdentifier,
                kind: "mac-software",
                trackId: 1,
                version: "unknown"
              }
            ]
          })
        )
    )
  );
  const previousChecks = knownChecks([appleApps[0]!]);
  const lastVersionCheck = "2026-10-17T23:59:00.000Z";
  previousChecks["app-0"]!.checkedAt = lastVersionCheck;
  let checks: Record<string, AppProviderCheck> = {};
  const task = lookupAppUpdates(clients(), {
    ...input([appleApps[0]!]),
    previousChecks,
    onProgress: (next) => {
      checks = next;
    }
  });
  try {
    await vi.runAllTimersAsync();
    expect(await task).toEqual([]);
    expect(checks["app-0"]).toMatchObject({
      status: "failed",
      appStoreIdentity: previousChecks["app-0"]!.appStoreIdentity,
      discoveryCheckedAt: now
    });
    expect(checks["app-0"]?.checkedAt).toBe(lastVersionCheck);
  } finally {
    await vi.runAllTimersAsync();
    await task;
  }
});
