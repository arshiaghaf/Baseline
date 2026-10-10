// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ phase: 0, observation: false, recovery: "same" }));
vi.mock("../src/main/commandRunner", () => ({
  runMasCommand: vi.fn(),
  runBrewCommand: vi.fn(async (args: string[]) => {
    const cmd = args.join(" ");
    const name = state.phase === 0 ? "old-utility" : "new-utility";
    const names =
      state.phase === 0 && state.recovery === "ambiguous" ? [name, "other-utility"] : [name];
    const tap =
      state.phase === 2 && state.recovery === "changedTap" ? "other/tools" : "homebrew/core";
    if (cmd === "info --formula --installed --json=v2" && [1, 3].includes(state.phase))
      return { success: false, status: 1, output: "Synthetic metadata failure" };
    const output =
      cmd === "list --formula --versions"
        ? names.map((token) => `${token} 1\n`).join("")
        : cmd === "list --cask --versions"
          ? ""
          : cmd === "info --formula --installed --json=v2"
            ? JSON.stringify({
                formulae: names.map((token) => ({
                  name: token,
                  full_name: tap === "homebrew/core" ? token : `${tap}/${token}`,
                  tap,
                  installed: [{ version: "1" }],
                  oldnames:
                    state.phase === 2 && state.recovery !== "noAlias"
                      ? state.recovery === "ambiguous"
                        ? ["old-utility", "other-utility"]
                        : ["old-utility"]
                      : [],
                  ...(state.phase === 0
                    ? { pinned: true }
                    : state.recovery === "freshTrue"
                      ? { pinned: true }
                      : {})
                }))
              })
            : cmd === "outdated --formula --json=v2"
              ? JSON.stringify({
                  formulae: names.map((token) => ({
                    name: token,
                    current_version: "2",
                    ...(state.phase === 0
                      ? { pinned: true }
                      : state.phase === 1
                        ? { pinned: state.observation }
                        : {})
                  }))
                })
              : JSON.stringify({ casks: [] });
    return { success: true, status: 0, output };
  })
}));
import { HomebrewInventoryClient } from "../src/main/homebrewInventoryClient";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type ProfileStats
} from "../src/shared/domain";
import { version } from "../src/shared/version";
import { homebrewCommandToken } from "../src/shared/homebrewIdentity";

it.each([
  [false, "same"],
  [true, "same"],
  [false, "changedTap"],
  [true, "changedTap"],
  [false, "ambiguous"],
  [true, "ambiguous"],
  [false, "noAlias"],
  [true, "noAlias"],
  [false, "freshTrue"]
] as const)(
  "retains a renamed rack's explicit pin observation %s until fresh identity proves recovery %s",
  async (observation, recovery) => {
    Object.assign(state, { phase: 0, observation, recovery });
    const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-rename-pin-"));
    try {
      const client = new HomebrewInventoryClient();
      const initial = await client.fetchInventory();
      const persistence = new SnapshotPersistence(dir);
      const options = {
        persistence,
        persisted: { ...defaultPersistedSnapshot(), homebrewItems: initial.items },
        openExternalURL: async () => true,
        openAppBundle: async () => {},
        runBrewCommand: vi.fn(async () => ({ success: false, status: 1, output: "Synthetic" })),
        profileStatsIntegrity: {
          verifyOrInitialize: async (stats: ProfileStats) => ({
            ...stats,
            integrityStatus: "verified" as const
          }),
          seal: async (stats: ProfileStats) => ({ ...stats, signature: "fixture" })
        },
        clients: {
          scanner: { scanApplications: async () => [] },
          homebrew: {
            fetchIndex: async () => emptyHomebrewCaskIndex,
            lookupUpdate: () => undefined,
            searchCasks: () => []
          },
          homebrewFormula: {
            fetchIndex: async () => emptyHomebrewFormulaIndex,
            searchFormulae: () => []
          },
          selfUpdate: { lookup: async () => ({ available: false, currentVersion: version("1") }) },
          homebrewInventory: client
        }
      };
      let store = new UpdateStore(options);
      state.phase = 1;
      await store.refresh(true);
      expect(store.getSnapshot().homebrewItems[0]).toMatchObject({
        token: "new-utility",
        pinned: observation
      });
      expect(homebrewCommandToken(store.getSnapshot().homebrewItems[0]!)).toBeUndefined();
      await store.performHomebrewUpdate("formula:new-utility");
      expect(options.runBrewCommand).not.toHaveBeenCalled();
      store = new UpdateStore({ ...options, persisted: await persistence.load() });
      // A later failed read omits pin fields; the explicit observation must survive.
      state.phase = 3;
      await store.refresh(true);
      expect(store.getSnapshot().homebrewItems[0]?.pinned).toBe(observation);
      store = new UpdateStore({ ...options, persisted: await persistence.load() });
      state.phase = 2;
      await store.refresh(true);
      const same = recovery === "same" || recovery === "freshTrue";
      expect(store.getSnapshot().homebrewItems[0]?.id).toBe(
        same ? "formula:old-utility" : "formula:new-utility"
      );
      expect(store.getSnapshot().homebrewItems[0]?.pinned).toBe(
        recovery === "freshTrue" ? true : same ? observation : undefined
      );
      expect(store.getSnapshot().homebrewItems[0]?.unverifiedPinObservation).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);
