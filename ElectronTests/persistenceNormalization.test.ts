// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotPersistence } from "../src/main/persistence";
import { ProfileStatsIntegrityService } from "../src/main/profileStatsIntegrityService";
import { defaultPersistedSnapshot } from "../src/shared/domain";
import { version } from "../src/shared/version";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function load(input: unknown) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-field-recovery-"));
  directories.push(directory);
  await writeFile(path.join(directory, "baseline-snapshot.json"), JSON.stringify(input));
  return new SnapshotPersistence(directory).load();
}

const preferences = {
  ignoredIDs: ["app:ignored"],
  ignoredHomebrewItemIDs: ["formula:ignored"],
  additionalDirectories: ["/Extra Apps"],
  collapsedAppSectionIDs: ["installed"],
  collapsedHomebrewSectionIDs: ["recentlyUpdated"],
  autoRefreshEnabled: false,
  refreshIntervalMinutes: 30,
  appearancePreference: "dark",
  useMasForAppStoreUpdates: false,
  showMenuBarIcon: false,
  showDockIcon: true
};

describe("saved snapshot field recovery", () => {
  it.each([
    { apps: {} },
    { apps: [null] },
    {
      apps: [
        {
          id: "example",
          displayName: "Example",
          bundlePath: "/Example.app",
          localVersion: { raw: 3 }
        }
      ]
    },
    { updates: "broken" },
    { recentlyUpdated: [null] },
    { appUpdateComparisonBaseline: {} },
    { homebrewItems: [null] },
    { homebrewFormulaIdentityContinuity: {} },
    { homebrewRecentlyUpdated: {} }
  ])("keeps valid preferences when another saved field is malformed: %j", async (damaged) => {
    expect(await load({ ...preferences, ...damaged })).toMatchObject(preferences);
  });

  it("defaults invalid preferences independently and retains valid list entries", async () => {
    const loaded = await load({
      ignoredIDs: ["app:kept", null, 5],
      ignoredHomebrewItemIDs: {},
      additionalDirectories: ["/Extra Apps", false],
      collapsedAppSectionIDs: "installed",
      collapsedHomebrewSectionIDs: [null, "ignored"],
      autoRefreshEnabled: "false",
      useMasForAppStoreUpdates: null,
      refreshIntervalMinutes: "30",
      appearancePreference: "dark"
    });
    expect(loaded).toMatchObject({
      ignoredIDs: ["app:kept"],
      ignoredHomebrewItemIDs: [],
      additionalDirectories: ["/Extra Apps"],
      collapsedAppSectionIDs: [],
      collapsedHomebrewSectionIDs: ["ignored"],
      autoRefreshEnabled: true,
      useMasForAppStoreUpdates: true,
      refreshIntervalMinutes: 60,
      appearancePreference: "dark"
    });
  });

  it("does not restore memory-only fields from an edited snapshot", async () => {
    const loaded = await load({
      ...preferences,
      isHomebrewInstalled: true,
      operationFailureDetails: { example: { outputTail: "private output" } },
      homebrewOperation: { id: "obsolete", phase: "running" },
      homebrewConfigurationValidated: true,
      selfUpdate: { available: true },
      startedUsingAt: "2020-01-01T00:00:00.000Z"
    });
    expect(loaded).toMatchObject(preferences);
    for (const key of [
      "isHomebrewInstalled",
      "operationFailureDetails",
      "homebrewOperation",
      "homebrewConfigurationValidated",
      "selfUpdate",
      "startedUsingAt"
    ]) {
      expect(loaded).not.toHaveProperty(key);
    }
    expect(loaded.profileStats.startedUsingAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it.each([
    [null, 60],
    ["20", 60],
    [-20, 5],
    [1500, 1440],
    [15, 15]
  ])("normalizes refresh interval %j without coercing non-numbers", async (input, expected) => {
    const loaded = await load({ ...preferences, refreshIntervalMinutes: input });
    expect(loaded.refreshIntervalMinutes).toBe(expected);
    expect(loaded.ignoredIDs).toEqual(preferences.ignoredIDs);
  });

  it("retains valid records beside malformed rows and nested metadata", async () => {
    const app = {
      bundlePath: "/Fixture.app",
      displayName: "Fixture",
      localVersion: version("1"),
      sourceHint: "sparkle"
    };
    const update = {
      appID: app.bundlePath,
      source: "sparkle",
      localVersion: version("1"),
      remoteVersion: version("2"),
      homebrewToken: { malformed: true },
      releaseNotesSummary: ["malformed"]
    };
    const recent = {
      appID: app.bundlePath,
      displayName: app.displayName,
      fromVersion: version("1"),
      toVersion: version("2"),
      updatedAt: "2026-10-18T00:00:00.000Z"
    };
    const item = {
      id: "formula:saved-id",
      token: "current-name",
      name: "Tool",
      kind: "formula",
      installedVersion: version("1"),
      pinned: true,
      pinnedIdentity: "example/tools/current-name",
      formulaIdentity: {
        name: "current-name",
        fullName: "example/tools/current-name",
        tap: "example/tools",
        oldNames: ["saved-id"]
      },
      formulaIdentityVerified: true,
      caskMetadata: { token: "broken", bundleIdentifiers: {}, appBundleNames: [] },
      latestVersion: { raw: 5 },
      isOutdated: false
    };
    const loaded = await load({
      ...preferences,
      apps: [null, [], 5, app],
      updates: [null, { appID: app.bundlePath, localVersion: version("1") }, update],
      recentlyUpdated: [null, { ...recent, fromVersion: { raw: 1 } }, recent],
      homebrewItems: [null, { ...item, kind: "other" }, item],
      homebrewFormulaIdentityContinuity: [null, item],
      homebrewRecentlyUpdated: [
        null,
        { ...recent, itemID: item.id, token: item.token, kind: "formula" }
      ]
    });
    expect(loaded).toMatchObject(preferences);
    expect(loaded.apps).toEqual([{ ...app, id: app.bundlePath }]);
    expect(loaded.updates).toHaveLength(1);
    expect(loaded.updates[0]).toMatchObject({ id: app.bundlePath, remoteVersion: version("2") });
    expect(loaded.updates[0]?.homebrewToken).toBeUndefined();
    expect(loaded.updates[0]?.releaseNotesSummary).toBeUndefined();
    expect(loaded.recentlyUpdated).toEqual([{ ...recent, id: app.bundlePath }]);
    expect(loaded.homebrewItems).toHaveLength(1);
    expect(loaded.homebrewItems[0]).toMatchObject({
      id: item.id,
      pinned: true,
      pinnedIdentity: item.pinnedIdentity,
      formulaIdentity: item.formulaIdentity
    });
    expect(loaded.homebrewItems[0]?.caskMetadata).toBeUndefined();
    expect(loaded.homebrewItems[0]?.latestVersion).toBeUndefined();
    expect(loaded.homebrewFormulaIdentityContinuity).toMatchObject([
      { id: item.id, pinned: true, formulaIdentityVerified: false, isOutdated: false }
    ]);
    expect(loaded.homebrewRecentlyUpdated).toHaveLength(1);
  });

  it.each([
    undefined,
    null,
    {},
    [],
    [null],
    [{ appID: "example", source: "sparkle", localVersion: { raw: 1 } }],
    [
      {
        appID: "example",
        source: "sparkle",
        localVersion: version("1"),
        localBuildVersion: { raw: 1 }
      }
    ]
  ])("only migrates absent legacy comparison baselines (%j)", async (baseline) => {
    const loaded = await load({
      ...preferences,
      updates: [
        {
          appID: "example",
          source: "sparkle",
          localVersion: version("1"),
          remoteVersion: version("2"),
          updateURL: "https://example.com"
        }
      ],
      appUpdateComparisonBaseline: baseline
    });
    expect(loaded.updates).toHaveLength(1);
    expect(loaded.appUpdateComparisonBaseline).toEqual(
      baseline === undefined
        ? [{ appID: "example", source: "sparkle", localVersion: version("1") }]
        : []
    );
    expect(loaded).toMatchObject(preferences);
  });

  it("uses recoverable primary fields instead of stale backup preferences and survives another save", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-field-backup-"));
    directories.push(directory);
    const primary = path.join(directory, "baseline-snapshot.json");
    await writeFile(primary, JSON.stringify({ ...preferences, apps: {} }));
    await writeFile(`${primary}.backup`, JSON.stringify(defaultPersistedSnapshot()));
    const persistence = new SnapshotPersistence(directory);
    const recovered = await persistence.load();
    expect(recovered).toMatchObject(preferences);
    await persistence.save(recovered);
    expect(await new SnapshotPersistence(directory).load()).toMatchObject(preferences);
    expect(JSON.parse(await readFile(`${primary}.backup`, "utf8"))).toMatchObject(preferences);
  });
});

describe("profile history during field recovery", () => {
  const integrity = new ProfileStatsIntegrityService(async () => "fixture-secret");
  const event = {
    id: "appUpdate:fixture",
    type: "appUpdate" as const,
    targetID: "fixture",
    displayName: "Fixture",
    channel: "sparkle" as const,
    occurredAt: "2026-10-18T00:00:00.000Z"
  };

  it("preserves a valid event signature and lifetime seal beside a damaged field", async () => {
    const profileStats = await integrity.seal({
      ...defaultPersistedSnapshot().profileStats,
      events: [event]
    });
    const loaded = await load({ ...preferences, apps: {}, profileStats });
    expect(loaded).toMatchObject(preferences);
    expect(loaded.profileStats).toEqual({ ...profileStats, integrityStatus: "pending" });
    const verified = await integrity.verifyOrInitialize(loaded.profileStats);
    expect(verified.integrityStatus).toBe("verified");
    expect(verified.signature).toBe(profileStats.signature);
    expect(verified.lifetimeSeal).toEqual(profileStats.lifetimeSeal);
  });

  it.each(["legacy", "unversioned", "v2", "v3"])(
    "preserves valid %s history through partial snapshot recovery and rejects malformed appended events",
    async (format) => {
      const stats = { ...defaultPersistedSnapshot().profileStats, events: [event] };
      const lifetime = {
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
      };
      const signatureVersion = format === "v3" ? 3 : 2;
      const payload = {
        ...(format === "v2" || format === "v3" ? { signatureVersion } : {}),
        ...(format === "v3" ? { lifetime } : {}),
        createdAt: stats.createdAt,
        ...(format !== "legacy" ? { startedUsingAt: stats.startedUsingAt } : {}),
        events: stats.events
      };
      const signature = createHmac("sha256", "fixture-secret")
        .update(JSON.stringify(payload))
        .digest("base64url");
      const profileStats = {
        ...stats,
        signatureVersion,
        ...(format === "v3" ? { lifetime } : {}),
        signature
      };
      const loaded = await load({ ...preferences, updates: {}, profileStats });
      expect(loaded).toMatchObject(preferences);
      expect(loaded.profileStats.signature).toBe(signature);
      const verified = await integrity.verifyOrInitialize(loaded.profileStats);
      expect(verified.integrityStatus).toBe("verified");
      expect(verified.events).toEqual([event]);
      expect(verified.lifetime?.entries[0]?.count).toBe(format === "v3" ? 20 : 1);
      const tampered = await load({
        ...preferences,
        profileStats: { ...profileStats, events: [event, null] }
      });
      expect((await integrity.verifyOrInitialize(tampered.profileStats)).integrityStatus).toBe(
        "resetAfterTamper"
      );
    }
  );

  it.each([
    { events: [null] },
    { events: {} },
    { events: [{ ...event, occurredAt: 5 }] },
    { resetNotice: { reason: "other" } },
    { lifetime: { coverage: "complete", entries: [null] } },
    { lifetimeSeal: null },
    { signatureVersion: "2" }
  ])("does not bless a repaired payload matching an old valid signature: %j", async (damaged) => {
    const sealed = await integrity.seal(defaultPersistedSnapshot().profileStats);
    const loaded = await load({ ...preferences, profileStats: { ...sealed, ...damaged } });
    expect(loaded).toMatchObject(preferences);
    const verified = await integrity.verifyOrInitialize(loaded.profileStats);
    expect(verified.integrityStatus).toBe("resetAfterTamper");
    expect(verified.events).toEqual([]);
  });

  it.each([null, [], "broken", { events: [null] }, { events: "broken" }])(
    "rejects malformed unsigned history instead of initializing it: %j",
    async (profileStats) => {
      const loaded = await load({ ...preferences, profileStats });
      expect(loaded).toMatchObject(preferences);
      const verified = await integrity.verifyOrInitialize(loaded.profileStats);
      expect(verified.integrityStatus).toBe("resetAfterTamper");
    }
  );

  it("preserves malformed-history rejection evidence through unavailable integrity and relaunch", async () => {
    const sealed = await integrity.seal({
      ...defaultPersistedSnapshot().profileStats,
      events: [event]
    });
    const loaded = await load({
      ...preferences,
      profileStats: { ...sealed, events: [event, null] }
    });
    const unavailable = new ProfileStatsIntegrityService(async () => {
      throw new Error("unavailable");
    });
    const pending = await unavailable.verifyOrInitialize(loaded.profileStats);
    expect(pending.integrityStatus).toBe("unavailable");
    expect(pending.events).toEqual([event]);
    const reloaded = await load({ ...loaded, profileStats: pending });
    const verified = await integrity.verifyOrInitialize(reloaded.profileStats);
    expect(verified.integrityStatus).toBe("resetAfterTamper");
  });

  it.each([
    null,
    { coverage: "complete", entries: [null] },
    {
      coverage: "complete",
      entries: [
        {
          type: event.type,
          channel: event.channel,
          targetID: event.targetID,
          displayName: event.displayName,
          count: 0
        }
      ]
    }
  ])(
    "retains malformed unsigned v3 lifetime evidence through durable recovery: %j",
    async (lifetime) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-v3-recovery-"));
      directories.push(directory);
      await writeFile(
        path.join(directory, "baseline-snapshot.json"),
        JSON.stringify({
          ...preferences,
          profileStats: {
            ...defaultPersistedSnapshot().profileStats,
            signatureVersion: 3,
            lifetime
          }
        })
      );
      const persistence = new SnapshotPersistence(directory);
      const loaded = await persistence.load();
      expect(loaded).toMatchObject(preferences);
      expect(loaded.profileStats.lifetimeSeal).toBeNull();
      await persistence.save(loaded);
      const reloaded = await new SnapshotPersistence(directory).load();
      expect((await integrity.verifyOrInitialize(reloaded.profileStats)).integrityStatus).toBe(
        "resetAfterTamper"
      );

      const unavailable = new ProfileStatsIntegrityService(async () => {
        throw new Error("fixture integrity unavailable");
      });
      const pending = await unavailable.verifyOrInitialize(reloaded.profileStats);
      expect(pending.integrityStatus).toBe("unavailable");
      await persistence.save({ ...reloaded, profileStats: pending });
      const recovered = await new SnapshotPersistence(directory).load();
      expect(recovered).toMatchObject(preferences);
      expect(recovered.profileStats.lifetimeSeal).toBeNull();
      const verified = await integrity.verifyOrInitialize(recovered.profileStats);
      expect(verified.integrityStatus).toBe("resetAfterTamper");
      expect(verified.events).toEqual([]);
      expect(verified.lifetime?.entries).toEqual([]);
    }
  );
});
