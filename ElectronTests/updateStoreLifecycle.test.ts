// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnapshotPersistence } from "../src/main/persistence";
import { UpdateStore } from "../src/main/updateStore";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type AppRecord
} from "../src/shared/domain";
import { version } from "../src/shared/version";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function app(localVersion: string): AppRecord {
  return {
    id: "/fixture/Utility.app",
    bundlePath: "/fixture/Utility.app",
    displayName: "Utility",
    localVersion: version(localVersion),
    sourceHint: "unknown"
  };
}

async function makeStore(
  clients: ConstructorParameters<typeof UpdateStore>[0]["clients"] = {},
  commands: Pick<
    ConstructorParameters<typeof UpdateStore>[0],
    "runBrewCommand" | "runMasCommand"
  > = {}
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-store-lifecycle-"));
  directories.push(directory);
  return new UpdateStore({
    persistence: new SnapshotPersistence(directory),
    persisted: defaultPersistedSnapshot(),
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    },
    runBrewCommand: async () => ({ success: true, status: 0, output: "" }),
    runMasCommand: async () => ({ success: true, status: 0, output: "" }),
    ...commands,
    clients: {
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
          items: [],
          outdatedDetectionSucceeded: true,
          outdatedDetectionSucceededByKind: { formula: true, cask: true }
        })
      },
      selfUpdate: {
        lookup: async (currentVersion, checkedAt) => ({
          available: false,
          currentVersion,
          checkedAt
        })
      },
      ...clients
    }
  });
}

describe("update store lifecycle boundaries", () => {
  it("keeps the superseded caller pending until the winning refresh commits", async () => {
    const scans = [deferred<AppRecord[]>(), deferred<AppRecord[]>()];
    const scanApplications = vi.fn(() => scans[scanApplications.mock.calls.length - 1]!.promise);
    const store = await makeStore({ scanner: { scanApplications } });
    const first = store.refresh(false);
    const second = store.refresh(false);
    let firstSettled = false;
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      }
    );

    try {
      scans[0]!.resolve([app("1")]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(firstSettled).toBe(false);
      expect(store.getSnapshot().apps).toEqual([]);

      scans[1]!.resolve([app("2")]);
      await Promise.all([first, second]);
      expect(firstSettled).toBe(true);
      expect(store.getSnapshot().apps).toEqual([app("2")]);
    } finally {
      scans[0]!.resolve([]);
      scans[1]!.resolve([]);
      await Promise.allSettled([first, second]);
    }
  });

  it("does not publish a late error from a superseded refresh", async () => {
    const oldScan = deferred<AppRecord[]>();
    const scanApplications = vi
      .fn<() => Promise<AppRecord[]>>()
      .mockImplementationOnce(() => oldScan.promise)
      .mockResolvedValueOnce([app("2")]);
    const store = await makeStore({ scanner: { scanApplications } });
    const first = store.refresh(false);
    const second = store.refresh(false);

    try {
      await second;
      const winningDate = store.getSnapshot().lastRefreshDate;
      oldScan.reject(new Error("obsolete scan failed"));
      await first;
      expect(store.getSnapshot()).toMatchObject({
        apps: [app("2")],
        lastRefreshDate: winningDate,
        isRefreshing: false
      });
      expect(store.getSnapshot().refreshErrorMessage).toBeUndefined();
    } finally {
      oldScan.resolve([]);
      await Promise.allSettled([first, second]);
    }
  });

  it("releases the Homebrew command lock when a tool-status probe rejects", async () => {
    const runBrewCommand = vi
      .fn<NonNullable<ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"]>>()
      .mockRejectedValueOnce(new Error("brew probe failed"))
      .mockResolvedValue({ success: true, status: 0, output: "" });
    const store = await makeStore({}, { runBrewCommand });

    await expect(store.refreshToolStatus()).rejects.toThrow("brew probe failed");
    expect(store.getSnapshot().isHomebrewCommandLocked).toBe(false);
    await store.refreshToolStatus();
    expect(store.getSnapshot()).toMatchObject({
      isHomebrewCommandLocked: false,
      isHomebrewInstalled: true,
      isChecking: false
    });
    expect(runBrewCommand).toHaveBeenCalledTimes(2);
  });

  it("runs interval refreshes in lightweight mode and stops scheduling after quit", async () => {
    vi.useFakeTimers();
    const scan = deferred<AppRecord[]>();
    const scanApplications = vi.fn(() => scan.promise);
    const fetchIndex = vi.fn(async () => emptyHomebrewCaskIndex);
    const store = await makeStore({
      scanner: { scanApplications },
      homebrew: { fetchIndex, lookupUpdate: () => undefined, searchCasks: () => [] }
    });

    let joining: Promise<void> | undefined;
    try {
      await store.updatePreferences({ autoRefreshEnabled: true, refreshIntervalMinutes: 5 });
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(scanApplications).toHaveBeenCalledTimes(1);
      expect(fetchIndex).toHaveBeenCalledWith({ force: false });
      joining = store.refresh(true);
      expect(scanApplications).toHaveBeenCalledTimes(1);
      scan.resolve([]);
      await joining;

      expect(await store.prepareToQuit()).toBe(true);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(scanApplications).toHaveBeenCalledTimes(1);
    } finally {
      scan.resolve([]);
      await Promise.allSettled([joining]);
      await store.prepareToQuit();
    }
  });
});
