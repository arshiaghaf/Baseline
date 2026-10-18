// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SnapshotPersistence } from "../src/main/persistence";
import { ProfileStatsIntegrityService } from "../src/main/profileStatsIntegrityService";
import { ProfileStatsService } from "../src/main/profileStatsService";
import {
  defaultPersistedSnapshot,
  defaultProfileStats,
  type BaselineSnapshot,
  type ProfileStatsEvent
} from "../src/shared/domain";
import { buildProfileSummary } from "../src/renderer/helpers/profile";

const event: ProfileStatsEvent = {
  id: "first",
  type: "appUpdate",
  targetID: "app:example",
  displayName: "Example",
  channel: "sparkle",
  occurredAt: "2026-10-18T00:00:00.000Z"
};
const secret = "synthetic-history-secret";

describe("profile lifetime history", () => {
  it("migrates version 2 seals from retained events without trusting unsigned aggregates", async () => {
    const integrity = new ProfileStatsIntegrityService(async () => secret);
    const old = { ...defaultProfileStats(), signatureVersion: 2, events: [event] };
    const signature = createHmac("sha256", secret)
      .update(
        JSON.stringify({
          signatureVersion: 2,
          createdAt: old.createdAt,
          startedUsingAt: old.startedUsingAt,
          events: old.events,
          resetNotice: undefined
        })
      )
      .digest("base64url");
    const migrated = await integrity.verifyOrInitialize({
      ...old,
      signature,
      lifetime: { coverage: "complete", entries: [{ ...event, count: 9000 }] }
    });
    expect(migrated.integrityStatus).toBe("verified");
    expect(migrated.lifetime).toEqual({
      coverage: "lowerBound",
      entries: [
        {
          type: event.type,
          targetID: event.targetID,
          displayName: event.displayName,
          channel: event.channel,
          count: 1
        }
      ]
    });
    expect((await integrity.verifyOrInitialize(migrated)).signature).toBe(migrated.signature);
  });

  it("keeps aggregate counts, rankings and sources across cap eviction and disk reload", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-profile-lifetime-"));
    try {
      const persistence = new SnapshotPersistence(directory);
      const integrity = new ProfileStatsIntegrityService(async () => secret);
      let stats = defaultProfileStats();
      const service = new ProfileStatsService({
        integrity,
        getStats: () => stats,
        publishStats: (next) => {
          stats = next;
        },
        persist: () => persistence.save({ ...defaultPersistedSnapshot(), profileStats: stats })
      });
      await service.recordEvents([event, event]);
      await service.recordEvents(
        Array.from({ length: 1000 }, (_, i) => ({
          ...event,
          id: `install:${i}`,
          type: "homebrewInstall"
        }))
      );
      expect(stats.events.every((entry) => entry.type === "homebrewInstall")).toBe(true);
      const loaded = await persistence.load();
      stats = await integrity.verifyOrInitialize(loaded.profileStats);
      expect(stats.integrityStatus).toBe("verified");
      expect(stats.lifetime?.coverage).toBe("complete");
      const summary = buildProfileSummary({ ...loaded, profileStats: stats } as BaselineSnapshot);
      expect(summary).toMatchObject({
        totalUpdates: 1,
        differentApps: 1,
        discoverInstalls: 1000,
        incompleteHistory: false
      });
      expect(summary.topApps).toMatchObject([{ targetID: event.targetID, count: 1 }]);
      expect(summary.sourceMix.find((source) => source.channel === "sparkle")?.count).toBe(1);
      const changed = structuredClone(stats);
      changed.lifetime!.entries[0]!.count += 1;
      expect((await integrity.verifyOrInitialize(changed)).integrityStatus).toBe(
        "resetAfterTamper"
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed or missing signed aggregates without losing unrelated preferences", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-profile-invalid-"));
    try {
      const persistence = new SnapshotPersistence(directory);
      const integrity = new ProfileStatsIntegrityService(async () => secret);
      const signed = await integrity.seal({ ...defaultProfileStats(), events: [event] });
      for (const lifetime of [
        undefined,
        {
          coverage: "complete" as const,
          entries: [
            {
              type: event.type,
              targetID: event.targetID,
              displayName: event.displayName,
              channel: event.channel,
              count: -1
            }
          ]
        }
      ]) {
        await persistence.save({
          ...defaultPersistedSnapshot(),
          ignoredIDs: ["app:ignored"],
          profileStats: { ...signed, lifetime }
        });
        const loaded = await persistence.load();
        expect(loaded.ignoredIDs).toEqual(["app:ignored"]);
        expect((await integrity.verifyOrInitialize(loaded.profileStats)).integrityStatus).toBe(
          "resetAfterTamper"
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves valid history across repeated unavailable reads and recovery", async () => {
    let unavailable = false;
    const integrity = new ProfileStatsIntegrityService(async () => {
      if (unavailable) throw new Error("synthetic unavailable secret");
      return secret;
    });
    let stats = await integrity.seal({ ...defaultProfileStats(), events: [event] });
    const originalSignature = stats.signature;
    const service = new ProfileStatsService({
      integrity,
      getStats: () => stats,
      publishStats: (next) => {
        stats = next;
      },
      persist: async () => undefined
    });
    unavailable = true;
    await service.verifyIntegrity();
    await service.recordEvents([{ ...event, id: "unavailable" }]);
    await service.recordEvents([{ ...event, id: "still-unavailable" }]);
    expect(stats.signature).toBe(originalSignature);
    expect(stats.events).toEqual([event]);
    unavailable = false;
    await service.recordEvents([{ ...event, id: "recovered" }]);
    expect(stats.events.map((entry) => entry.id)).toEqual(["recovered", "first"]);
    expect(stats.lifetime?.entries[0]?.count).toBe(2);
    expect((await integrity.verifyOrInitialize(stats)).integrityStatus).toBe("verified");
  });
});
