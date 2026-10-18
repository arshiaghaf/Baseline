// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SnapshotPersistence } from "../src/main/persistence";
import { ProfileStatsIntegrityService } from "../src/main/profileStatsIntegrityService";
import { ProfileStatsService } from "../src/main/profileStatsService";
import {
  defaultPersistedSnapshot,
  defaultProfileStats,
  type ProfileStats,
  type ProfileStatsEvent
} from "../src/shared/domain";
import { SnapshotPersistence as V2Persistence } from "./Fixtures/profileStatsV2/persistence";
import { ProfileStatsIntegrityService as V2Integrity } from "./Fixtures/profileStatsV2/profileStatsIntegrityService";

const secret = "synthetic-compatibility-secret";
const event: ProfileStatsEvent = {
  id: "original",
  type: "appUpdate",
  targetID: "app:example",
  displayName: "Example",
  channel: "sparkle",
  occurredAt: "2026-10-18T00:00:00.000Z"
};
const integrity = () => new ProfileStatsIntegrityService(async () => secret);

async function populatedHistory() {
  let stats = defaultProfileStats("2026-06-01T00:00:00.000Z");
  const service = new ProfileStatsService({
    integrity: integrity(),
    getStats: () => stats,
    publishStats: (next) => {
      stats = next;
    },
    persist: async () => undefined
  });
  await service.recordEvents([event]);
  await service.recordEvents(
    Array.from({ length: 1000 }, (_, i) => ({
      ...event,
      id: `install:${i}`,
      type: "homebrewInstall",
      channel: "homebrew"
    }))
  );
  return stats;
}

