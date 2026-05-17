// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppStoreLookupClient } from "../src/main/appStoreLookupClient";
import { HomebrewCaskClient } from "../src/main/homebrewCaskClient";
import { HomebrewFormulaClient } from "../src/main/homebrewFormulaClient";
import { HomebrewInventoryParser } from "../src/main/homebrewInventoryClient";
import { SparkleAppcastClient } from "../src/main/sparkleAppcastClient";
import { version } from "../src/shared/version";

const fixtures = path.join(process.cwd(), "ElectronTests", "Fixtures");

describe("ported clients", () => {
  it("parses App Store lookup fixtures", () => {
    const data = readFileSync(path.join(fixtures, "app_store_lookup.json"));
    const result = new AppStoreLookupClient().parseLookupResponse(data, version("2.0.0"));
    expect(result?.remoteVersion.raw).toBe("2.3.1");
    expect(result?.appStoreItemID).toBe(123456789);
  });

  it("parses Sparkle appcast fixtures", () => {
    const data = readFileSync(path.join(fixtures, "sparkle_appcast.xml"));
    const result = new SparkleAppcastClient().parseAppcast(data, version("1.0.0"));
    expect(result?.remoteVersion.raw).toBe("2.0.0");
    expect(result?.updateURL).toBe("https://example.com/download/2.0.0.zip");
  });

  it("parses Homebrew cask schema drift fixtures", () => {
    const data = readFileSync(path.join(fixtures, "homebrew_cask_drift.json"));
    const index = new HomebrewCaskClient().parseIndex(data);
    expect(index.byToken["example-app"]?.token).toBe("example-app");
    expect(index.byBundleIdentifier["com.example.app"]?.token).toBe("example-app");
    expect(index.byAppBundleName["example.app"]?.[0]?.token).toBe("example-app");
  });

  it("classifies Homebrew casks by presentation evidence", () => {
    const index = new HomebrewCaskClient().parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "graphical-tool",
            version: "1.0.0",
            artifacts: [{ app: ["Graphical Tool.app"] }]
          },
          {
            token: "command-tool",
            version: "1.0.0",
            artifacts: [{ binary: ["command-tool"] }]
          },
          {
            token: "installer-tool",
            version: "1.0.0",
            artifacts: [{ pkg: ["InstallerTool.pkg"] }]
          },
          {
            token: "renamed-installer-tool",
            version: "1.0.0",
            artifacts: [{ pkg: [{ file: "InstallerTool.pkg", target: "RenamedInstaller.pkg" }] }]
          },
          {
            token: "plain-cask",
            version: "1.0.0",
            artifacts: [{ uninstall: [{ quit: "com.example.plain" }] }]
          }
        ])
      )
    );

    expect(index.byToken["graphical-tool"]?.presentation).toBe("app");
    expect(index.byToken["command-tool"]?.presentation).toBe("cli");
    expect(index.byToken["installer-tool"]?.presentation).toBe("package");
    expect(index.byToken["renamed-installer-tool"]?.presentation).toBe("package");
    expect(index.byToken["plain-cask"]?.presentation).toBe("cask");
    expect(new HomebrewCaskClient().searchCasks("command", index, new Set()).at(0)).toMatchObject({
      token: "command-tool",
      presentation: "cli"
    });
  });

  it("matches package-backed casks by app name without indexing inferred quit IDs", () => {
    const client = new HomebrewCaskClient();
    const index = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "pkg-backed-app",
            version: "1.2.0",
            artifacts: [
              {
                uninstall: [
                  {
                    quit: "com.example.pkgbacked",
                    login_item: "Package Backed"
                  }
                ]
              },
              { pkg: ["PackageBacked.pkg"] }
            ]
          }
        ])
      )
    );

    expect(index.byBundleIdentifier["com.example.pkgbacked"]).toBeUndefined();
    expect(index.byAppBundleName["package backed.app"]?.[0]?.token).toBe("pkg-backed-app");
    expect(
      client.lookupUpdate("com.example.pkgbacked", "Package Backed.app", version("1.2.1"), index)
    ).toBeUndefined();
    expect(
      client.lookupUpdate("com.example.pkgbacked", "Package Backed.app", version("1.0.0"), index)
        ?.token
    ).toBe("pkg-backed-app");
    expect(
      client.lookupUpdate("com.example.pkgbacked", "Helper.app", version("1.0.0"), index)
    ).toBeUndefined();
  });

  it("matches package-backed casks without login items by deleted app name", () => {
    const client = new HomebrewCaskClient();
    const index = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "pkg-backed-without-login-item",
            version: "4.0.0",
            artifacts: [
              {
                uninstall: [
                  {
                    quit: "com.example.pkgbacked.no-login",
                    delete: "/Applications/Package Backed No Login.app"
                  }
                ]
              },
              { pkg: ["PackageBackedNoLogin.pkg"] }
            ]
          }
        ])
      )
    );

    expect(index.byBundleIdentifier["com.example.pkgbacked.no-login"]).toBeUndefined();
    expect(index.byAppBundleName["package backed no login.app"]?.[0]?.token).toBe(
      "pkg-backed-without-login-item"
    );
    expect(
      client.lookupUpdate(
        "com.example.pkgbacked.no-login",
        "Package Backed No Login.app",
        version("3.0.0"),
        index
      )?.token
    ).toBe("pkg-backed-without-login-item");
  });

  it("keeps quit-only package-backed casks searchable without authoritative app matching", () => {
    const client = new HomebrewCaskClient();
    const index = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "pkg-backed-quit-only",
            version: "5.0.0",
            artifacts: [
              {
                uninstall: [
                  {
                    quit: "com.example.quitonly"
                  }
                ]
              },
              { pkg: ["QuitOnly.pkg"] }
            ]
          }
        ])
      )
    );

    expect(index.byToken["pkg-backed-quit-only"]?.inferredBundleIdentifiers).toEqual([
      "com.example.quitonly"
    ]);
    expect(index.byBundleIdentifier["com.example.quitonly"]).toBeUndefined();
    expect(client.searchCasks("quit only", index, new Set()).at(0)?.token).toBe(
      "pkg-backed-quit-only"
    );
  });

  it("does not let quit metadata override app artifact matching", () => {
    const client = new HomebrewCaskClient();
    const index = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "app-with-helper",
            version: "2.0.0",
            artifacts: [
              { app: ["App With Helper.app"] },
              {
                uninstall: [
                  {
                    quit: "com.example.helper"
                  }
                ]
              }
            ]
          }
        ])
      )
    );

    expect(index.byBundleIdentifier["com.example.helper"]).toBeUndefined();
    expect(index.byAppBundleName["app with helper.app"]?.[0]?.token).toBe("app-with-helper");
    expect(
      client.lookupUpdate("com.example.main", "App With Helper.app", version("1.0.0"), index)?.token
    ).toBe("app-with-helper");
  });

  it("keeps array-valued bundleIdentifier metadata", () => {
    const client = new HomebrewCaskClient();
    const index = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "schema-drift-app",
            version: "3.0.0",
            bundleIdentifier: ["com.example.schema-drift"]
          }
        ])
      )
    );

    expect(index.byBundleIdentifier["com.example.schema-drift"]?.token).toBe("schema-drift-app");
  });

  it("keeps explicit bundle identifiers when newer casks only infer the same identifier", () => {
    const client = new HomebrewCaskClient();
    const index = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "explicit-owner",
            version: "1.0.0",
            bundleIdentifier: "com.example.shared"
          },
          {
            token: "inferred-owner",
            version: "2.0.0",
            artifacts: [
              {
                uninstall: [
                  {
                    quit: "com.example.shared"
                  }
                ]
              },
              { pkg: ["InferredOwner.pkg"] }
            ]
          }
        ])
      )
    );

    expect(index.byBundleIdentifier["com.example.shared"]?.token).toBe("explicit-owner");
  });

  it("indexes explicit bundle identifiers even when older casks only infer the same identifier", () => {
    const client = new HomebrewCaskClient();
    const index = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "inferred-owner",
            version: "2.0.0",
            artifacts: [
              {
                uninstall: [
                  {
                    quit: "com.example.shared"
                  }
                ]
              },
              { pkg: ["InferredOwner.pkg"] }
            ]
          },
          {
            token: "explicit-owner",
            version: "1.0.0",
            bundleIdentifier: "com.example.shared"
          }
        ])
      )
    );

    expect(index.byBundleIdentifier["com.example.shared"]?.token).toBe("explicit-owner");
  });

  it("does not treat non-app artifact targets as app bundle names", () => {
    const client = new HomebrewCaskClient();
    const index = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "pkg-with-target",
            version: "1.0.0",
            artifacts: [
              {
                binary: [
                  "tool",
                  {
                    target: "tool-helper"
                  }
                ]
              },
              {
                uninstall: [
                  {
                    quit: "com.example.pkg-target"
                  }
                ]
              }
            ]
          }
        ])
      )
    );

    expect(index.byBundleIdentifier["com.example.pkg-target"]).toBeUndefined();
    expect(index.byAppBundleName["tool-helper.app"]).toBeUndefined();
    expect(
      client.lookupUpdate("com.example.pkg-target", "Audio MIDI Setup.app", version("0.9.0"), index)
    ).toBeUndefined();
  });

  it("keeps app-suffixed artifact targets available for app matching", () => {
    const client = new HomebrewCaskClient();
    const index = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "renamed-app-target",
            version: "2.0.0",
            artifacts: [
              {
                artifact: [
                  "Original.app",
                  {
                    target: "Renamed.app"
                  }
                ]
              }
            ]
          }
        ])
      )
    );

    expect(index.byAppBundleName["renamed.app"]?.[0]?.token).toBe("renamed-app-target");
  });

  it("searches formulae", () => {
    const client = new HomebrewFormulaClient();
    const index = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            name: "ripgrep",
            versions: { stable: "14.1.0" },
            homepage: "https://github.com/BurntSushi/ripgrep",
            desc: "Search tool"
          }
        ])
      )
    );
    expect(client.searchFormulae("rip", index, new Set()).at(0)?.token).toBe("ripgrep");
  });

  it("builds Homebrew inventory from installed and outdated output", () => {
    const inventory = new HomebrewInventoryParser().buildInventory(
      "ripgrep 14.0.0\n",
      "notion 4.0.0\n",
      JSON.stringify({ formulae: [{ name: "ripgrep", current_version: "14.1.0" }] }),
      JSON.stringify({ casks: [{ token: "notion", current_version: "4.1.0" }] })
    );
    expect(inventory.find((item) => item.token === "ripgrep")?.isOutdated).toBe(true);
    expect(inventory.find((item) => item.token === "notion")?.latestVersion?.raw).toBe("4.1.0");
  });

  it("flags invalid Homebrew outdated JSON instead of treating everything as current", () => {
    const result = new HomebrewInventoryParser().buildInventoryWithStatus(
      "ripgrep 14.0.0\n",
      "notion 4.0.0\n",
      "not-json",
      JSON.stringify({ casks: [{ token: "notion", current_version: "4.1.0" }] })
    );

    expect(result.outdatedDetectionSucceeded).toBe(false);
    expect(result.outdatedDetectionSucceededByKind).toEqual({ formula: false, cask: true });
    expect(result.items.find((item) => item.token === "notion")?.isOutdated).toBe(true);
    expect(result.items.find((item) => item.token === "ripgrep")?.isOutdated).toBe(false);
  });

  it("uses the highest comparable installed Homebrew version", () => {
    const inventory = new HomebrewInventoryParser().buildInventory(
      "ripgrep 14.0.2 14.1.0 13.9.0\n",
      "cursor 3.2.11,e9ee1339915a927dfb2df4a836dd9c8337e17cc2 3.2.9,older\n",
      "{}",
      "{}"
    );

    expect(inventory.find((item) => item.token === "ripgrep")?.installedVersion.raw).toBe("14.1.0");
    expect(inventory.find((item) => item.token === "cursor")?.installedVersion.raw).toBe("3.2.11");
  });

  it("strips cask build metadata from Homebrew inventory versions", () => {
    const inventory = new HomebrewInventoryParser().buildInventory(
      "",
      "cursor 3.2.11,e9ee1339915a927dfb2df4a836dd9c8337e17cc2\n",
      "{}",
      JSON.stringify({
        casks: [
          {
            token: "cursor",
            current_version: "3.2.16,3e548838cf824b70851dd3ef27d0c6aae371b3f6"
          }
        ]
      })
    );

    const cursor = inventory.find((item) => item.token === "cursor");
    expect(cursor?.installedVersion.raw).toBe("3.2.11");
    expect(cursor?.latestVersion?.raw).toBe("3.2.16");
  });
});
