// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppStoreLookupClient } from "../src/main/appStoreLookupClient";
import { HomebrewCaskClient } from "../src/main/homebrewCaskClient";
import { HomebrewFormulaClient } from "../src/main/homebrewFormulaClient";
import { HomebrewInventoryParser } from "../src/main/homebrewInventoryClient";
import { SelfUpdateClient } from "../src/main/selfUpdateClient";
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

  it("parses iOS App Store records when enabled for installed iOS-on-Mac apps", () => {
    const data = Buffer.from(
      JSON.stringify({
        resultCount: 1,
        results: [
          {
            kind: "software",
            bundleId: "com.example.ios-on-mac",
            trackId: 987654321,
            version: "2.0",
            trackViewUrl: "https://apps.apple.com/app/example/id987654321"
          }
        ]
      })
    );
    const client = new AppStoreLookupClient();

    expect(client.parseLookupResponse(data, version("1.0"))).toBeUndefined();
    expect(
      client.parseLookupResponse(data, version("1.0"), {
        includeIOSAppStoreSoftware: true,
        bundleIdentifier: "com.example.other"
      })
    ).toBeUndefined();

    const result = client.parseLookupResponse(data, version("1.0"), {
      includeIOSAppStoreSoftware: true,
      bundleIdentifier: "com.example.ios-on-mac"
    });

    expect(result?.remoteVersion.raw).toBe("2.0");
    expect(result?.appStoreItemID).toBe(987654321);
  });

  it("uses stable App Store releases as updates over matching local prerelease builds", () => {
    const client = new AppStoreLookupClient();
    const stableRelease = Buffer.from(
      JSON.stringify({
        results: [
          {
            kind: "mac-software",
            trackId: 123,
            version: "1.0.0",
            trackViewUrl: "https://apps.apple.com/app/example/id123"
          }
        ]
      })
    );
    const betaRelease = Buffer.from(
      JSON.stringify({
        results: [
          {
            kind: "mac-software",
            trackId: 123,
            version: "1.0.0-beta.2",
            trackViewUrl: "https://apps.apple.com/app/example/id123"
          }
        ]
      })
    );

    expect(client.parseLookupResponse(stableRelease, version("1.0.0-beta.2"))).toMatchObject({
      remoteVersion: version("1.0.0"),
      appStoreItemID: 123
    });
    expect(client.parseLookupResponse(betaRelease, version("1.0.0"))).toBeUndefined();
  });

  it("rejects iOS App Store records when installed app evidence is not enabled", () => {
    const data = Buffer.from(
      JSON.stringify({
        resultCount: 1,
        results: [
          {
            kind: "software",
            bundleId: "com.example.ios-only",
            trackId: 123,
            version: "2.0"
          }
        ]
      })
    );

    expect(new AppStoreLookupClient().parseLookupResponse(data, version("1.0"))).toBeUndefined();
  });

  it("prefers matching iOS App Store records for installed iOS-on-Mac apps", () => {
    const data = Buffer.from(
      JSON.stringify({
        resultCount: 2,
        results: [
          {
            kind: "mac-software",
            bundleId: "com.example.shared",
            trackId: 111,
            version: "5.0",
            trackViewUrl: "https://apps.apple.com/app/example-mac/id111"
          },
          {
            kind: "software",
            bundleId: "com.example.shared",
            trackId: 222,
            version: "2.0",
            trackViewUrl: "https://apps.apple.com/app/example-ios/id222"
          }
        ]
      })
    );

    const result = new AppStoreLookupClient().parseLookupResponse(data, version("1.0"), {
      includeIOSAppStoreSoftware: true,
      bundleIdentifier: "com.example.shared"
    });

    expect(result?.remoteVersion.raw).toBe("2.0");
    expect(result?.appStoreItemID).toBe(222);
    expect(result?.updateURL).toBe("https://apps.apple.com/app/example-ios/id222");
  });

  it("keeps Mac App Store lookup requests filtered to Mac software by default", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ resultCount: 0, results: [] }), { status: 200 })
      );

    try {
      await new AppStoreLookupClient().lookupOutcome("com.example.mac-app", version("1.0"));

      const requestedURL = new URL(fetchMock.mock.calls[0]?.[0] as string);
      expect(requestedURL.searchParams.get("bundleId")).toBe("com.example.mac-app");
      expect(requestedURL.searchParams.get("entity")).toBe("macSoftware");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("omits the entity filter when iOS App Store software lookup is enabled", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ resultCount: 0, results: [] }), { status: 200 })
      );

    try {
      await new AppStoreLookupClient().lookupOutcome("com.example.ios-on-mac", version("1.0"), {
        includeIOSAppStoreSoftware: true
      });

      const requestedURL = new URL(fetchMock.mock.calls[0]?.[0] as string);
      expect(requestedURL.searchParams.get("bundleId")).toBe("com.example.ios-on-mac");
      expect(requestedURL.searchParams.has("entity")).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("parses Sparkle appcast fixtures", () => {
    const data = readFileSync(path.join(fixtures, "sparkle_appcast.xml"));
    const result = new SparkleAppcastClient().parseAppcast(data, version("1.0.0"));
    expect(result?.remoteVersion.raw).toBe("2.0.0");
    expect(result?.updateURL).toBe("https://example.com/download/2.0.0.zip");
  });

  it("detects Sparkle updates when only the build version advances", () => {
    const data = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <item>
      <enclosure
        url="https://example.com/download/1.0-build-101.zip"
        sparkle:version="101"
        sparkle:shortVersionString="1.0" />
    </item>
  </channel>
</rss>`);

    const result = new SparkleAppcastClient().parseAppcast(data, version("1.0"), version("100"));
    expect(result?.remoteVersion.raw).toBe("1.0");
    expect(result?.remoteBuildVersion?.raw).toBe("101");
    expect(result?.updateURL).toBe("https://example.com/download/1.0-build-101.zip");
    expect(
      new SparkleAppcastClient().parseAppcast(data, version("1.0"), version("101"))
    ).toBeUndefined();
  });

  it("uses stable Sparkle releases as updates over matching local prerelease builds", () => {
    const stableOlderBuildRelease = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <item>
      <enclosure
        url="https://example.com/download/1.0.0-beta.2.zip"
        sparkle:version="102"
        sparkle:shortVersionString="1.0.0-beta.2" />
    </item>
    <item>
      <enclosure
        url="https://example.com/download/1.0.0.zip"
        sparkle:version="100"
        sparkle:shortVersionString="1.0.0" />
    </item>
  </channel>
</rss>`);
    const stableNewerBuildRelease = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <item>
      <enclosure
        url="https://example.com/download/1.0.0-beta.2.zip"
        sparkle:version="102"
        sparkle:shortVersionString="1.0.0-beta.2" />
    </item>
    <item>
      <enclosure
        url="https://example.com/download/1.0.0.zip"
        sparkle:version="103"
        sparkle:shortVersionString="1.0.0" />
    </item>
  </channel>
</rss>`);
    const betaRelease = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <item>
      <enclosure
        url="https://example.com/download/1.0.0-beta.2.zip"
        sparkle:version="102"
        sparkle:shortVersionString="1.0.0-beta.2" />
    </item>
  </channel>
</rss>`);

    expect(
      new SparkleAppcastClient().parseAppcast(
        stableNewerBuildRelease,
        version("1.0.0-beta.2"),
        version("102")
      )
    ).toMatchObject({
      remoteVersion: version("1.0.0"),
      updateURL: "https://example.com/download/1.0.0.zip"
    });
    expect(
      new SparkleAppcastClient().parseAppcast(
        stableOlderBuildRelease,
        version("1.0.0-beta.2"),
        version("102")
      )
    ).toBeUndefined();
    expect(new SparkleAppcastClient().parseAppcast(betaRelease, version("1.0.0"))).toBeUndefined();
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

  it("uses stable Homebrew cask versions as updates over matching local prerelease builds", () => {
    const client = new HomebrewCaskClient();
    const stableIndex = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "prerelease-app",
            version: "1.0.0",
            bundleIdentifier: "com.example.prerelease"
          }
        ])
      )
    );
    const betaIndex = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "prerelease-app",
            version: "1.0.0-beta.2",
            bundleIdentifier: "com.example.prerelease"
          }
        ])
      )
    );

    expect(
      client.lookupUpdate(
        "com.example.prerelease",
        "Prerelease App.app",
        version("1.0.0-beta.2"),
        stableIndex
      )
    ).toMatchObject({
      remoteVersion: version("1.0.0"),
      token: "prerelease-app"
    });
    expect(
      client.lookupUpdate(
        "com.example.prerelease",
        "Prerelease App.app",
        version("1.0.0"),
        betaIndex
      )
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

  it("compares GitHub latest release metadata for Baseline self-updates", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          html_url: "https://github.com/arshiaghaf/Baseline/releases/tag/v0.2.0"
        }),
        { status: 200 }
      )
    );

    try {
      await expect(
        new SelfUpdateClient().lookup(version("0.1.0"), "2026-05-31T12:00:00.000Z")
      ).resolves.toMatchObject({
        available: true,
        currentVersion: version("0.1.0"),
        latestVersion: version("v0.2.0"),
        releaseURL: "https://github.com/arshiaghaf/Baseline/releases/tag/v0.2.0",
        checkedAt: "2026-05-31T12:00:00.000Z"
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not offer self-updates when the local build is already at the release version", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          html_url: "https://github.com/arshiaghaf/Baseline/releases/tag/v0.2.0"
        }),
        { status: 200 }
      )
    );

    try {
      await expect(
        new SelfUpdateClient().lookup(version("0.2.0"), "2026-05-31T12:00:00.000Z")
      ).resolves.toMatchObject({
        available: false,
        currentVersion: version("0.2.0"),
        latestVersion: version("v0.2.0")
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not offer self-updates when the local build is ahead of the latest release", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          html_url: "https://github.com/arshiaghaf/Baseline/releases/tag/v0.2.0"
        }),
        { status: 200 }
      )
    );

    try {
      await expect(
        new SelfUpdateClient().lookup(version("0.3.0"), "2026-05-31T12:00:00.000Z")
      ).resolves.toMatchObject({
        available: false,
        currentVersion: version("0.3.0"),
        latestVersion: version("v0.2.0")
      });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
