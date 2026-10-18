// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import type { AppRecord, UpdateRecord } from "../src/shared/domain";
import { emptyHomebrewCaskIndex } from "../src/shared/domain";
import { version } from "../src/shared/version";
import { lookupAppUpdates } from "../src/main/appUpdateLookupService";

const app: AppRecord = {
  id: "example",
  bundlePath: "/Applications/Example.app",
  displayName: "Example",
  bundleIdentifier: "com.example.app",
  localVersion: version("1.0"),
  sparkleFeedURL: "https://example.com/appcast.xml",
  sourceHint: "unknown"
};

function input(previousUpdates: UpdateRecord[] = []) {
  return {
    apps: [app],
    previousUpdates: new Map(previousUpdates.map((update) => [update.appID, update])),
    homebrewItems: [],
    homebrewIndex: emptyHomebrewCaskIndex,
    now: "2026-10-16T00:00:00.000Z",
    force: true,
    signal: new AbortController().signal,
    isCurrent: () => true,
    isSelfApp: () => false,
    canUseHomebrewAppUpdate: () => false
  };
}

describe("lookupAppUpdates", () => {
  it("keeps App Store precedence when all sources could offer an update", async () => {
    const sparkle = vi.fn();
    const homebrew = vi.fn();
    const updates = await lookupAppUpdates(
      {
        appStore: {
          lookupOutcome: vi.fn().mockResolvedValue({
            type: "completed",
            value: { remoteVersion: version("2.0") }
          })
        },
        sparkle: { lookupOutcome: sparkle },
        homebrew: { lookupUpdate: homebrew }
      },
      input()
    );
    expect(updates).toMatchObject([{ appID: "example", source: "appStore" }]);
    expect(sparkle).not.toHaveBeenCalled();
    expect(homebrew).not.toHaveBeenCalled();
  });

  it("retains a still-valid App Store update on transient failure", async () => {
    const previous: UpdateRecord = {
      id: app.id,
      appID: app.id,
      source: "appStore",
      supportLevel: "supported",
      localVersion: app.localVersion,
      remoteVersion: version("2.0"),
      checkedAt: "2026-10-15T00:00:00.000Z"
    };
    const sparkle = vi.fn();
    const updates = await lookupAppUpdates(
      {
        appStore: { lookupOutcome: vi.fn().mockResolvedValue({ type: "transientFailure" }) },
        sparkle: { lookupOutcome: sparkle },
        homebrew: { lookupUpdate: vi.fn() }
      },
      input([previous])
    );
    expect(updates).toEqual([previous]);
    expect(sparkle).not.toHaveBeenCalled();
  });

  it("discards partial results when the generation is superseded during lookup", async () => {
    let current = true;
    const updates = await lookupAppUpdates(
      {
        appStore: {
          lookupOutcome: vi.fn().mockImplementation(async () => {
            current = false;
            return { type: "completed", value: { remoteVersion: version("2.0") } };
          })
        },
        sparkle: { lookupOutcome: vi.fn() },
        homebrew: { lookupUpdate: vi.fn() }
      },
      { ...input(), isCurrent: () => current }
    );
    expect(updates).toBeUndefined();
  });
});

function apps(count: number): AppRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    ...app,
    id: `app-${index}`,
    bundleIdentifier: `com.example.app-${index}`
  }));
}

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("parallel app lookups", () => {
  it("bounds active app checks, preserves scan order and waits for every app", async () => {
    const records = apps(7);
    const gates = records.map(() =>
      gate<{ type: "completed"; value: { remoteVersion: ReturnType<typeof version> } }>()
    );
    const lookup = vi.fn(
      (id: string) => gates[records.findIndex((record) => record.bundleIdentifier === id)]!.promise
    );
    const task = lookupAppUpdates(
      {
        appStore: { lookupOutcome: lookup },
        sparkle: { lookupOutcome: vi.fn() },
        homebrew: { lookupUpdate: vi.fn() }
      },
      { ...input(), apps: records }
    );
    try {
      expect(lookup).toHaveBeenCalledTimes(4);
      gates[3]!.resolve({ type: "completed", value: { remoteVersion: version("2") } });
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(5));
      gates[4]!.resolve({ type: "completed", value: { remoteVersion: version("2") } });
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(6));
      for (const pending of gates)
        pending.resolve({ type: "completed", value: { remoteVersion: version("2") } });
      const result = await task;
      expect(result?.map((update) => update.appID)).toEqual(records.map((record) => record.id));
      expect(lookup).toHaveBeenCalledTimes(7);
    } finally {
      for (const pending of gates)
        pending.resolve({ type: "completed", value: { remoteVersion: version("2") } });
      await task;
    }
  });

  it.each(["abort", "supersede"])(
    "stops queued and lower-precedence checks after %s and drains in-flight work",
    async (mode) => {
      const records = apps(8);
      const controller = new AbortController();
      let current = true;
      const pending = gate<{ type: "completed" }>();
      const lookup = vi.fn(() => pending.promise);
      const sparkle = vi.fn();
      const homebrew = vi.fn();
      const task = lookupAppUpdates(
        {
          appStore: { lookupOutcome: lookup },
          sparkle: { lookupOutcome: sparkle },
          homebrew: { lookupUpdate: homebrew }
        },
        { ...input(), apps: records, signal: controller.signal, isCurrent: () => current }
      );
      try {
        expect(lookup).toHaveBeenCalledTimes(4);
        if (mode === "abort") controller.abort();
        else current = false;
        pending.resolve({ type: "completed" });
        expect(await task).toBeUndefined();
        expect(lookup).toHaveBeenCalledTimes(4);
        expect(sparkle).not.toHaveBeenCalled();
        expect(homebrew).not.toHaveBeenCalled();
      } finally {
        pending.resolve({ type: "completed" });
        await task;
      }
    }
  );

  it("drains started checks after an unexpected failure without dispatching queued apps", async () => {
    const records = apps(8);
    const gates = records.map(() => gate<{ type: "completed" }>());
    const lookup = vi.fn(
      (id: string) => gates[records.findIndex((record) => record.bundleIdentifier === id)]!.promise
    );
    const sparkle = vi.fn().mockResolvedValue({ type: "completed" });
    let settled = false;
    const task = lookupAppUpdates(
      {
        appStore: { lookupOutcome: lookup },
        sparkle: { lookupOutcome: sparkle },
        homebrew: { lookupUpdate: vi.fn() }
      },
      { ...input(), apps: records }
    );
    const failure = expect(task).rejects.toThrow("provider failed");
    void task.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      gates[0]!.reject(new Error("provider failed"));
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(4));
      await Promise.resolve();
      expect(settled).toBe(false);
      for (const pending of gates.slice(1)) pending.resolve({ type: "completed" });
      await failure;
      expect(lookup).toHaveBeenCalledTimes(4);
      expect(sparkle).not.toHaveBeenCalled();
    } finally {
      for (const pending of gates) pending.resolve({ type: "completed" });
      await failure;
    }
  });
});
