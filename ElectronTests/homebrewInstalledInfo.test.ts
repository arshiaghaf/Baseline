// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import fixture from "./Fixtures/homebrew_installed_inventory.json";
import { HomebrewInventoryClient } from "../src/main/homebrewInventoryClient";
import type { CommandResult } from "../src/main/commandRunner";
import { installedInfoSection } from "../src/main/homebrewInstalledInfo";
import { homebrewCommandToken } from "../src/shared/homebrewIdentity";
import { HomebrewCaskClient } from "../src/main/homebrewCaskClient";

function success(value: unknown): CommandResult {
  const stdout = typeof value === "string" ? value : JSON.stringify(value);
  return { success: true, status: 0, output: stdout, stdout, stderr: "" };
}

const failed: CommandResult = { success: false, status: 1, output: "" };

function transport(overrides: Record<string, CommandResult> = {}) {
  const calls: string[] = [];
  const responses: Record<string, CommandResult> = {
    update: success(""),
    "info --installed --json=v2": success(fixture.info),
    "list --formula --versions": success(fixture.formulaVersions),
    "list --cask --versions": success(fixture.caskVersions),
    "info --formula --installed --json=v2": success({ formulae: fixture.info.formulae }),
    "info --cask --installed --json=v2": success({ casks: fixture.info.casks }),
    "outdated --formula --json=v2": success(fixture.formulaOutdated),
    "outdated --cask --greedy --json=v2": success(fixture.caskOutdated),
    ...overrides
  };
  return {
    calls,
    run: async (args: string[]) => {
      const command = args.join(" ");
      calls.push(command);
      if (!responses[command]) throw new Error(`Unexpected command ${command}`);
      return responses[command]!;
    }
  };
}

