// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import { AppStoreLookupClient } from "../src/main/appStoreLookupClient";
import { SparkleAppcastClient } from "../src/main/sparkleAppcastClient";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type AppRecord,
  type PersistedSnapshot
} from "../src/shared/domain";
import { version } from "../src/shared/version";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});
const app = (index: number): AppRecord => ({
  id: `app:${index}`,
  bundlePath: `/fixture/Example${index}.app`,
  displayName: `Example ${index}`,
  bundleIdentifier: `com.example.fixture${index}`,
  localVersion: version("1"),
  sourceHint: "unknown"
});

async function fixture(options: Partial<ConstructorParameters<typeof UpdateStore>[0]> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-performance-store-"));
  directories.push(directory);
  const persistence = new SnapshotPersistence(directory);
  const clients: ConstructorParameters<typeof UpdateStore>[0]["clients"] = {
    scanner: { scanApplications: async () => [] },
    appStore: { lookupOutcome: async () => ({ type: "completed" }) },
    sparkle: { lookupOutcome: async () => ({ type: "completed" }) },
    homebrew: {
      fetchIndex: async () => emptyHomebrewCaskIndex,
      lookupUpdate: () => undefined,
      searchCasks: () => []
    },
    homebrewFormula: {
      fetchIndex: async () => emptyHomebrewFormulaIndex,
      searchFormulae: () => []
    },
    homebrewInventory: {
      fetchInventory: async () => ({
        items: options.persisted?.homebrewItems ?? [],
        outdatedDetectionSucceeded: true,
        outdatedDetectionSucceededByKind: { formula: true, cask: true },
        inventoryReadSucceededByKind: { formula: true, cask: true }
      })
    },
    selfUpdate: {
      lookup: async (currentVersion, checkedAt) => ({ available: false, currentVersion, checkedAt })
    },
    ...options.clients
  };
  const store = new UpdateStore({
    persistence,
    persisted: defaultPersistedSnapshot(),
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    },
    successRefreshDelayMS: 0,
    ...options,
    clients
  });
  return { store, persistence };
}

