// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotPersistence } from "../src/main/persistence";
import { defaultPersistedSnapshot } from "../src/shared/domain";
import { version } from "../src/shared/version";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { force: true, recursive: true })));
  tempDirs = [];
});

describe("snapshot persistence", () => {
  it("defaults the appearance preference on older snapshots", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    await mkdir(userData, { recursive: true });
    await writeFile(path.join(userData, "baseline-snapshot.json"), "{}\n", "utf8");

    const persistence = new SnapshotPersistence(userData);

    await expect(persistence.load()).resolves.toMatchObject({
      appearancePreference: "system"
    });
  });

  it("preserves the appearance preference across save and load", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    const persistence = new SnapshotPersistence(userData);

    await persistence.save({
      ...defaultPersistedSnapshot(),
      appearancePreference: "dark"
    });

    await expect(persistence.load()).resolves.toMatchObject({
      appearancePreference: "dark"
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

  it("defaults the menu bar icon preference on older snapshots", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    await mkdir(userData, { recursive: true });
    await writeFile(path.join(userData, "baseline-snapshot.json"), "{}\n", "utf8");

    const persistence = new SnapshotPersistence(userData);

    await expect(persistence.load()).resolves.toMatchObject({
      showMenuBarIcon: true
    });
  });

  it("preserves the menu bar icon preference across save and load", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    const persistence = new SnapshotPersistence(userData);

    await persistence.save({
      ...defaultPersistedSnapshot(),
      showMenuBarIcon: false
    });

    await expect(persistence.load()).resolves.toMatchObject({
      showMenuBarIcon: false
    });
  });

  it("preserves collapsed section preferences across save and load", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-"));
    tempDirs.push(userData);
    const persistence = new SnapshotPersistence(userData);

    await persistence.save({
      ...defaultPersistedSnapshot(),
      collapsedAppSectionIDs: ["ignored", "installed"],
      collapsedHomebrewSectionIDs: ["discover", "recentlyUpdated"]
    });

    await expect(persistence.load()).resolves.toMatchObject({
      collapsedAppSectionIDs: ["ignored", "installed"],
      collapsedHomebrewSectionIDs: ["discover", "recentlyUpdated"]
    });
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