describe("combined installed-info transport", () => {
  it("contains a rejected installed-cask parser entry without losing formula inventory", async () => {
    const parser = vi
      .spyOn(HomebrewCaskClient.prototype, "parseIndex")
      .mockImplementationOnce(() => {
        throw new Error("Invalid optional catalogue metadata");
      });
    try {
      const result = await new HomebrewInventoryClient(transport().run).fetchInventory();
      expect(result.inventoryReadSucceededByKind).toEqual({ formula: true, cask: true });
      expect(result.items).toHaveLength(7);
      const formula = result.items.find((item) => item.token === "old-tool")!;
      expect(homebrewCommandToken(formula)).toBe("example/tools/new-tool");
      expect(formula.isOutdated).toBe(true);
      const rejected = result.items.find((item) => item.token === "auto-tool")!;
      expect(rejected.isOutdated).toBe(false);
      expect(homebrewCommandToken(rejected)).toBeUndefined();
      expect(result.installedMetadataByItemID?.[rejected.id]).toBeUndefined();
      expect(result.warning).toContain("Installed cask identity could not be verified");
    } finally {
      parser.mockRestore();
    }
  });

  it.each([
    "update",
    "info --installed --json=v2",
    "list --formula --versions",
    "outdated --formula --json=v2",
    "outdated --cask --greedy --json=v2",
    "info --formula --installed --json=v2",
    "info --cask --installed --json=v2",
    "list --cask --versions"
  ])("stops after unconfirmed cleanup from %s without further fallback", async (command) => {
    const cleanup: CommandResult & { failure: { kind: string } } = {
      ...failed,
      failure: { kind: "cleanup" }
    };
    const isFallback = command.includes("info --formula") || command.includes("info --cask");
    const source = transport({
      ...(isFallback ? { "info --installed --json=v2": failed } : {}),
      [command]: cleanup
    });
    const result = await new HomebrewInventoryClient(source.run).fetchInventory({
      updateMetadata: command === "update"
    });
    expect(result).toMatchObject({
      cleanupUnconfirmed: true,
      items: [],
      inventoryReadSucceededByKind: { formula: false, cask: false },
      outdatedDetectionSucceededByKind: { formula: false, cask: false }
    });
    expect(result.installedMetadataByItemID).toBeUndefined();
    expect(source.calls).toHaveLength(command === "update" ? 1 : isFallback ? 7 : 5);
  });

  it("matches the legacy per-kind transport for revisions, HEAD, pins, renames, taps and greedy casks", async () => {
    const combined = transport();
    const fallback = transport({ "info --installed --json=v2": failed });
    const result = await new HomebrewInventoryClient(combined.run).fetchInventory();
    const legacy = await new HomebrewInventoryClient(fallback.run).fetchInventory();
    expect(result).toEqual(legacy);
    expect(combined.calls).toEqual([
      "info --installed --json=v2",
      "list --formula --versions",
      "list --cask --versions",
      "outdated --formula --json=v2",
      "outdated --cask --greedy --json=v2"
    ]);
    expect(fallback.calls).toHaveLength(7);
    const old = result.items.find((item) => item.token === "old-tool")!;
    expect(old).toMatchObject({
      id: "formula:old-tool",
      installedVersion: { raw: "1.0_2" },
      latestVersion: { raw: "1.1_4" },
      pinned: true,
      isOutdated: true
    });
    expect(homebrewCommandToken(old)).toBe("example/tools/new-tool");
    expect(result.items.find((item) => item.token === "head-tool")).toMatchObject({
      installedVersion: { raw: "HEAD-aabbcc_1" },
      latestVersion: { raw: "HEAD-ddeeff_2" }
    });
    expect(result.items.find((item) => item.token === "shared")).toMatchObject({
      fullToken: "other/tools/shared",
      latestVersion: { raw: "6.0" }
    });
    for (const token of ["auto-tool", "latest-tool", "renamed-tool"]) {
      expect(result.items.find((item) => item.token === token)?.isOutdated).toBe(true);
    }
    expect(result.items.find((item) => item.token === "auto-tool")).toMatchObject({
      installedVersion: { raw: "1.2" },
      latestVersion: { raw: "1.3" },
      pinned: true
    });
    expect(result.warning).toBeUndefined();
  });

  it("accepts an explicitly empty inventory without fallback", async () => {
    const source = transport({
      "info --installed --json=v2": success({ formulae: [], casks: [] }),
      "list --formula --versions": success(""),
      "list --cask --versions": success(""),
      "outdated --formula --json=v2": success({ formulae: [] }),
      "outdated --cask --greedy --json=v2": success({ casks: [] })
    });
    const result = await new HomebrewInventoryClient(source.run).fetchInventory();
    expect(result.items).toEqual([]);
    expect(result.inventoryReadSucceededByKind).toEqual({ formula: true, cask: true });
    expect(source.calls).toHaveLength(5);
  });

  it.each(["formula", "cask"] as const)("recovers only a malformed %s section", async (kind) => {
    const info = { ...fixture.info, [kind === "formula" ? "formulae" : "casks"]: null };
    const source = transport({ "info --installed --json=v2": success(info) });
    const result = await new HomebrewInventoryClient(source.run).fetchInventory();
    expect(result).toEqual(await new HomebrewInventoryClient(transport().run).fetchInventory());
    expect(source.calls).toContain(`info --${kind} --installed --json=v2`);
    expect(source.calls).not.toContain(
      `info --${kind === "formula" ? "cask" : "formula"} --installed --json=v2`
    );
    expect(source.calls).toHaveLength(6);
  });

  it.each(["formula", "cask"] as const)(
    "retains independent %s inventory failure status after fallback",
    async (kind) => {
      const source = transport({
        "info --installed --json=v2": failed,
        [`list --${kind} --versions`]: failed,
        [`info --${kind} --installed --json=v2`]: failed
      });
      const result = await new HomebrewInventoryClient(source.run).fetchInventory();
      expect(result.inventoryReadSucceededByKind?.[kind]).toBe(false);
      expect(result.outdatedDetectionSucceededByKind[kind]).toBe(false);
      const other = kind === "formula" ? "cask" : "formula";
      expect(result.inventoryReadSucceededByKind?.[other]).toBe(true);
      expect(result.outdatedDetectionSucceededByKind[other]).toBe(true);
      expect(result.items.every((item) => item.kind === other)).toBe(true);
      expect(
        Object.values(result.installedMetadataByItemID!).every((entry) => entry.kind === other)
      ).toBe(true);
    }
  );

  it("never accepts a nonzero combined command's apparently valid partial output", async () => {
    const source = transport({
      "info --installed --json=v2": { ...success(fixture.info), success: false, status: 1 },
      "info --formula --installed --json=v2": failed
    });
    const result = await new HomebrewInventoryClient(source.run).fetchInventory();
    expect(
      result.items
        .filter((item) => item.kind === "formula")
        .every((item) => !homebrewCommandToken(item))
    ).toBe(true);
    expect(
      result.items
        .filter((item) => item.kind === "cask")
        .every((item) => homebrewCommandToken(item))
    ).toBe(true);
    expect(result.warning).toContain("formula identity could not be verified");
  });

  it("uses stdout despite stderr warnings and independently flags failed metadata/outdated checks", async () => {
    const source = transport({
      "info --installed --json=v2": {
        ...success(fixture.info),
        output: "Warning: not JSON",
        stderr: "Warning"
      },
      "outdated --cask --greedy --json=v2": failed
    });
    const result = await new HomebrewInventoryClient(source.run).fetchInventory();
    expect(result.inventoryReadSucceededByKind).toEqual({ formula: true, cask: true });
    expect(result.outdatedDetectionSucceededByKind).toEqual({ formula: true, cask: false });
    expect(
      result.items.filter((item) => item.kind === "cask").every((item) => !item.isOutdated)
    ).toBe(true);
    expect(source.calls).toHaveLength(5);
    const updated = transport({ update: failed });
    const updateResult = await new HomebrewInventoryClient(updated.run).fetchInventory({
      updateMetadata: true
    });
    expect(updated.calls[0]).toBe("update");
    expect(updateResult.outdatedDetectionSucceededByKind).toEqual({ formula: false, cask: false });
    expect(updateResult.warning).toContain("brew update");
  });

  it.each([
    "invalid",
    "null",
    "[]",
    "{}",
    '{"casks":{}}',
    JSON.stringify({ casks: [{ token: "tool", installed: null }] }),
    JSON.stringify({ casks: [{ token: "tool", installed: ["1"] }] }),
    JSON.stringify({ casks: [{ token: "tool", installed: "1\nother 2" }] }),
    JSON.stringify({
      casks: [
        { token: "tool", installed: "1" },
        { token: "tool", installed: "2" }
      ]
    }),
    JSON.stringify({ casks: [{ token: "--tool", installed: "1" }] })
  ])("falls back instead of treating malformed/ambiguous cask JSON as empty: %s", async (raw) => {
    const source = transport({ "info --installed --json=v2": success(raw) });
    const result = await new HomebrewInventoryClient(source.run).fetchInventory();
    expect(source.calls).toContain("list --cask --versions");
    expect(result.items).toHaveLength(7);
  });

  it("does not silently skip malformed installed formula records", () => {
    expect(
      installedInfoSection(success({ formulae: [{ name: "tool", installed: [] }] }), "formula")
    ).toBeUndefined();
    expect(
      installedInfoSection(
        success({ formulae: [{ name: "tool", installed: [{ version: 1 }] }] }),
        "formula"
      )
    ).toBeUndefined();
  });

  it("retains typed optional metadata and only proves receipt edges by full installed identity", async () => {
    const result = await new HomebrewInventoryClient(transport().run).fetchInventory();
    const metadata = result.installedMetadataByItemID!;
    expect(metadata["formula:old-tool"]).toMatchObject({
      identity: "example/tools/new-tool",
      caveats: "Read the manual before enabling this tool.",
      deprecated: true,
      deprecationReason: "unmaintained",
      deprecationDate: "2026-01-01",
      disabled: false,
      revision: 4,
      versionScheme: 1,
      installedOnRequest: true,
      installedAsDependency: true,
      installedReceipts: [
        { version: "1.0_1", installedOnRequest: false },
        { version: "1.0_2", installedOnRequest: true, time: 1700000000 }
      ]
    });
    expect(metadata["formula:old-tool"]?.dependencies).toContainEqual({
      kind: "formula",
      token: "libshared",
      source: "receipt",
      scope: "runtime",
      version: "2.0_3",
      revision: 3,
      declaredDirectly: true,
      installedItemID: "formula:libshared"
    });
    expect(metadata["formula:libshared"]).toMatchObject({
      disabled: true,
      disableReason: "unsupported",
      installedDependents: ["formula:old-tool"]
    });
    expect(metadata["formula:shared"]?.dependencies[0]?.installedItemID).toBeUndefined();
    expect(metadata["formula:head-tool"]?.headVersion).toBe("HEAD");
    expect(metadata["cask:auto-tool"]).toMatchObject({
      autoUpdates: true,
      installedReceipts: [{ version: "1.2,100" }],
      dependencies: [
        { kind: "formula", token: "libshared", source: "declaration" },
        { kind: "cask", token: "latest-tool", source: "declaration" }
      ]
    });
    expect(metadata["cask:auto-tool"]?.installedOnRequest).toBeUndefined();
  });

  it("ignores optional metadata schema drift without making unverified identities into graph nodes", async () => {
    const info: any = structuredClone(fixture.info);
    info.formulae[0].caveats = { unknown: "schema" };
    info.formulae[0].deprecated = "yes";
    info.formulae[0].dependencies = { unexpected: true };
    info.formulae[0].installed[1].runtime_dependencies.push({ full_name: "--bad" });
    info.formulae[0].installed[1].installed_on_request = undefined;
    info.formulae[2].tap = "wrong/tap";
    info.casks[0].tap = "wrong/tap";
    const source = transport({ "info --installed --json=v2": success(info) });
    const result = await new HomebrewInventoryClient(source.run).fetchInventory();
    expect(result.installedMetadataByItemID?.["formula:old-tool"]?.caveats).toBeUndefined();
    expect(result.installedMetadataByItemID?.["formula:old-tool"]?.deprecated).toBeUndefined();
    expect(
      result.installedMetadataByItemID?.["formula:old-tool"]?.installedOnRequest
    ).toBeUndefined();
    expect(result.installedMetadataByItemID?.["formula:shared"]).toBeUndefined();
    expect(result.installedMetadataByItemID?.["cask:auto-tool"]).toBeUndefined();
    expect(
      result.installedMetadataByItemID?.["formula:old-tool"]?.dependencies.some(
        (dep) => dep.token === "--bad"
      )
    ).toBe(false);
    expect(result.warning).toContain("identity could not be verified");
  });
});
