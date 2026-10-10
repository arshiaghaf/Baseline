// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { HomebrewCaskClient } from "../src/main/homebrewCaskClient";
import {
  caskIndexForInstalledItems,
  homebrewCommandToken,
  homebrewItemIdentity,
  installedCaskEntry
} from "../src/shared/homebrewIdentity";
import type { HomebrewManagedItem } from "../src/shared/domain";
import { version } from "../src/shared/version";

const client = new HomebrewCaskClient();
const catalogue = client.parseIndex(
  Buffer.from(
    JSON.stringify([
      {
        token: "shared-name",
        full_token: "shared-name",
        tap: "homebrew/cask",
        version: "3.0",
        artifacts: [{ pkg: ["Onboarding.pkg"] }]
      }
    ])
  )
);
const custom = client.parseIndex(
  Buffer.from(
    JSON.stringify([
      {
        token: "shared-name",
        full_token: "example/tools/shared-name",
        tap: "example/tools",
        homepage: "https://example.com/utility",
        version: "0.6.3",
        artifacts: [{ app: ["Update Utility.app"] }]
      }
    ])
  )
).byToken["shared-name"]!;
const installed: HomebrewManagedItem = {
  id: "cask:shared-name",
  token: "shared-name",
  name: "shared-name",
  kind: "cask",
  installedVersion: version("0.6.2"),
  fullToken: "example/tools/shared-name",
  tap: "example/tools",
  caskMetadata: custom,
  isOutdated: true
};

describe("installed cask identity", () => {
  it("uses authoritative third-party metadata instead of a colliding public package", () => {
    expect(installedCaskEntry(installed, catalogue)).toBe(custom);
    const index = caskIndexForInstalledItems(catalogue, [installed]);
    expect(index.byToken["shared-name"]?.version.raw).toBe("0.6.3");
    expect(
      client.lookupUpdate(undefined, "Update Utility.app", version("0.6.2"), index)?.remoteVersion
        .raw
    ).toBe("0.6.3");
    expect(
      client.lookupUpdate(undefined, "Update Utility.app", version("0.6.2"), index)?.homepageURL
    ).toBe("https://example.com/utility");
    expect(homebrewCommandToken(installed)).toBe("example/tools/shared-name");
  });
  it("does not borrow metadata when custom or legacy identity cannot be verified", () => {
    for (const item of [
      { ...installed, caskMetadata: undefined },
      { ...installed, fullToken: undefined, tap: undefined, caskMetadata: undefined }
    ]) {
      expect(installedCaskEntry(item, catalogue)).toBeUndefined();
      expect(caskIndexForInstalledItems(catalogue, [item]).byToken["shared-name"]).toBeUndefined();
    }
  });
  it.each(["shared-name", "homebrew/cask/shared-name"])(
    "canonicalizes equivalent verified public full token %s",
    (fullToken) => {
      const item = { ...installed, fullToken, tap: "homebrew/cask", caskMetadata: undefined };
      expect(installedCaskEntry(item, catalogue)).toBe(catalogue.byToken["shared-name"]);
      expect(caskIndexForInstalledItems(catalogue, [item]).byToken["shared-name"]).toBe(
        catalogue.byToken["shared-name"]
      );
      expect(homebrewCommandToken(item)).toBe(fullToken);
      expect(homebrewItemIdentity(item)).toBe("homebrew/cask/shared-name");
    }
  );

  it("preserves verified public casks and rejects mismatched or unsafe full tokens", () => {
    const item = {
      ...installed,
      fullToken: "shared-name",
      tap: "homebrew/cask",
      caskMetadata: undefined
    };
    expect(installedCaskEntry(item, catalogue)).toBe(catalogue.byToken["shared-name"]);
    expect(homebrewCommandToken(item)).toBe("shared-name");
    for (const fullToken of [
      "other/tools/shared-name",
      "example/tools/other",
      "example/tools/shared-name;bad"
    ]) {
      expect(homebrewCommandToken({ ...installed, fullToken })).toBeUndefined();
    }
  });
});
