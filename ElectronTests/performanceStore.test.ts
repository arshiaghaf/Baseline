// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm, readFile } from "node:fs/promises";
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
import { renderDiagnostics } from "../src/shared/diagnostics";
import type { CommandResult } from "../src/main/commandRunner";

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
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let firstSignal: AbortSignal | undefined;
    let calls = 0;
    const signals: AbortSignal[] = [];
    const lookupOutcome = vi.fn(async (_id, _version, options) => {
      calls++;
      const signal = options!.signal!;
      firstSignal ??= signal;
      signals.push(signal);
      if (signal === firstSignal) await gate;
      return { type: "completed" as const };
    });
    const { store } = await fixture({
      clients: { scanner: { scanApplications: async () => records }, appStore: { lookupOutcome } }
    });
    const old = store.refresh(false);
    let current: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(calls).toBe(4));
      current = store.refresh(false);
      finish();
      await Promise.all([old, current]);
      expect(calls).toBe(34);
      expect(signals.filter((signal) => signal === firstSignal)).toHaveLength(4);
      expect(signals[0]!.aborted).toBe(true);
      expect(store.getSnapshot().isRefreshing).toBe(false);
    } finally {
      finish();
      await Promise.allSettled([old, ...(current ? [current] : [])]);
    }
  });

  it("uses fresh-source policies for manual checks and cached metadata after a local operation", async () => {
    const fetchIndex = vi.fn(async () => emptyHomebrewCaskIndex);
    const lookupOutcome = vi.fn(async () => ({
      type: "completed" as const,
      identity: { productID: 123, platform: "mac" as const, storefront: "us" }
    }));
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
    await store.refresh(true);
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
    const item = {
      id: "formula:example",
      token: "example",
      name: "Example",
      kind: "formula" as const,
      formulaIdentity: { name: "example", fullName: "example", tap: "homebrew/core", oldNames: [] },
      installedVersion: version("1"),
      latestVersion: version("2"),
      isOutdated: true
    };
    let output!: (line: string) => void;
    let started!: () => void;
    let finish!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const commandFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { store } = await fixture({
      persisted: { ...defaultPersistedSnapshot(), homebrewItems: [item] },
      runBrewCommand: async (_args, onOutputLine) => {
        output = onOutputLine!;
        started();
        await commandFinished;
        return { success: false, status: 1, output: "Synthetic command failure" };
      }
    });
    await store.refresh(true);
    const full = vi.fn();
    const progress = vi.fn();
    store.on("snapshot", full);
    store.on("progress", progress);
    const update = store.performHomebrewUpdate(item.id);
    await commandStarted;
    try {
      full.mockClear();
      progress.mockClear();
      output("Downloading example");
      output("Installing example");
      expect(full).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(progress).toHaveBeenCalledTimes(1);
      expect(
        progress.mock.calls[0]![0].patch.homebrewBatchProgressByItemID[item.id]
      ).toBeGreaterThan(0);
      expect(progress.mock.calls[0]![0].patch.homebrewBatchProgressByItemID[item.id]).toBeLessThan(
        1
      );
      output("🍺 example was successfully installed");
      expect(progress).toHaveBeenCalledTimes(2);
      expect(progress.mock.calls[1]![0].patch.homebrewBatchProgressByItemID[item.id]).toBe(1);
      output("Error: failed to finalize example");
      expect(full).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot().homebrewBatchFailedItemIDs).toContain(item.id);
      await vi.advanceTimersByTimeAsync(100);
      expect(progress).toHaveBeenCalledTimes(2);
    } finally {
      finish();
      await update;
    }
  });
});

