// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
// Bundled only into disposable lifecycle apps. No production secret provider runs.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { UpdateStore } from "../../src/main/updateStore";
import { SnapshotPersistence, defaultPersistedSnapshot } from "../../src/main/persistence";

export function createPreparation(root: string, mode: string): () => Promise<boolean> {
  const persistence = new SnapshotPersistence(path.join(root, "profile"));
  const save = persistence.save.bind(persistence);
  let first = true;
  persistence.save = async (snapshot) => {
    if (mode === "save-fail") throw new Error("Fixture persistence refused.");
    if (first && mode === "delayed-save") {
      first = false;
      await new Promise((resolve) => setTimeout(resolve, 31000));
    }
    await save(snapshot);
  };
  const store = new UpdateStore({
    persistence,
    persisted: { ...defaultPersistedSnapshot(), autoRefreshEnabled: false },
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    runBrewCommand: async () => ({ success: false, status: 1, output: "" }),
    runMasCommand: async () => ({ success: false, status: 1, output: "" }),
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => ({ ...stats, integrityStatus: "verified" }),
      seal: async (stats) => ({ ...stats, signature: "fixture-only" })
    }
  });
  return async () => {
    const started = Date.now();
    // This accepted producer must drain before the final durable quit save.
    const writing = store
      .updatePreferences({ appearancePreference: "dark" })
      .catch(() => undefined);
    const prepared = await store.prepareToQuit();
    await writing;
    if (prepared) {
      const saved = await persistence.load();
      if (saved.appearancePreference !== "dark") throw new Error("Fixture state was not durable.");
      await writeFile(
        path.join(root, "saved.json"),
        JSON.stringify({
          appearancePreference: saved.appearancePreference,
          elapsed: Date.now() - started
        })
      );
    }
    return prepared;
  };
}
