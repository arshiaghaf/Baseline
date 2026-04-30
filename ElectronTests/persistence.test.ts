import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotPersistence } from "../src/main/persistence";
import { defaultPersistedSnapshot } from "../src/shared/domain";

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
});
