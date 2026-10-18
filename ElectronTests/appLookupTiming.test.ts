// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, expect, it, vi } from "vitest";
import { AppStoreLookupClient } from "../src/main/appStoreLookupClient";
import { SparkleAppcastClient } from "../src/main/sparkleAppcastClient";
import { lookupAppUpdates } from "../src/main/appUpdateLookupService";
import type { AppRecord } from "../src/shared/domain";
import { emptyHomebrewCaskIndex } from "../src/shared/domain";
import { version } from "../src/shared/version";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Repeatable timing comparison: real provider clients and host scheduler, simulated
// network time. The serial arm reproduces the previous one-app-at-a-time loop.
it("overlaps slow independent feeds without increasing App Store request frequency", async () => {
  vi.useFakeTimers();
  const records: AppRecord[] = Array.from({ length: 12 }, (_, index) => ({
    id: `app-${index}`,
    bundlePath: `/Applications/Example ${index}.app`,
    displayName: `Example ${index}`,
    bundleIdentifier: `com.example.app-${index}`,
    localVersion: version("1.0"),
    sourceHint: "unknown",
    sparkleFeedURL: `https://feed-${index}.example.com/appcast.xml`
  }));
  async function measure(serial: boolean) {
    const starts: number[] = [];
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string) => {
        const endpoint = new URL(url);
        const isAppStore = endpoint.host === "itunes.apple.com";
        if (isAppStore) starts.push(Date.now());
        requests.push(endpoint.href);
        await new Promise((resolve) => setTimeout(resolve, isAppStore ? 800 : 6000));
        return new Response(
          isAppStore
            ? '{"results":[]}'
            : '<rss><channel><item><enclosure sparkle:shortVersionString="2.0" sparkle:version="2" url="https://downloads.example.com/Example.dmg" /></item></channel></rss>'
        );
      })
    );
    const clients = {
      appStore: new AppStoreLookupClient(),
      sparkle: new SparkleAppcastClient(),
      homebrew: { lookupUpdate: vi.fn() }
    };
    const input = {
      apps: records,
      previousUpdates: new Map(),
      homebrewItems: [],
      homebrewIndex: emptyHomebrewCaskIndex,
      now: "2026-10-18T00:00:00.000Z",
      force: true,
      signal: new AbortController().signal,
      isCurrent: () => true,
      isSelfApp: () => false,
      canUseHomebrewAppUpdate: () => false
    };
    const start = Date.now();
    const task = serial
      ? (async () => {
          const results = [];
          for (const record of records)
            results.push(...(await lookupAppUpdates(clients, { ...input, apps: [record] }))!);
          return results;
        })()
      : lookupAppUpdates(clients, input);
    try {
      await vi.runAllTimersAsync();
      const updates = await task;
      return { ms: Date.now() - start, starts, requests, updates };
    } finally {
      await vi.runAllTimersAsync();
      await task;
    }
  }
  const serial = await measure(true);
  const parallel = await measure(false);
  expect(serial.updates).toHaveLength(12);
  // Request completion times intentionally differ when work overlaps.
  const withoutCheckTimes = (updates: typeof serial.updates) =>
    updates?.map((update) => ({ ...update, checkedAt: undefined }));
  expect(withoutCheckTimes(parallel.updates)).toEqual(withoutCheckTimes(serial.updates));
  expect(parallel.updates).toEqual(
    records.map((record) =>
      expect.objectContaining({
        appID: record.id,
        source: "sparkle",
        remoteVersion: version("2.0")
      })
    )
  );
  expect(parallel.requests.sort()).toEqual(serial.requests.sort());
  for (let i = 1; i < parallel.starts.length; i++) {
    expect(parallel.starts[i]! - parallel.starts[i - 1]!).toBeGreaterThanOrEqual(3100);
  }
  expect(serial.ms).toBe(81600);
  expect(parallel.ms).toBe(40900);
});
