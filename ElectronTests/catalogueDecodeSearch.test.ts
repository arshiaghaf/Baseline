// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { HomebrewCaskClient } from "../src/main/homebrewCaskClient";
import { HomebrewFormulaClient } from "../src/main/homebrewFormulaClient";
import { HomebrewInventoryClient } from "../src/main/homebrewInventoryClient";
import { runBrewCommand } from "../src/main/commandRunner";
import { mergeCatalogueSearchResults } from "../src/main/catalogueSearch";

vi.mock("../src/main/commandRunner", () => ({ runBrewCommand: vi.fn() }));

const data = (value: unknown) => Buffer.from(JSON.stringify(value));
afterEach(() => vi.restoreAllMocks());

describe("bounded catalogue decoding diagnostics", () => {
  it.each([HomebrewCaskClient, HomebrewFormulaClient])(
    "retains valid entries while counting malformed entries and optional schema drift",
    (Client) => {
      const client = new Client();
      const index = client.parseIndex(
        data([
          null,
          "sensitive rejected payload",
          { token: "bad token", name: "bad name" },
          { token: "good", name: "good", version: "1", versions: { stable: "1" }, artifacts: [] },
          {
            token: "changed",
            name: "changed",
            version: 123,
            versions: { stable: 123 },
            desc: false,
            homepage: 99,
            artifacts: "changed schema"
          }
        ])
      );
      expect(Object.keys(index.byToken)).toEqual(["good", "changed"]);
      expect(client.cacheStatus.decode).toEqual({
        totalEntries: 5,
        skippedEntries: 3,
        schemaWarnings: 1
      });
      expect(JSON.stringify(client.cacheStatus)).not.toContain("sensitive");
    }
  );

  it.each([HomebrewCaskClient, HomebrewFormulaClient])(
    "bounds entry depth, string sizes, fanout, and total catalogue entry count",
    async (Client) => {
      const client = new Client();
      let nested: unknown = "sensitive leaf";
      for (let depth = 0; depth < 40; depth++) nested = { child: nested };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          data([
            { name: "good", token: "good" },
            { name: "deep", token: "deep", nested },
            { name: "wide", token: "wide", nested: Array.from({ length: 2049 }, () => "x") },
            { name: "huge", token: "huge", desc: "x".repeat(256 * 1024 + 1) }
          ])
        )
      );
      const index = await client.fetchIndex();
      expect(Object.keys(index.byToken)).toEqual(["good"]);
      expect(client.cacheStatus.decode).toEqual({
        totalEntries: 4,
        skippedEntries: 3,
        schemaWarnings: 0
      });
      expect(() => client.parseIndex(data(Array.from({ length: 100001 }, () => null)))).toThrow(
        "schema"
      );
    }
  );

  it.each([HomebrewCaskClient, HomebrewFormulaClient])(
    "does not cache an entirely malformed replacement",
    async (Client) => {
      const client = new Client();
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(data([{ name: "good", token: "good" }])));
      const good = await client.fetchIndex();
      network.mockResolvedValueOnce(
        new Response(data([null, { bad: "sensitive" }]), { headers: { etag: '"bad"' } })
      );
      expect(await client.fetchIndex({ force: true })).toBe(good);
      expect(client.cacheStatus.stale).toBe(true);
      expect(client.cacheStatus.decode).toEqual({
        totalEntries: 1,
        skippedEntries: 0,
        schemaWarnings: 0
      });
    }
  );

  it("handles object-prototype keys as ordinary catalogue metadata", () => {
    const formula = new HomebrewFormulaClient().parseIndex(data([{ name: "constructor" }]));
    expect(Object.keys(formula.byToken)).toEqual(["constructor"]);
    const cask = new HomebrewCaskClient().parseIndex(
      data([
        {
          token: "constructor",
          bundle_id: "constructor",
          artifacts: [{ app: ["Constructor.app"] }]
        }
      ])
    );
    expect(cask.byBundleIdentifier.constructor).toMatchObject({ token: "constructor" });
    expect(cask.byAppBundleName["constructor.app"]?.[0]?.token).toBe("constructor");
  });
});

