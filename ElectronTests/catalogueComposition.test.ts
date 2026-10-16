// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { catalogueCacheDirectory } from "../src/main/catalogueCacheDirectory";
import { SnapshotPersistence } from "../src/main/persistence";
import { UpdateStore } from "../src/main/updateStore";
import { defaultPersistedSnapshot } from "../src/shared/domain";

function store(root: string): UpdateStore {
  return new UpdateStore({
    persistence: { save: async () => undefined } as unknown as SnapshotPersistence,
    persisted: { ...defaultPersistedSnapshot(), autoRefreshEnabled: false },
    catalogueCacheRoot: root,
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    runBrewCommand: async () => ({ success: false, status: null, output: "" }),
    runMasCommand: async () => ({ success: false, status: null, output: "" }),
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    },
    clients: {
      scanner: { scanApplications: async () => [] },
      appStore: { lookupOutcome: async () => ({ type: "completed" }) },
      sparkle: { lookupOutcome: async () => ({ type: "completed" }) },
      homebrewInventory: {
        fetchInventory: async () => ({
          items: [],
          inventoryReadSucceededByKind: { formula: true, cask: true },
          outdatedDetectionSucceeded: true,
          outdatedDetectionSucceededByKind: { formula: true, cask: true }
        })
      }
    }
  });
}

describe("production catalogue composition", () => {
  it("isolates explicit user data and places normal caches outside durable snapshots", () => {
    expect(catalogueCacheDirectory("/home/test", "/tmp/isolated", true)).toBe(
      path.join("/tmp/isolated", "cache", "catalogues")
    );
    expect(catalogueCacheDirectory("/home/test", "/data", false)).toBe(
      path.join("/home/test", "Library", "Caches", "com.arshiaghaf.baseline", "catalogues")
    );
  });

  it("injects both durable adapters, restores a new store offline, and ranks exact formulae before cask prefixes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-catalogue-composition-"));
    const casks = Array.from({ length: 12 }, (_, i) => ({
      token: `node-app-${i}`,
      name: [`Node App ${i}`],
      version: "1",
      artifacts: [{ app: [`Node${i}.app`] }]
    }));
    const formulae = [
      { name: "node", full_name: "node", versions: { stable: "24" }, desc: "Fixture runtime" }
    ];
    const fetch = vi.fn(
      async (url: string | URL | Request) =>
        new Response(JSON.stringify(String(url).includes("cask") ? casks : formulae), {
          headers: { "cache-control": "max-age=600", etag: '"fixture"' }
        })
    );
    vi.stubGlobal("fetch", fetch);
    const first = store(root);
    let second: UpdateStore | undefined;
    try {
      await first.refresh(true);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect((await readdir(root)).sort()).toEqual([
        "cask-catalogue-v1.cache",
        "formula-catalogue-v1.cache"
      ]);
      await first.setSearchText("node");
      expect(first.getSnapshot().homebrewDiscoverItems[0]?.kind).toBe("formula");
      expect(first.getSnapshot().homebrewDiscoverItems[0]?.token).toBe("node");
      expect(first.getCatalogueDiagnostics()).toContain(
        "Casks: 12 entries, 0 skipped, 0 schema warnings"
      );
      expect(first.getCatalogueDiagnostics()).toContain(
        "Formulae: 1 entries, 0 skipped, 0 schema warnings"
      );
      await first.prepareToQuit();
      second = store(root);
      await second.refresh(true);
      expect(fetch).toHaveBeenCalledTimes(2);
      await second.setSearchText("node");
      expect(second.getSnapshot().homebrewDiscoverItems[0]?.token).toBe("node");
    } finally {
      await first.prepareToQuit();
      await second?.prepareToQuit();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });
});
