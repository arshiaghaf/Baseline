import { describe, expect, it } from "vitest";
import { homebrewItemHasAppRepresentation } from "../src/shared/homebrewAppLinking";
import type { AppRecord, HomebrewManagedItem, UpdateRecord } from "../src/shared/domain";
import { version } from "../src/shared/version";

const app: AppRecord = {
  id: "app:code",
  bundlePath: "/Applications/Visual Studio Code.app",
  displayName: "Code",
  bundleIdentifier: "com.microsoft.VSCode",
  localVersion: version("1.0.0"),
  sourceHint: "homebrew"
};

const codeCask: HomebrewManagedItem = {
  id: "cask:visual-studio-code",
  token: "visual-studio-code",
  name: "Visual Studio Code",
  kind: "cask",
  installedVersion: version("1.0.0"),
  latestVersion: version("2.0.0"),
  isOutdated: true
};

describe("Homebrew app linking", () => {
  it("matches casks to app updates by Homebrew token", () => {
    const update: UpdateRecord = {
      id: app.id,
      appID: app.id,
      source: "homebrew",
      supportLevel: "supported",
      localVersion: version("1.0.0"),
      remoteVersion: version("2.0.0"),
      homebrewToken: "visual-studio-code",
      checkedAt: "2026-04-30T12:00:00.000Z"
    };

    expect(
      homebrewItemHasAppRepresentation(codeCask, [app], new Map([[app.id, update]]))
    ).toBe(true);
  });

  it("matches casks to ignored apps by app bundle name", () => {
    expect(homebrewItemHasAppRepresentation(codeCask, [app], new Map())).toBe(true);
  });

  it("does not treat formulae as app-backed items", () => {
    const formula: HomebrewManagedItem = {
      id: "formula:visual-studio-code",
      token: "visual-studio-code",
      name: "visual-studio-code",
      kind: "formula",
      installedVersion: version("1.0.0"),
      latestVersion: version("2.0.0"),
      isOutdated: true
    };

    expect(homebrewItemHasAppRepresentation(formula, [app], new Map())).toBe(false);
  });
});
