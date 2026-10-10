// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { expect, it, vi } from "vitest";
const commands = vi.hoisted(() => ({ phase: 0 }));
vi.mock("../src/main/commandRunner", () => ({
  runMasCommand: vi.fn(),
  runBrewCommand: vi.fn(async (args: string[]) => {
    const command = args.join(" ");
    const raw = {
      token: "utility",
      full_token: "example/tools/utility",
      tap: "example/tools",
      installed: "1",
      version: "2",
      artifacts: [{ binary: ["utility"] }]
    };
    if (command === "info --cask --installed --json=v2" && commands.phase === 1)
      return { success: false, status: 1, output: "Synthetic metadata failure" };
    const output =
      command === "list --cask --versions"
        ? "utility 1\n"
        : command === "list --formula --versions"
          ? ""
          : command === "outdated --cask --greedy --json=v2"
            ? JSON.stringify({
                casks: [
                  {
                    name: "utility",
                    current_version: "2",
                    ...(commands.phase < 2 ? { pinned: true } : {})
                  }
                ]
              })
            : command === "info --cask --installed --json=v2"
              ? JSON.stringify({
                  casks: [{ ...raw, ...(commands.phase === 0 ? { pinned: true } : {}) }]
                })
              : JSON.stringify({ formulae: [] });
    return { success: true, status: 0, output };
  })
}));
import { HomebrewInventoryClient } from "../src/main/homebrewInventoryClient";
import { preservePreviousHomebrewOutdatedState } from "../src/main/updateStore";
import { homebrewCommandToken } from "../src/shared/homebrewIdentity";

it("cask pin true from outdated while installed info fails retains last proven pin identity", async () => {
  const client = new HomebrewInventoryClient();
  const initial = await client.fetchInventory();
  const known = preservePreviousHomebrewOutdatedState(
    initial.items,
    [],
    initial.outdatedDetectionSucceededByKind
  );
  expect(known[0]?.pinnedIdentity).toBe("example/tools/utility");
  commands.phase = 1;
  const failed = await client.fetchInventory();
  expect(failed.items[0]?.pinned).toBe(true);
  expect(homebrewCommandToken(failed.items[0]!)).toBeUndefined();
  const preserved = preservePreviousHomebrewOutdatedState(
    failed.items,
    known,
    failed.outdatedDetectionSucceededByKind
  );
  expect.soft(preserved[0]?.pinnedIdentity).toBe("example/tools/utility");
  commands.phase = 2;
  const recovered = await client.fetchInventory();
  const final = preservePreviousHomebrewOutdatedState(
    recovered.items,
    preserved,
    recovered.outdatedDetectionSucceededByKind
  );
  expect.soft(final[0]?.pinned).toBe(true);
});