describe("catalogue relevance across kinds", () => {
  it("places exact formulae ahead of twelve cask prefix matches", () => {
    const casks = new HomebrewCaskClient();
    const formulae = new HomebrewFormulaClient();
    const caskIndex = casks.parseIndex(
      data(Array.from({ length: 20 }, (_, index) => ({ token: `git-app-${index}`, version: "9" })))
    );
    const formulaIndex = formulae.parseIndex(
      data([
        { name: "git", versions: { stable: "2" } },
        { name: "unrelated", desc: "A git helper" }
      ])
    );
    const results = mergeCatalogueSearchResults(
      "git",
      casks.searchCasks("git", caskIndex, new Set()),
      formulae.searchFormulae("git", formulaIndex, new Set())
    );
    expect(results[0]).toMatchObject({ kind: "formula", token: "git" });
    expect(results.at(-1)?.token).toBe("unrelated");
    expect(results).toHaveLength(14);
  });

  it("uses exact normalized app names and excludes installed identities per kind", () => {
    const casks = new HomebrewCaskClient();
    const formulae = new HomebrewFormulaClient();
    const caskIndex = casks.parseIndex(
      data([
        { token: "desktop-tools", artifacts: [{ app: ["Git.app"] }] },
        { token: "git", artifacts: [{ app: ["Other.app"] }] }
      ])
    );
    const formulaIndex = formulae.parseIndex(data([{ name: "git" }, { name: "git-helper" }]));
    const results = mergeCatalogueSearchResults(
      "G-i T",
      casks.searchCasks("G-i T", caskIndex, new Set(["git"])),
      formulae.searchFormulae("G-i T", formulaIndex, new Set())
    );
    expect(results.map(({ token }) => token)).toEqual(["desktop-tools", "git", "git-helper"]);
    expect(results[1]?.kind).toBe("formula");
  });

  it("preserves description relevance without exposing search scores in shared results", () => {
    const formulae = new HomebrewFormulaClient();
    const index = formulae.parseIndex(data([{ name: "rg", desc: "Find text rapidly" }]));
    const results = formulae.searchFormulae("text", index, new Set());
    expect(mergeCatalogueSearchResults("text", [], results)[0]?.token).toBe("rg");
    expect(Object.keys(results[0]!)).not.toContain("rank");
    expect(mergeCatalogueSearchResults("!!!", [], results)).toEqual([]);
    expect(mergeCatalogueSearchResults("text", [], [...results, ...results], 1)).toHaveLength(1);
  });

  it("normalizes each index once and releases the old terms with its index", () => {
    const client = new HomebrewFormulaClient();
    const index = client.parseIndex(data([{ name: "ripgrep", desc: "Search text" }]));
    const entry = index.byToken.ripgrep!;
    const description = vi.spyOn(entry, "description", "get").mockReturnValue("Search text");
    expect(client.searchFormulae("search", index, new Set())).toHaveLength(1);
    expect(client.searchFormulae("text", index, new Set())).toHaveLength(1);
    expect(description).toHaveBeenCalledTimes(1);
  });
});

it("keeps healthy installed formula/cask evidence with large or deep optional cask metadata", async () => {
  let nested: unknown = "optional";
  for (let depth = 0; depth < 100; depth++) nested = { child: nested };
  const result = (output: unknown) => ({
    success: true,
    status: 0,
    output: typeof output === "string" ? output : JSON.stringify(output)
  });
  const fixtures: Record<string, ReturnType<typeof result>> = {
    "list --formula --versions": result("tool 1.0\n"),
    "list --cask --versions": result("desktop 1.0\n"),
    "outdated --formula --json=v2": result({
      formulae: [{ name: "tool", current_version: "2.0" }]
    }),
    "outdated --cask --greedy --json=v2": result({
      casks: [{ token: "desktop", current_version: "2.0" }]
    }),
    "info --formula --installed --json=v2": result({
      formulae: [
        { name: "tool", full_name: "tool", tap: "homebrew/core", installed: [{ version: "1.0" }] }
      ]
    }),
    "info --cask --installed --json=v2": result({
      casks: [
        {
          token: "desktop",
          full_token: "desktop",
          tap: "homebrew/cask",
          version: "2.0",
          installed: "1.0",
          caveats: "x".repeat(256 * 1024 + 1),
          optional: nested,
          artifacts: [{ app: ["Desktop.app"] }]
        }
      ]
    })
  };
  vi.mocked(runBrewCommand).mockImplementation(async (args) => {
    const fixture = fixtures[args.join(" ")];
    if (!fixture) throw new Error("Unexpected fake command");
    return fixture;
  });
  const inventory = await new HomebrewInventoryClient().fetchInventory();
  expect(inventory.items.map(({ token, isOutdated }) => ({ token, isOutdated }))).toEqual([
    { token: "desktop", isOutdated: true },
    { token: "tool", isOutdated: true }
  ]);
  expect(inventory.outdatedDetectionSucceededByKind).toEqual({ formula: true, cask: true });
  expect(inventory.warning).toBeUndefined();
});
