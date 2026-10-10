// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const commandMock = vi.hoisted(() => ({
  calls: [] as string[][],
  results: new Map<
    string,
    { success: boolean; status: number | null; output: string; stdout?: string; stderr?: string }
  >()
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
        "info --cask --installed --json=v2",
        {
          success: true,
          status: 0,
          output: JSON.stringify({
            casks: [
              {
                token: "notion",
                full_token: "notion",
                tap: "homebrew/cask",
                installed: "4.0.0",
                version: "4.1.0",
                artifacts: [{ app: ["Notion.app"] }]
              }
            ]
          })
        }
      ],
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
      "outdated --cask --greedy --json=v2",
      "info --cask --installed --json=v2"
    ]);
  });

  it("retains installed tap identity and its own artifacts", async () => {
    commandMock.results.set("list --cask --versions", {
      success: true,
      status: 0,
      output: "shared-name 0.6.2\n"
    });
    commandMock.results.set("outdated --cask --greedy --json=v2", {
      success: true,
      status: 0,
      output: JSON.stringify({ casks: [{ name: "shared-name", current_version: "0.6.3" }] })
    });
    commandMock.results.set("info --cask --installed --json=v2", {
      success: true,
      status: 0,
      output: JSON.stringify({
        casks: [
          {
            token: "shared-name",
            full_token: "example/tools/shared-name",
            tap: "example/tools",
            installed: "0.6.2",
            version: "0.6.3",
            artifacts: [{ app: ["Update Utility.app"] }]
          }
        ]
      })
    });
    const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");
    const result = await new HomebrewInventoryClient().fetchInventory();
    expect(result.items.find((item) => item.kind === "cask")).toMatchObject({
      id: "cask:shared-name",
      token: "shared-name",
      fullToken: "example/tools/shared-name",
      tap: "example/tools",
      latestVersion: { raw: "0.6.3" },
      caskMetadata: { presentation: "app", appBundleNames: ["update utility.app"] }
    });
  });

  it.each([
    "{}",
    "invalid",
    JSON.stringify({
      casks: [
        {
          token: "notion",
          full_token: "other/tap/notion",
          tap: "example/tools",
          installed: "4.0.0"
        }
      ]
    })
  ])("blocks unverified casks when installed metadata is unavailable: %s", async (output) => {
    commandMock.results.set("info --cask --installed --json=v2", {
      success: true,
      status: 0,
      output
    });
    const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");
    const result = await new HomebrewInventoryClient().fetchInventory();
    expect(result.items.find((item) => item.kind === "cask")).toMatchObject({ isOutdated: false });
    expect(result.items.find((item) => item.kind === "cask")?.fullToken).toBeUndefined();
    expect(result.warning).toContain("identity could not be verified");
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

  it("parses outdated JSON from stdout when Homebrew writes warnings to stderr", async () => {
    commandMock.results.set("outdated --formula --json=v2", {
      success: true,
      status: 0,
      output:
        "Warning: Another active Homebrew process is already in progress.\n" +
        JSON.stringify({ formulae: [{ name: "ripgrep", current_version: "14.1.0" }] }),
      stdout: JSON.stringify({ formulae: [{ name: "ripgrep", current_version: "14.1.0" }] }),
      stderr: "Warning: Another active Homebrew process is already in progress.\n"
    });
    commandMock.results.set("outdated --cask --greedy --json=v2", {
      success: true,
      status: 0,
      output:
        "Warning: Another active Homebrew process is already in progress.\n" +
        JSON.stringify({ casks: [{ token: "notion", current_version: "4.1.0" }] }),
      stdout: JSON.stringify({ casks: [{ token: "notion", current_version: "4.1.0" }] }),
      stderr: "Warning: Another active Homebrew process is already in progress.\n"
    });
    const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");

    const result = await new HomebrewInventoryClient().fetchInventory();

    expect(result.outdatedDetectionSucceeded).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.items.find((item) => item.token === "ripgrep")?.isOutdated).toBe(true);
    expect(result.items.find((item) => item.token === "notion")?.isOutdated).toBe(true);
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