describe("profile event and lifetime seal compatibility", () => {
  it("round trips through actual v2 loader/verifier without resetting events or dates", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-profile-v2-roundtrip-"));
    try {
      const before = await populatedHistory();
      const currentPersistence = new SnapshotPersistence(directory);
      await currentPersistence.save({ ...defaultPersistedSnapshot(), profileStats: before });
      const oldPersistence = new V2Persistence(directory);
      const oldLoaded = await oldPersistence.load();
      expect(oldLoaded.profileStats.lifetime).toBeUndefined();
      expect(oldLoaded.profileStats.lifetimeSeal).toBeUndefined();
      const oldVerified = await new V2Integrity(async () => secret).verifyOrInitialize(
        oldLoaded.profileStats
      );
      expect(oldVerified.integrityStatus).toBe("verified");
      expect(oldVerified.createdAt).toBe(before.createdAt);
      expect(oldVerified.startedUsingAt).toBe(before.startedUsingAt);
      expect(oldVerified.events).toEqual(before.events);
      await oldPersistence.save({ ...oldLoaded, profileStats: oldVerified });
      const returned = await integrity().verifyOrInitialize(
        (await currentPersistence.load()).profileStats
      );
      expect(returned.integrityStatus).toBe("verified");
      expect(returned.events).toEqual(before.events);
      expect(returned.startedUsingAt).toBe(before.startedUsingAt);
      expect(returned.resetNotice).toBeUndefined();
      expect(returned.lifetime?.coverage).toBe("lowerBound");
      expect(returned.lifetime?.entries).toMatchObject([{ type: "homebrewInstall", count: 1000 }]);
      expect(returned.lifetime?.entries.some((entry) => entry.type === "appUpdate")).toBe(false);
      expect((await integrity().verifyOrInitialize(returned)).lifetimeSeal).toEqual(
        returned.lifetimeSeal
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects altered payloads, wrong bindings, invalid seals and unsupported versions", async () => {
    const signed = await integrity().seal({ ...defaultProfileStats(), events: [event] });
    const other = await integrity().seal({
      ...defaultProfileStats(),
      events: [{ ...event, id: "other" }]
    });
    const mutations: Array<(stats: ProfileStats) => void> = [
      (stats) => {
        stats.lifetime!.entries[0]!.count += 1;
      },
      (stats) => {
        stats.lifetimeSeal!.eventSignature = other.signature!;
      },
      (stats) => {
        stats.lifetimeSeal!.signature = "invalid";
      },
      (stats) => {
        stats.lifetimeSeal = {
          ...stats.lifetimeSeal!,
          version: 2
        } as unknown as ProfileStats["lifetimeSeal"];
      },
      (stats) => {
        stats.lifetimeSeal = other.lifetimeSeal;
      },
      (stats) => {
        stats.lifetimeSeal = undefined;
      },
      (stats) => {
        stats.lifetime = undefined;
      }
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(signed);
      mutate(changed);
      const verified = await integrity().verifyOrInitialize(changed);
      expect(verified.integrityStatus).toBe("resetAfterTamper");
      expect(verified.events).toEqual([]);
      expect(verified.lifetime?.entries).toEqual([]);
    }
  });

  it("retains malformed envelope presence through persistence instead of migrating it as absent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-profile-invalid-envelope-"));
    try {
      const signed = await integrity().seal({ ...defaultProfileStats(), events: [event] });
      for (const fields of [
        { lifetime: null },
        { lifetimeSeal: null },
        { lifetimeSeal: { version: 9 } },
        { lifetime: { coverage: "complete", entries: null } }
      ]) {
        await writeFile(
          path.join(directory, "baseline-snapshot.json"),
          JSON.stringify({ ...defaultPersistedSnapshot(), profileStats: { ...signed, ...fields } })
        );
        const loaded = await new SnapshotPersistence(directory).load();
        expect(loaded.profileStats.lifetimeSeal).toBeNull();
        expect((await integrity().verifyOrInitialize(loaded.profileStats)).integrityStatus).toBe(
          "resetAfterTamper"
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("verifies the full v3 draft payload before converting to compatible seals", async () => {
    const draft = {
      ...defaultProfileStats(),
      signatureVersion: 3,
      events: [event],
      lifetime: {
        coverage: "lowerBound" as const,
        entries: [
          {
            type: event.type,
            targetID: event.targetID,
            displayName: event.displayName,
            channel: event.channel,
            count: 20
          }
        ]
      }
    };
    const signature = createHmac("sha256", secret)
      .update(
        JSON.stringify({
          signatureVersion: 3,
          lifetime: draft.lifetime,
          createdAt: draft.createdAt,
          startedUsingAt: draft.startedUsingAt,
          events: draft.events,
          resetNotice: undefined
        })
      )
      .digest("base64url");
    const migrated = await integrity().verifyOrInitialize({ ...draft, signature });
    expect(migrated.integrityStatus).toBe("verified");
    expect(migrated.signatureVersion).toBe(2);
    expect(migrated.lifetime).toEqual(draft.lifetime);
    expect(
      (await new V2Integrity(async () => secret).verifyOrInitialize(migrated)).integrityStatus
    ).toBe("verified");
    expect(
      (
        await integrity().verifyOrInitialize({
          ...draft,
          signature,
          lifetime: { ...draft.lifetime, coverage: "complete" }
        })
      ).integrityStatus
    ).toBe("resetAfterTamper");
    const unversioned = createHmac("sha256", secret)
      .update(
        JSON.stringify({
          createdAt: draft.createdAt,
          startedUsingAt: draft.startedUsingAt,
          events: draft.events
        })
      )
      .digest("base64url");
    expect(
      (await integrity().verifyOrInitialize({ ...draft, signature: unversioned })).integrityStatus
    ).toBe("resetAfterTamper");
    // A valid old seal cannot authorize fields in a record claiming to be v3.
    const legacy = await new V2Integrity(async () => secret).seal({
      ...draft,
      signatureVersion: 2
    });
    expect(
      (await integrity().verifyOrInitialize({ ...draft, signature: legacy.signature }))
        .integrityStatus
    ).toBe("resetAfterTamper");
  });

  it("reverifies a present envelope after unavailable secret recovery before appending", async () => {
    let unavailable = false;
    const provider = new ProfileStatsIntegrityService(async () => {
      if (unavailable) throw new Error("synthetic unavailable secret");
      return secret;
    });
    let stats = await provider.seal({ ...defaultProfileStats(), events: [event] });
    stats.lifetimeSeal!.eventSignature = "wrong-history";
    const service = new ProfileStatsService({
      integrity: provider,
      getStats: () => stats,
      publishStats: (next) => {
        stats = next;
      },
      persist: async () => undefined
    });
    unavailable = true;
    await service.verifyIntegrity();
    await service.recordEvents([{ ...event, id: "unavailable" }]);
    expect(stats.events).toEqual([event]);
    expect(stats.integrityStatus).toBe("unavailable");
    unavailable = false;
    await service.recordEvents([{ ...event, id: "recovered" }]);
    expect(stats.integrityStatus).toBe("resetAfterTamper");
    expect(stats.events.map((entry) => entry.id)).toEqual(["recovered"]);
    expect(stats.lifetime?.entries[0]?.count).toBe(1);
    expect((await provider.verifyOrInitialize(stats)).integrityStatus).toBe("resetAfterTamper");
  });

  it("rejects aggregate and combined numeric overflow before publishing counts", async () => {
    let stats = await integrity().seal({
      ...defaultProfileStats(),
      events: [event],
      lifetime: {
        coverage: "lowerBound",
        entries: [
          {
            type: event.type,
            targetID: event.targetID,
            displayName: event.displayName,
            channel: event.channel,
            count: Number.MAX_SAFE_INTEGER
          }
        ]
      }
    });
    const signature = stats.lifetimeSeal?.signature;
    const service = new ProfileStatsService({
      integrity: integrity(),
      getStats: () => stats,
      publishStats: (next) => {
        stats = next;
      },
      persist: async () => undefined
    });
    for (const next of [
      { ...event, id: "overflow" },
      { ...event, id: "overflow-other-target", targetID: "app:other" }
    ]) {
      await expect(service.recordEvents([next])).rejects.toThrow("supported numeric range");
      expect(stats.lifetimeSeal?.signature).toBe(signature);
      expect(stats.lifetime?.entries[0]?.count).toBe(Number.MAX_SAFE_INTEGER);
    }
  });
});
