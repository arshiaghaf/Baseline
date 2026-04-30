import { describe, expect, it } from "vitest";
import { mergeHomebrewRecentlyUpdatedRecords } from "../src/main/updateStore";
import type { HomebrewManagedItem } from "../src/shared/domain";
import { version } from "../src/shared/version";

function homebrewItem(
  patch: Partial<HomebrewManagedItem> & Pick<HomebrewManagedItem, "id" | "token" | "name">
): HomebrewManagedItem {
  return {
    kind: "formula",
    installedVersion: version("1.0.0"),
    isOutdated: false,
    ...patch
  };
}

describe("update store helpers", () => {
  it("records Homebrew formulas and casks whose installed version advanced", () => {
    const now = "2026-04-30T12:00:00.000Z";
    const records = mergeHomebrewRecentlyUpdatedRecords(
      [],
      [
        homebrewItem({ id: "formula:ripgrep", token: "ripgrep", name: "ripgrep" }),
        homebrewItem({
          id: "cask:visual-studio-code",
          token: "visual-studio-code",
          name: "Visual Studio Code",
          kind: "cask",
          installedVersion: version("1.99.0")
        })
      ],
      [
        homebrewItem({
          id: "formula:ripgrep",
          token: "ripgrep",
          name: "ripgrep",
          installedVersion: version("1.1.0")
        }),
        homebrewItem({
          id: "cask:visual-studio-code",
          token: "visual-studio-code",
          name: "Visual Studio Code",
          kind: "cask",
          installedVersion: version("1.100.0")
        })
      ],
      now
    );

    expect(records).toEqual([
      expect.objectContaining({
        itemID: "cask:visual-studio-code",
        kind: "cask",
        fromVersion: version("1.99.0"),
        toVersion: version("1.100.0")
      }),
      expect.objectContaining({
        itemID: "formula:ripgrep",
        kind: "formula",
        fromVersion: version("1.0.0"),
        toVersion: version("1.1.0")
      })
    ]);
  });

  it("keeps the newest Homebrew recent record per item", () => {
    const records = mergeHomebrewRecentlyUpdatedRecords(
      [
        {
          id: "formula:ripgrep",
          itemID: "formula:ripgrep",
          token: "ripgrep",
          kind: "formula",
          displayName: "ripgrep",
          fromVersion: version("1.0.0"),
          toVersion: version("1.1.0"),
          updatedAt: new Date().toISOString()
        }
      ],
      [homebrewItem({ id: "formula:ripgrep", token: "ripgrep", name: "ripgrep" })],
      [
        homebrewItem({
          id: "formula:ripgrep",
          token: "ripgrep",
          name: "ripgrep",
          installedVersion: version("1.2.0")
        })
      ],
      new Date().toISOString()
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.toVersion).toEqual(version("1.2.0"));
  });
});
