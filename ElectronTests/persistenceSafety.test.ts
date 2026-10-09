// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnapshotPersistence } from "../src/main/persistence";
import { defaultPersistedSnapshot } from "../src/shared/domain";

const faults = vi.hoisted(() => ({ failPrimaryRename: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const rename = async (...args: Parameters<typeof original.rename>) => {
    if (faults.failPrimaryRename && String(args[1]).endsWith("baseline-snapshot.json")) {
      throw new Error("Synthetic replacement failure");
    }
    return original.rename(...args);
  };
  return { ...original, default: { ...original, rename }, rename };
});

const directories: string[] = [];
afterEach(async () => {
  faults.failPrimaryRename = false;
  await Promise.all(directories.splice(0).map((p) => rm(p, { force: true, recursive: true })));
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-persistence-safety-"));
  directories.push(directory);
  return {
    directory,
    primary: path.join(directory, "baseline-snapshot.json"),
    backup: path.join(directory, "baseline-snapshot.json.backup"),
    persistence: new SnapshotPersistence(directory)
  };
}

describe("snapshot write safety", () => {
  it("keeps the newest complete snapshot when saves overlap", async () => {
    const { persistence, primary, backup } = await fixture();
    const older = { ...defaultPersistedSnapshot(), ignoredIDs: ["x".repeat(1_000_000)] };
    const newer = { ...defaultPersistedSnapshot(), ignoredIDs: ["newer"] };
    await Promise.all([persistence.save(older), persistence.save(newer)]);
    expect(JSON.parse(await readFile(primary, "utf8")).ignoredIDs).toEqual(["newer"]);
    expect(JSON.parse(await readFile(backup, "utf8")).ignoredIDs).toEqual(older.ignoredIDs);
  });

  it("captures mutable snapshot input at call time", async () => {
    const { persistence } = await fixture();
    const input = { ...defaultPersistedSnapshot(), ignoredIDs: ["original"] };
    const save = persistence.save(input);
    input.ignoredIDs.push("later mutation");
    await save;
    expect((await persistence.load()).ignoredIDs).toEqual(["original"]);
  });

  it("recovers a corrupt primary from its valid previous snapshot", async () => {
    const { persistence, primary } = await fixture();
    await persistence.save({ ...defaultPersistedSnapshot(), ignoredIDs: ["previous"] });
    await persistence.save({ ...defaultPersistedSnapshot(), ignoredIDs: ["newest"] });
    await writeFile(primary, "{incomplete");
    expect((await persistence.load()).ignoredIDs).toEqual(["previous"]);
  });

  it("creates recovery data on first save and retains it while replacing corrupt state", async () => {
    const { persistence, primary, backup } = await fixture();
    await persistence.save({ ...defaultPersistedSnapshot(), additionalDirectories: ["/example"] });
    await writeFile(primary, "[]");
    const recovered = await persistence.load();
    expect(recovered.additionalDirectories).toEqual(["/example"]);
    await persistence.save({ ...recovered, ignoredIDs: ["new"] });
    expect(JSON.parse(await readFile(backup, "utf8")).additionalDirectories).toEqual(["/example"]);
    expect((await persistence.load()).ignoredIDs).toEqual(["new"]);
  });

  it("leaves the committed primary intact on rename failure and accepts subsequent saves", async () => {
    const { persistence, primary, directory } = await fixture();
    await persistence.save({ ...defaultPersistedSnapshot(), ignoredIDs: ["committed"] });
    faults.failPrimaryRename = true;
    await expect(
      persistence.save({ ...defaultPersistedSnapshot(), ignoredIDs: ["failed"] })
    ).rejects.toThrow("Synthetic replacement failure");
    expect(JSON.parse(await readFile(primary, "utf8")).ignoredIDs).toEqual(["committed"]);
    expect(await readdir(directory)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.tmp$/u)])
    );
    faults.failPrimaryRename = false;
    await persistence.save({ ...defaultPersistedSnapshot(), ignoredIDs: ["recovered"] });
    expect((await persistence.load()).ignoredIDs).toEqual(["recovered"]);
  });

  it("falls back to defaults only when neither primary nor backup is valid", async () => {
    const { persistence, primary, backup } = await fixture();
    await writeFile(primary, "null");
    await writeFile(backup, "broken");
    expect((await persistence.load()).ignoredIDs).toEqual([]);
  });
});
