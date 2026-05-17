// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
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
      recentlyUpdated: [
        {
          id: "app:example",
          appID: "app:example",
          displayName: "Example",
          source: "sparkle",
          fromVersion: version("1.0.0"),
          toVersion: version("2.0.0"),
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
      recentlyUpdated: [
        {
          appID: "app:example",
          source: "sparkle",
          fromVersion: { raw: "1.0.0" },
          toVersion: { raw: "2.0.0" }
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
