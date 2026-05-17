// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const commandMock = vi.hoisted(() => ({
  calls: [] as string[][],
  results: new Map<string, { success: boolean; status: number | null; output: string }>()
}));

vi.mock("../src/main/commandRunner", () => ({
  runBrewCommand: vi.fn(async (args: string[]) => {
    commandMock.calls.push(args);
    return (
      commandMock.results.get(args.join(" ")) ?? {
        success: true,
        status: 0,
        output: "{}"
      }
    );
  })
}));

describe("HomebrewInventoryClient", () => {
  beforeEach(() => {
    commandMock.calls = [];
    commandMock.results = new Map([
      ["update", { success: true, status: 0, output: "" }],
      ["list --formula --versions", { success: true, status: 0, output: "ripgrep 14.0.0\n" }],
      ["list --cask --versions", { success: true, status: 0, output: "notion 4.0.0\n" }],
      [
        "outdated --formula --json=v2",
        {
          success: true,
          status: 0,
          output: JSON.stringify({ formulae: [{ name: "ripgrep", current_version: "14.1.0" }] })
        }
      ],
      [
        "outdated --cask --greedy --json=v2",
        {
          success: true,
          status: 0,
          output: JSON.stringify({ casks: [{ token: "notion", current_version: "4.1.0" }] })
        }
      ]
    ]);
  });

  it("runs brew update before inventory commands when metadata updates are requested", async () => {
    const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");

    const result = await new HomebrewInventoryClient().fetchInventory({ updateMetadata: true });

    expect(result.outdatedDetectionSucceeded).toBe(true);
    expect(result.outdatedDetectionSucceededByKind).toEqual({ formula: true, cask: true });
    expect(commandMock.calls[0]).toEqual(["update"]);
    expect(commandMock.calls.map((args) => args.join(" "))).toEqual([
      "update",
      "list --formula --versions",
      "list --cask --versions",
      "outdated --formula --json=v2",
      "outdated --cask --greedy --json=v2"
    ]);
  });

  it("skips brew update when metadata updates are not requested", async () => {
    const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");

    await new HomebrewInventoryClient().fetchInventory({ updateMetadata: false });

    expect(commandMock.calls.map((args) => args.join(" "))).not.toContain("update");
  });

  it("treats failed outdated commands as unreliable detection", async () => {
    commandMock.results.set("outdated --cask --greedy --json=v2", {
      success: false,
      status: 1,
      output: JSON.stringify({ casks: [{ token: "notion", current_version: "4.1.0" }] })
    });
    const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");

    const result = await new HomebrewInventoryClient().fetchInventory();

    expect(result.outdatedDetectionSucceeded).toBe(false);
    expect(result.outdatedDetectionSucceededByKind).toEqual({ formula: true, cask: false });
    expect(result.warning).toContain("cask outdated");
    expect(result.items.find((item) => item.token === "ripgrep")?.isOutdated).toBe(true);
    expect(result.items.find((item) => item.token === "notion")?.isOutdated).toBe(false);
  });

  it("treats failed metadata updates as unreliable for both Homebrew kinds", async () => {
    commandMock.results.set("update", {
      success: false,
      status: 1,
      output: "Error: update failed"
    });
    const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");

    const result = await new HomebrewInventoryClient().fetchInventory({ updateMetadata: true });

    expect(result.outdatedDetectionSucceeded).toBe(false);
    expect(result.outdatedDetectionSucceededByKind).toEqual({ formula: false, cask: false });
    expect(result.warning).toContain("brew update");
  });
});
