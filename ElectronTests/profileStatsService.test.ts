// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { defaultProfileStats } from "../src/shared/domain";
import type { ProfileStats, ProfileStatsEvent } from "../src/shared/domain";
import { ProfileStatsService } from "../src/main/profileStatsService";
import type { ProfileStatsIntegrity } from "../src/main/profileStatsIntegrityService";

const event = (id: string): ProfileStatsEvent => ({
  id,
  type: "homebrewUpdate",
  targetID: `formula:${id}`,
  displayName: id,
  channel: "homebrew",
  occurredAt: "2026-06-01T12:00:00.000Z"
});

function harness(integrity: ProfileStatsIntegrity, initial = defaultProfileStats()) {
  let stats = initial;
  const persisted: ProfileStats[] = [];
  const service = new ProfileStatsService({
    integrity,
    getStats: () => stats,
    publishStats: (next) => {
      stats = next;
    },
    persist: async () => {
      persisted.push(structuredClone(stats));
    }
  });
  return { service, current: () => stats, persisted };
}

describe("ProfileStatsService", () => {
  it("serializes overlapping recording and verification through persistence", async () => {
    let releaseFirstSeal: (() => void) | undefined;
    let firstSealStarted: (() => void) | undefined;
    const sealStarted = new Promise<void>((resolve) => {
      firstSealStarted = resolve;
    });
    let sealCount = 0;
    const integrity: ProfileStatsIntegrity = {
      verifyOrInitialize: vi.fn(async (stats) => ({ ...stats, integrityStatus: "verified" })),
      seal: vi.fn(async (stats) => {
        sealCount += 1;
        if (sealCount === 1) {
          firstSealStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstSeal = resolve;
          });
        }
        return { ...stats, signature: `seal-${sealCount}` };
      })
    };
    const { service, current, persisted } = harness(integrity);

    const first = service.recordEvents([event("first")]);
    let verification: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      await sealStarted;
      verification = service.verifyIntegrity();
      second = service.recordEvents([event("second")]);
      await Promise.resolve();
      expect(integrity.verifyOrInitialize).not.toHaveBeenCalled();

      releaseFirstSeal?.();
      await Promise.all([first, verification, second]);
      expect(current().events.map(({ id }) => id)).toEqual(["second", "first"]);
      expect(persisted.map((stats) => stats.events.map(({ id }) => id))).toEqual([
        ["first"],
        ["first"],
        ["second", "first"]
      ]);
    } finally {
      releaseFirstSeal?.();
      await Promise.allSettled([first, verification, second].filter((task) => task !== undefined));
    }
  });

  it("recovers its queue after a failed persistence write", async () => {
    let stats = defaultProfileStats();
    let writes = 0;
    const integrity: ProfileStatsIntegrity = {
      verifyOrInitialize: async (value) => value,
      seal: async (value) => ({ ...value, signature: "sealed" })
    };
    const service = new ProfileStatsService({
      integrity,
      getStats: () => stats,
      publishStats: (next) => {
        stats = next;
      },
      persist: async () => {
        writes += 1;
        if (writes === 1) throw new Error("write failed");
      }
    });

    await expect(service.recordEvents([event("first")])).rejects.toThrow("write failed");
    await service.recordEvents([event("second")]);
    await service.drain();
    expect(stats.events.map(({ id }) => id)).toEqual(["second", "first"]);
    expect(writes).toBe(2);
  });

  it("does not add unsigned events when integrity sealing is unavailable", async () => {
    const initial = { ...defaultProfileStats(), signature: "existing" };
    const integrity: ProfileStatsIntegrity = {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => ({ ...stats, integrityStatus: "unavailable" })
    };
    const { service, current, persisted } = harness(integrity, initial);

    await service.recordEvents([event("one")]);
    expect(current().events).toEqual([]);
    expect(current().integrityStatus).toBe("unavailable");
    expect(persisted).toEqual([current()]);
  });

  it("deduplicates an event already recorded while retaining the persistence boundary", async () => {
    const initial = { ...defaultProfileStats(), signature: "existing", events: [event("one")] };
    const integrity: ProfileStatsIntegrity = {
      verifyOrInitialize: async (stats) => stats,
      seal: vi.fn(async (stats) => stats)
    };
    const { service, current, persisted } = harness(integrity, initial);

    await service.recordEvents([event("one")]);
    expect(integrity.seal).not.toHaveBeenCalled();
    expect(current()).toEqual(initial);
    expect(persisted).toEqual([initial]);
  });
});
