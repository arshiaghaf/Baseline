// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { homebrewItemHasAppRepresentation } from "../src/shared/homebrewAppLinking";
import type { AppRecord, HomebrewManagedItem } from "../src/shared/domain";
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
  it("does not use token-only Homebrew updates as app-backed proof", () => {
    expect(homebrewItemHasAppRepresentation(codeCask, [app])).toBe(false);
  });

  it("matches casks to ignored apps by explicit app link", () => {
    expect(homebrewItemHasAppRepresentation({ ...codeCask, appID: app.id }, [app])).toBe(true);
  });

  it("does not use app bundle names alone as app-backed proof", () => {
    expect(homebrewItemHasAppRepresentation(codeCask, [app])).toBe(false);
  });

  it("still keeps explicitly linked Sparkle-origin casks represented by app rows", () => {
    const sparkleApp = {
      ...app,
      sourceHint: "sparkle" as const
    };

    expect(homebrewItemHasAppRepresentation(codeCask, [sparkleApp])).toBe(false);
    expect(
      homebrewItemHasAppRepresentation({ ...codeCask, appID: sparkleApp.id }, [sparkleApp])
    ).toBe(true);
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

    expect(homebrewItemHasAppRepresentation(formula, [app])).toBe(false);
  });
});
