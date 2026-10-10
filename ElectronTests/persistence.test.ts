// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotPersistence } from "../src/main/persistence";
import { defaultPersistedSnapshot, profileStatsSignatureVersion } from "../src/shared/domain";
import { version } from "../src/shared/version";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { force: true, recursive: true })));
  tempDirs = [];
});

describe("snapshot persistence", () => {
  it.each([
    ["marketing", "marketing"],
    ["build", "build"],
    [undefined, undefined],
    ["unexpected", undefined]
  ])("loads Sparkle comparison domain %s compatibly", async (savedDomain, expectedDomain) => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    await writeFile(
      path.join(userData, "baseline-snapshot.json"),
      JSON.stringify({
        updates: [
          {
            id: "/Applications/Example.app",
            appID: "/Applications/Example.app",
            source: "sparkle",
            localVersion: version("2026.1"),
            remoteVersion: version("201"),
            sparkleVersionComparison: savedDomain
          }
        ]
      })
    );
    const loaded = await new SnapshotPersistence(userData).load();
    expect(loaded.updates[0]?.sparkleVersionComparison).toBe(expectedDomain);
    expect(loaded.updates[0]?.remoteVersion).toEqual(version("201"));
  });

  it("round-trips installed cask identity and metadata with existing preferences", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    const persistence = new SnapshotPersistence(userData);
    const saved = {
      ...defaultPersistedSnapshot(),
      ignoredHomebrewItemIDs: ["cask:shared-name"],
      additionalDirectories: ["/Custom Apps"],
      homebrewItems: [
        {
          id: "cask:shared-name",
          token: "shared-name",
          name: "Utility",
          kind: "cask" as const,
          fullToken: "example/tools/shared-name",
          tap: "example/tools",
          installedVersion: version("1.0"),
          isOutdated: false,
          caskMetadata: {
            token: "shared-name",
            fullToken: "example/tools/shared-name",
            tap: "example/tools",
            version: version("1.0"),
            presentation: "app" as const,
            bundleIdentifiers: [],
            appBundleNames: ["utility.app"]
          }
        }
      ]
    };
    await persistence.save(saved);
    expect(await persistence.load()).toMatchObject({
      homebrewItems: saved.homebrewItems,
      ignoredHomebrewItemIDs: saved.ignoredHomebrewItemIDs,
      additionalDirectories: saved.additionalDirectories
    });
  });

  it("persists hidden formula continuity without restoring action authority", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    const persistence = new SnapshotPersistence(userData);
    const item = {
      id: "formula:old-tool",
      token: "old-tool",
      name: "Old Tool",
      kind: "formula" as const,
      installedVersion: version("1"),
      latestVersion: version("2"),
      isOutdated: true,
      formulaIdentityVerified: true,
      formulaIdentity: {
        name: "old-tool",
        fullName: "example/tools/old-tool",
        tap: "example/tools",
        oldNames: []
      }
    };
    await persistence.save({
      ...defaultPersistedSnapshot(),
      homebrewFormulaIdentityContinuity: [item]
    });
    const loaded = await persistence.load();
    expect(loaded.homebrewItems).toEqual([]);
    expect(loaded.homebrewFormulaIdentityContinuity).toEqual([
      { ...item, formulaIdentityVerified: false, isOutdated: false, latestVersion: undefined }
    ]);
  });

  it("defaults preferences and profile history on older snapshots", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    await writeFile(path.join(userData, "baseline-snapshot.json"), "{}\n", "utf8");

    const loaded = await new SnapshotPersistence(userData).load();
    expect(loaded).toMatchObject({
      appearancePreference: "system",
      showMenuBarIcon: true,
      profileStats: { events: [], integrityStatus: "pending" }
    });
    expect(Number.isFinite(new Date(loaded.profileStats.startedUsingAt).getTime())).toBe(true);
  });

  it("round-trips appearance, menu bar visibility and collapsed section preferences", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    const persistence = new SnapshotPersistence(userData);

    await persistence.save({
      ...defaultPersistedSnapshot(),
      appearancePreference: "dark",
      showMenuBarIcon: false,
      collapsedAppSectionIDs: ["ignored", "installed"],
      collapsedHomebrewSectionIDs: ["discover", "recentlyUpdated"]
    });

    await expect(persistence.load()).resolves.toMatchObject({
      appearancePreference: "dark",
      showMenuBarIcon: false,
      collapsedAppSectionIDs: ["ignored", "installed"],
      collapsedHomebrewSectionIDs: ["discover", "recentlyUpdated"]
    });
  });

  it("does not restore the previously selected sidebar tab", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    const persistence = new SnapshotPersistence(userData);

    await persistence.save({
      ...defaultPersistedSnapshot(),
      selectedTab: "homebrew"
    });

    await expect(persistence.load()).resolves.toMatchObject({
      selectedTab: "all"
    });
  });

  it("normalizes invalid appearance preferences from older or edited snapshots", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    await mkdir(userData, { recursive: true });
    await writeFile(
      path.join(userData, "baseline-snapshot.json"),
      JSON.stringify({ appearancePreference: "sepia" }),
      "utf8"
    );

    const persistence = new SnapshotPersistence(userData);

    await expect(persistence.load()).resolves.toMatchObject({
      appearancePreference: "system"
    });
  });

  it("preserves profile stats events across save and load", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    const persistence = new SnapshotPersistence(userData);

    await persistence.save({
      ...defaultPersistedSnapshot(),
      profileStats: {
        createdAt: "2026-06-01T12:00:00.000Z",
        startedUsingAt: "2026-05-15T12:00:00.000Z",
        signatureVersion: profileStatsSignatureVersion,
        signature: "signed",
        integrityStatus: "verified",
        events: [
          {
            id: "appUpdate:app:example:1:2::",
            type: "appUpdate",
            targetID: "app:example",
            displayName: "Example",
            channel: "sparkle",
            occurredAt: "2026-06-02T12:00:00.000Z"
          }
        ]
      }
    });

    await expect(persistence.load()).resolves.toMatchObject({
      profileStats: {
        createdAt: "2026-06-01T12:00:00.000Z",
        startedUsingAt: "2026-05-15T12:00:00.000Z",
        signature: "signed",
        integrityStatus: "pending",
        events: [
          {
            id: "appUpdate:app:example:1:2::",
            type: "appUpdate",
            targetID: "app:example",
            displayName: "Example",
            channel: "sparkle",
            occurredAt: "2026-06-02T12:00:00.000Z"
          }
        ]
      }
    });
  });

  it("preserves profile stats reset notice acknowledgement across save and load", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    const persistence = new SnapshotPersistence(userData);

    await persistence.save({
      ...defaultPersistedSnapshot(),
      profileStatsResetAcknowledgedID: "tamper:2026-06-05T12:00:00.000Z",
      profileStats: {
        ...defaultPersistedSnapshot().profileStats,
        resetNotice: {
          id: "tamper:2026-06-05T12:00:00.000Z",
          occurredAt: "2026-06-05T12:00:00.000Z",
          reason: "tamper"
        }
      }
    });

    await expect(persistence.load()).resolves.toMatchObject({
      profileStatsResetAcknowledgedID: "tamper:2026-06-05T12:00:00.000Z",
      profileStats: {
        resetNotice: {
          id: "tamper:2026-06-05T12:00:00.000Z",
          occurredAt: "2026-06-05T12:00:00.000Z",
          reason: "tamper"
        }
      }
    });
  });

  it("drops malformed profile stats events without resetting the snapshot", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    await mkdir(userData, { recursive: true });
    await writeFile(
      path.join(userData, "baseline-snapshot.json"),
      `${JSON.stringify({
        ...defaultPersistedSnapshot(),
        showMenuBarIcon: false,
        profileStats: {
          ...defaultPersistedSnapshot().profileStats,
          events: [
            null,
            {
              id: "appUpdate:app:example:1:2::",
              type: "appUpdate",
              targetID: "app:example",
              displayName: "Example",
              channel: "sparkle",
              occurredAt: "2026-06-02T12:00:00.000Z"
            }
          ]
        }
      })}\n`,
      "utf8"
    );

    const loaded = await new SnapshotPersistence(userData).load();

    expect(loaded.showMenuBarIcon).toBe(false);
    expect(loaded.profileStats.events).toEqual([
      {
        id: "appUpdate:app:example:1:2::",
        type: "appUpdate",
        targetID: "app:example",
        displayName: "Example",
        channel: "sparkle",
        occurredAt: "2026-06-02T12:00:00.000Z"
      }
    ]);
  });

  it("preserves recently updated and ignored state across save and load", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    const persistence = new SnapshotPersistence(userData);

    await persistence.save({
      ...defaultPersistedSnapshot(),
      ignoredIDs: ["app:ignored"],
      ignoredHomebrewItemIDs: ["formula:ripgrep"],
      updates: [
        {
          id: "app:example",
          appID: "app:example",
          source: "sparkle",
          supportLevel: "limited",
          localVersion: version("1.0.0"),
          remoteVersion: version("1.0.0"),
          localBuildVersion: version("100"),
          remoteBuildVersion: version("101"),
          checkedAt: "2026-04-30T12:00:00.000Z"
        }
      ],
      recentlyUpdated: [
        {
          id: "app:example",
          appID: "app:example",
          displayName: "Example",
          source: "sparkle",
          fromVersion: version("1.0.0"),
          toVersion: version("2.0.0"),
          fromBuildVersion: version("100"),
          toBuildVersion: version("101"),
          updatedAt: "2026-04-30T12:00:00.000Z"
        }
      ],
      homebrewRecentlyUpdated: [
        {
          id: "formula:ripgrep",
          itemID: "formula:ripgrep",
          token: "ripgrep",
          kind: "formula",
          displayName: "ripgrep",
          fromVersion: version("14.0.0"),
          toVersion: version("14.1.0"),
          updatedAt: "2026-04-30T12:00:00.000Z"
        }
      ]
    });

    await expect(persistence.load()).resolves.toMatchObject({
      ignoredIDs: ["app:ignored"],
      ignoredHomebrewItemIDs: ["formula:ripgrep"],
      updates: [
        {
          appID: "app:example",
          source: "sparkle",
          localVersion: { raw: "1.0.0" },
          remoteVersion: { raw: "1.0.0" },
          localBuildVersion: { raw: "100" },
          remoteBuildVersion: { raw: "101" }
        }
      ],
      recentlyUpdated: [
        {
          appID: "app:example",
          source: "sparkle",
          fromVersion: { raw: "1.0.0" },
          toVersion: { raw: "2.0.0" },
          fromBuildVersion: { raw: "100" },
          toBuildVersion: { raw: "101" }
        }
      ],
      homebrewRecentlyUpdated: [
        {
          itemID: "formula:ripgrep",
          fromVersion: { raw: "14.0.0" },
          toVersion: { raw: "14.1.0" }
        }
      ]
    });
  });
});
