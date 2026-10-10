// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, mkdir, symlink, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
      [
        "info --formula --installed --json=v2",
        {
          success: true,
          status: 0,
          output: JSON.stringify({
            formulae: [
              {
                name: "ripgrep",
                full_name: "ripgrep",
                tap: "homebrew/core",
                installed: [{ version: "14.0.0" }]
              }
            ]
          })
        }
      ],
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

  it("joins custom formula updates by verified full name while retaining the saved rack ID", async () => {
    commandMock.results.set("list --formula --versions", {
      success: true,
      status: 0,
      output: "utility 1.0\n"
    });
    commandMock.results.set("info --formula --installed --json=v2", {
      success: true,
      status: 0,
      output: JSON.stringify({
        formulae: [
          {
            name: "utility",
            full_name: "example/tools/utility",
            tap: "example/tools",
            installed: [{ version: "1.0" }]
          }
        ]
      })
    });
    commandMock.results.set("outdated --formula --json=v2", {
      success: true,
      status: 0,
      output: JSON.stringify({
        formulae: [
          { name: "utility", current_version: "99" },
          { name: "other/tools/utility", current_version: "88" },
          { name: "example/tools/utility", current_version: "2.0", pinned: true }
        ]
      })
    });
    const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");
    const { homebrewCommandToken } = await import("../src/shared/homebrewIdentity");
    const item = (await new HomebrewInventoryClient().fetchInventory()).items.find(
      (item) => item.kind === "formula"
    )!;
    expect(item).toMatchObject({
      id: "formula:utility",
      fullToken: "example/tools/utility",
      isOutdated: true,
      pinned: true,
      latestVersion: { raw: "2.0" }
    });
    expect(homebrewCommandToken(item)).toBe("example/tools/utility");
  });

  it.each([
    "{}",
    "invalid",
    JSON.stringify({
      formulae: [
        {
          name: "ripgrep",
          full_name: "example/tools/ripgrep",
          tap: "other/tools",
          installed: [{ version: "14" }]
        }
      ]
    }),
    JSON.stringify({
      formulae: [
        {
          name: "ripgrep",
          full_name: "ripgrep",
          tap: "homebrew/core",
          installed: [{ version: "14" }]
        },
        {
          name: "ripgrep",
          full_name: "example/tools/ripgrep",
          tap: "example/tools",
          installed: [{ version: "14" }]
        }
      ]
    })
  ])("blocks unverified or ambiguous installed formula identities: %s", async (output) => {
    commandMock.results.set("info --formula --installed --json=v2", {
      success: true,
      status: 0,
      output
    });
    const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");
    const result = await new HomebrewInventoryClient().fetchInventory();
    expect(result.items.find((item) => item.kind === "formula")).toMatchObject({
      isOutdated: false,
      latestVersion: undefined
    });
    expect(result.warning).toContain("Installed formula identity could not be verified");
  });

  it.each(["old-tool", "example/tools/old-tool"])(
    "preserves a historical rack ID for an installed formula rename alias %s",
    async (oldName) => {
      commandMock.results.set("list --formula --versions", {
        success: true,
        status: 0,
        output: "old-tool 1\n"
      });
      commandMock.results.set("info --formula --installed --json=v2", {
        success: true,
        status: 0,
        output: JSON.stringify({
          formulae: [
            {
              name: "new-tool",
              full_name: "example/tools/new-tool",
              tap: "example/tools",
              oldnames: [oldName],
              installed: [{ version: "1" }]
            }
          ]
        })
      });
      commandMock.results.set("outdated --formula --json=v2", {
        success: true,
        status: 0,
        output: JSON.stringify({
          formulae: [{ name: "example/tools/new-tool", current_version: "2" }]
        })
      });
      const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");
      const { homebrewCommandToken } = await import("../src/shared/homebrewIdentity");
      const item = (await new HomebrewInventoryClient().fetchInventory()).items.find(
        (item) => item.kind === "formula"
      )!;
      expect(item.id).toBe("formula:old-tool");
      expect(item.isOutdated).toBe(true);
      expect(homebrewCommandToken(item)).toBe("example/tools/new-tool");
    }
  );

  it("retains pin status for current casks and accepts older Homebrew without a pin field", async () => {
    const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");
    const raw = JSON.parse(commandMock.results.get("info --cask --installed --json=v2")!.output);
    raw.casks[0].pinned = true;
    commandMock.results.set("info --cask --installed --json=v2", {
      success: true,
      status: 0,
      output: JSON.stringify(raw)
    });
    commandMock.results.set("outdated --cask --greedy --json=v2", {
      success: true,
      status: 0,
      output: JSON.stringify({ casks: [] })
    });
    expect(
      (await new HomebrewInventoryClient().fetchInventory()).items.find(
        (item) => item.kind === "cask"
      )
    ).toMatchObject({ pinned: true, isOutdated: false });
    expect(
      (await new HomebrewInventoryClient().fetchInventory()).items.find(
        (item) => item.kind === "formula"
      )?.pinned
    ).toBeUndefined();
  });

  it("runs brew update before inventory commands when metadata updates are requested", async () => {
    const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");
    const { runBrewCommand } = await import("../src/main/commandRunner");
    let finishUpdate!: () => void;
    const metadataUpdate = new Promise<void>((resolve) => {
      finishUpdate = resolve;
    });
    vi.mocked(runBrewCommand).mockImplementationOnce(async (args) => {
      commandMock.calls.push(args);
      await metadataUpdate;
      return { success: true, status: 0, output: "" };
    });

    const inventory = new HomebrewInventoryClient().fetchInventory({ updateMetadata: true });
    try {
      expect(commandMock.calls).toEqual([["update"]]);
    } finally {
      finishUpdate();
    }
    const result = await inventory;

    expect(result.outdatedDetectionSucceeded).toBe(true);
    expect(result.outdatedDetectionSucceededByKind).toEqual({ formula: true, cask: true });
    expect(
      commandMock.calls
        .slice(1)
        .map((args) => args.join(" "))
        .sort()
    ).toEqual(
      [
        "list --formula --versions",
        "list --cask --versions",
        "outdated --formula --json=v2",
        "outdated --cask --greedy --json=v2",
        "info --cask --installed --json=v2",
        "info --formula --installed --json=v2"
      ].sort()
    );
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

  it.each(["homebrew/cask", "example/tools"])(
    "retains installed renamed casks with historical full tokens in %s",
    async (tap) => {
      commandMock.results.set("list --cask --versions", {
        success: true,
        status: 0,
        output: "renamed-utility 1.0\n"
      });
      commandMock.results.set("outdated --cask --greedy --json=v2", {
        success: true,
        status: 0,
        output: JSON.stringify({ casks: [{ name: "renamed-utility", current_version: "2.0" }] })
      });
      const fullToken = tap === "homebrew/cask" ? "old-utility" : `${tap}/old-utility`;
      commandMock.results.set("info --cask --installed --json=v2", {
        success: true,
        status: 0,
        output: JSON.stringify({
          casks: [
            {
              token: "renamed-utility",
              full_token: fullToken,
              tap,
              old_tokens: [],
              installed: "1.0",
              version: "2.0",
              artifacts: [{ app: ["Utility.app"] }]
            }
          ]
        })
      });
      const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");
      const { homebrewCommandToken } = await import("../src/shared/homebrewIdentity");
      const result = await new HomebrewInventoryClient().fetchInventory();
      const item = result.items.find((item) => item.kind === "cask")!;
      expect(item).toMatchObject({
        id: "cask:renamed-utility",
        token: "renamed-utility",
        fullToken,
        tap,
        isOutdated: true,
        latestVersion: { raw: "2.0" },
        caskMetadata: { token: "renamed-utility", fullToken, tap, presentation: "app" }
      });
      expect(homebrewCommandToken(item)).toBe(`${tap}/renamed-utility`);
      expect(result.warning).toBeUndefined();
    }
  );

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

  it("canonicalizes installed app targets for symlinked custom app directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-cask-target-"));
    try {
      const actual = path.join(root, "Actual.app");
      const target = path.join(root, "Renamed.app");
      await mkdir(actual);
      await symlink(actual, target);
      commandMock.results.set("info --cask --installed --json=v2", {
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
              artifacts: [{ app: ["Original.app"], target }]
            }
          ]
        })
      });
      const { HomebrewInventoryClient } = await import("../src/main/homebrewInventoryClient");
      const result = await new HomebrewInventoryClient().fetchInventory();
      expect(
        result.items.find((item) => item.kind === "cask")?.caskMetadata?.installedAppPaths
      ).toEqual([await realpath(actual)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