describe("cached lookup responses still compare current local versions", () => {
  it("shares App Store metadata, recomputes after a local update, and preserves the actual source check time", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          resultCount: 1,
          results: [{ kind: "mac-software", bundleId: "com.example.app", version: "2", trackId: 1 }]
        })
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

describe("ephemeral operation failure projection", () => {
  async function quitStores(stores: UpdateStore[]) {
    const outcomes = await Promise.allSettled(stores.map((store) => store.prepareToQuit()));
    for (const outcome of outcomes) expect(outcome).toEqual({ status: "fulfilled", value: true });
  }
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
  const persisted = { ...defaultPersistedSnapshot(), homebrewItems: [item] };
  const failed = {
    success: false,
    status: 1,
    output: "raw fixture only",
    outputTail: "SAFE_EPHEMERAL_FIXTURE"
  };
  const id = `update:${item.id}`;

  it("retains tails during reconciliation, excludes disk/export/relaunch, and changes every retry identity", async () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-10-16T12:00:00.000Z");
    const { store, persistence } = await fixture({ persisted, runBrewCommand: async () => failed });
    let restored: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      await store.refresh(true);
      await store.performHomebrewUpdate(item.id);
      const first = store.getSnapshot().operationFailureDetails![id]!;
      const firstOccurredAt = store.getSnapshot().operationFailures![0]!.occurredAt;
      expect(first.outputTail).toBe(failed.outputTail);
      expect(store.operationFailureText(id, first.attemptID)).toContain(failed.outputTail);
      await store.refresh(false);
      expect(store.getSnapshot().operationFailureDetails![id]).toEqual(first);
      expect(renderDiagnostics(store.getSnapshot())).not.toContain(failed.outputTail);
      const saved = await persistence.load();
      expect(saved).not.toHaveProperty("operationFailureDetails");
      expect(JSON.stringify(saved)).not.toContain(failed.outputTail);
      const snapshotPath = path.join(directories.at(-1)!, "baseline-snapshot.json");
      for (const suffix of ["", ".backup"])
        expect(await readFile(snapshotPath + suffix, "utf8")).not.toContain(failed.outputTail);
      restored = await fixture({
        persisted: { ...saved, operationFailureDetails: { [id]: first } } as PersistedSnapshot
      });
      expect(restored.store.getSnapshot().operationFailureDetails).toEqual({});
      expect(
        restored.store.operationFailureText(id, saved.operationFailures![0]!.occurredAt)
      ).toContain("No command output");
      await store.performHomebrewUpdate(item.id);
      expect(store.getSnapshot().operationFailures![0]!.occurredAt).toBe(firstOccurredAt);
      expect(store.getSnapshot().operationFailureDetails![id]!.attemptID).not.toBe(first.attemptID);
      expect(store.operationFailureText(id, first.attemptID)).toBeUndefined();
      await store.uninstallHomebrewItem("missing");
      expect(store.getSnapshot().operationFailureDetails).toEqual({});
    } finally {
      await quitStores([store, ...(restored ? [restored.store] : [])]);
    }
  });

  it.each(["invalid", "same-item", "cleanup"])(
    "prevents an older in-flight result restoring a tail after %s user attempt",
    async (attempt) => {
      let finish!: () => void;
      let launched = false;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const { store } = await fixture({
        persisted,
        runBrewCommand: async () => {
          launched = true;
          await gate;
          return failed;
        }
      });
      let running: Promise<void> | undefined;
      try {
        await store.refresh(true);
        running = store.performHomebrewUpdate(item.id);
        await vi.waitFor(() => expect(launched).toBe(true));
        if (attempt === "same-item") await store.performHomebrewUpdate(item.id);
        else if (attempt === "cleanup") await store.cleanUpHomebrew(async () => false);
        else
          await store.installHomebrewItem({
            id: "bad",
            token: "bad;token",
            displayName: "Bad",
            kind: "formula"
          } as Parameters<UpdateStore["installHomebrewItem"]>[0]);
        expect(store.getSnapshot().operationFailureDetails).toEqual({});
        finish();
        await running;
        expect(store.getSnapshot().operationFailureDetails![id]!.outputTail).toBeUndefined();
      } finally {
        finish();
        await Promise.allSettled(running ? [running] : []);
        await quitStores([store]);
      }
    }
  );

  it("gives only the latest queued user attempt its new tail", async () => {
    const second = {
      ...item,
      id: "formula:second",
      token: "second",
      name: "Second",
      formulaIdentity: { ...item.formulaIdentity, name: "second", fullName: "second" }
    };
    let finish!: () => void;
    let launched = false;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runBrewCommand = vi.fn(async (): Promise<CommandResult> => {
      if (runBrewCommand.mock.calls.length === 1) {
        launched = true;
        await gate;
      }
      return failed;
    });
    const { store } = await fixture({
      persisted: { ...persisted, homebrewItems: [item, second] },
      runBrewCommand
    });
    let running: Promise<void> | undefined;
    let queued: Promise<void> | undefined;
    try {
      await store.refresh(true);
      running = store.performHomebrewUpdate(item.id);
      await vi.waitFor(() => expect(launched).toBe(true));
      queued = store.performHomebrewUpdate(second.id);
      finish();
      await Promise.all([running, queued]);
      expect(store.getSnapshot().operationFailureDetails![id]!.outputTail).toBeUndefined();
      expect(store.getSnapshot().operationFailureDetails![`update:${second.id}`]!.outputTail).toBe(
        failed.outputTail
      );
    } finally {
      finish();
      await Promise.allSettled([...(running ? [running] : []), ...(queued ? [queued] : [])]);
      await quitStores([store]);
    }
  });
});