describe("performance store integration", () => {
  it("stops scheduling obsolete apps even when an injected source ignores cancellation", async () => {
    const records = Array.from({ length: 30 }, (_, i) => app(i));
    let finish!: () => void;
    let calls = 0;
    const signals: AbortSignal[] = [];
    const lookupOutcome = vi.fn(async (_id, _version, options) => {
      calls++;
      signals.push(options!.signal!);
      if (calls === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return { type: "completed" as const };
    });
    const { store } = await fixture({
      clients: { scanner: { scanApplications: async () => records }, appStore: { lookupOutcome } }
    });
    const old = store.refresh(false);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const current = store.refresh(false);
    finish();
    await Promise.all([old, current]);
    expect(calls).toBe(31);
    expect(signals[0]!.aborted).toBe(true);
    expect(store.getSnapshot().isRefreshing).toBe(false);
  });

  it("uses fresh-source policies for manual checks and cached metadata after a local operation", async () => {
    const fetchIndex = vi.fn(async () => emptyHomebrewCaskIndex);
    const lookupOutcome = vi.fn(async () => ({ type: "completed" as const }));
    const { store } = await fixture({
      clients: {
        scanner: { scanApplications: async () => [app(1)] },
        homebrew: { fetchIndex, lookupUpdate: () => undefined, searchCasks: () => [] },
        appStore: { lookupOutcome }
      }
    });
    await store.refresh(true);
    expect(fetchIndex).toHaveBeenLastCalledWith({ force: false });
    await store.refresh(false);
    expect(fetchIndex).toHaveBeenLastCalledWith({ force: true });
    await store.refresh(false, { allowHomebrewInventoryDuringActiveCommand: true });
    expect(fetchIndex).toHaveBeenLastCalledWith({ force: false });
    expect(lookupOutcome).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ force: false, signal: expect.any(AbortSignal) })
    );
  });

  it("retains safe failure details after refresh and relaunch; retry and dismissal clear them", async () => {
    vi.useFakeTimers();
    const item = {
      id: "formula:example",
      token: "example",
      name: "Example",
      kind: "formula" as const,
      formulaIdentity: { name: "example", fullName: "example", tap: "homebrew/core", oldNames: [] },
      installedVersion: version("1"),
      isOutdated: true,
      latestVersion: version("2")
    };
    const persisted: PersistedSnapshot = { ...defaultPersistedSnapshot(), homebrewItems: [item] };
    const runBrewCommand = vi.fn(async () => ({
      success: false,
      status: 1,
      output: "Permission denied /Users/fixture/private SECRET=fixture"
    }));
    const { store, persistence } = await fixture({ persisted, runBrewCommand });
    await store.performHomebrewUpdate(item.id);
    expect(store.getSnapshot().operationFailures).toMatchObject([
      { entityID: item.id, reason: "permission", status: 1 }
    ]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(store.getSnapshot().homebrewBatchFailedItemIDs).toEqual([]);
    expect(store.getSnapshot().operationFailures).toHaveLength(1);
    await store.refresh(true);
    const saved = await persistence.load();
    expect(JSON.stringify(saved.operationFailures)).not.toMatch(/private|SECRET|\/Users/);
    const restored = await fixture({ persisted: saved });
    expect(restored.store.getSnapshot().operationFailures).toHaveLength(1);
    await restored.store.dismissOperationFailure(saved.operationFailures![0]!.id);
    expect((await restored.persistence.load()).operationFailures).toEqual([]);
    await store.performHomebrewUpdate(item.id);
    expect(store.getSnapshot().operationFailures).toHaveLength(1);
    runBrewCommand.mockResolvedValue({ success: true, status: 0, output: "" });
    await store.performHomebrewUpdate(item.id);
    expect(store.getSnapshot().operationFailures).toEqual([]);
  });

  it("progress avoids full inventory snapshots and preserves terminal delivery", async () => {
    vi.useFakeTimers();
    const { store } = await fixture();
    const full = vi.fn();
    const progress = vi.fn();
    store.on("snapshot", full);
    store.on("progress", progress);
    const patch = (store as unknown as { patch: (value: object) => void }).patch.bind(store);
    patch({ homebrewBatchProgressByItemID: { "formula:example": 0.2 } });
    patch({ homebrewBatchProgressByItemID: { "formula:example": 0.3 } });
    expect(full).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(progress).toHaveBeenCalledTimes(1);
    patch({ homebrewBatchProgressByItemID: { "formula:example": 1 } });
    expect(progress).toHaveBeenCalledTimes(2);
    patch({ homebrewBatchFailedItemIDs: ["formula:example"] });
    expect(full).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(progress).toHaveBeenCalledTimes(2);
  });
});

describe("cached lookup responses still compare current local versions", () => {
  it("shares App Store metadata, recomputes after a local update, and preserves the actual source check time", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ results: [{ kind: "mac-software", version: "2", trackId: 1 }] })
        )
      );
    const client = new AppStoreLookupClient();
    const [old, current] = await Promise.all([
      client.lookupOutcome("com.example.app", version("1")),
      client.lookupOutcome("com.example.app", version("2"))
    ]);
    expect(old).toMatchObject({ type: "completed", value: { remoteVersion: version("2") } });
    expect(current).toMatchObject({ type: "completed", value: undefined });
    expect(await client.lookupOutcome("com.example.app", version("3"))).toMatchObject({
      type: "completed",
      value: undefined
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(old.type === "completed" && old.checkedAt).toBe(
      current.type === "completed" && current.checkedAt
    );
  });

  it("reuses Sparkle metadata but compares a changed local build", async () => {
    const feed =
      '<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><enclosure sparkle:shortVersionString="2" sparkle:version="200" url="https://example.com/app.zip"/></item></channel></rss>';
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(feed));
    const client = new SparkleAppcastClient();
    expect(
      await client.lookupOutcome("https://example.com/feed", version("2"), version("100"))
    ).toMatchObject({ type: "completed", value: { remoteBuildVersion: version("200") } });
    expect(
      await client.lookupOutcome("https://example.com/feed", version("2"), version("200"))
    ).toMatchObject({ type: "completed", value: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("backs off an Apple 429 response without waiting indefinitely or issuing more requests", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    const client = new AppStoreLookupClient();
    expect(await client.lookupOutcome("com.example.one", version("1"))).toEqual({
      type: "transientFailure"
    });
    expect(await client.lookupOutcome("com.example.two", version("1"))).toEqual({
      type: "transientFailure"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await client.lookupOutcome("com.example.two", version("1"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
