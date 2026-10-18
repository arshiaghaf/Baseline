// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupAppUpdates } from "../src/main/appUpdateLookupService";
import { HomebrewCaskClient } from "../src/main/homebrewCaskClient";
import { canUseHomebrewAppUpdate } from "../src/main/homebrewReconciliation";
import { SparkleAppcastClient } from "../src/main/sparkleAppcastClient";
import type {
  AppProviderCheck,
  AppRecord,
  HomebrewCaskIndex,
  HomebrewManagedItem
} from "../src/shared/domain";
import { caskIndexForInstalledItems } from "../src/shared/homebrewIdentity";
import { version } from "../src/shared/version";

afterEach(() => vi.unstubAllGlobals());

const app: AppRecord = {
  id: "/fixture/Example.app",
  bundlePath: "/fixture/Example.app",
  displayName: "Example",
  bundleIdentifier: "com.example.fixture",
  localVersion: version("1"),
  sourceHint: "unknown"
};

const installed: HomebrewManagedItem = {
  id: "cask:example",
  kind: "cask",
  token: "example",
  fullToken: "example",
  tap: "homebrew/cask",
  name: "Example",
  installedVersion: version("1"),
  latestVersion: version("2"),
  isOutdated: true
};

async function lookupCasks(
  homebrew: HomebrewCaskClient,
  index: HomebrewCaskIndex,
  items: HomebrewManagedItem[],
  record = app,
  sparkle: Pick<SparkleAppcastClient, "lookupOutcome"> = {
    lookupOutcome: async () => ({ type: "completed" })
  }
) {
  let checks: Record<string, AppProviderCheck> = {};
  const updates = await lookupAppUpdates(
    {
      appStore: { lookupOutcome: async () => ({ type: "completed" }) },
      sparkle,
      homebrew
    },
    {
      apps: [record],
      previousUpdates: new Map(),
      homebrewItems: items,
      homebrewIndex: index,
      now: "2026-10-18T00:00:00.000Z",
      force: true,
      signal: new AbortController().signal,
      isCurrent: () => true,
      isSelfApp: () => false,
      canUseHomebrewAppUpdate,
      onProgress: (next) => {
        checks = next;
      }
    }
  );
  return { updates, checks };
}

describe("eligible update candidates", () => {
  it.each([
    { bundleEvidence: true, siblingVersion: "3" },
    { bundleEvidence: false, siblingVersion: "3" },
    { bundleEvidence: true, siblingVersion: "2" },
    { bundleEvidence: false, siblingVersion: "2" }
  ])(
    "finds an installed cask behind an unowned sibling ($bundleEvidence, $siblingVersion)",
    async ({ bundleEvidence, siblingVersion }) => {
      const homebrew = new HomebrewCaskClient();
      const catalogue = homebrew.parseIndex(
        Buffer.from(
          JSON.stringify(
            [
              { token: "example", version: "2" },
              { token: "example-preview", version: siblingVersion }
            ].map((entry) => ({
              ...entry,
              artifacts: [{ app: ["Example.app"] }],
              ...(bundleEvidence ? { bundle_id: app.bundleIdentifier } : {})
            }))
          )
        )
      );
      const items = [installed];
      const index = caskIndexForInstalledItems(catalogue, items);
      expect(canUseHomebrewAppUpdate(app, "example", items, index)).toBe(true);
      expect(canUseHomebrewAppUpdate(app, "example-preview", items, index)).toBe(false);
      const { updates } = await lookupCasks(homebrew, index, items);
      expect(updates).toMatchObject([
        {
          appID: app.id,
          source: "homebrew",
          homebrewToken: "example",
          remoteVersion: version("2")
        }
      ]);
      // App lookup must leave uninstalled sibling editions available to Discover.
      expect(homebrew.searchCasks("example", index, new Set(["example"]))).toMatchObject([
        { token: "example-preview" }
      ]);
      expect((await lookupCasks(homebrew, index, [])).updates).toEqual([]);
      const current = await lookupCasks(homebrew, index, items, {
        ...app,
        localVersion: version("2")
      });
      expect(current.updates).toEqual([]);
      expect(current.checks[app.id]).toMatchObject({ status: "checked", source: "homebrew" });
      if (siblingVersion === "3") {
        const bothInstalled = [
          installed,
          {
            ...installed,
            id: "cask:example-preview",
            token: "example-preview",
            fullToken: "example-preview"
          }
        ];
        expect((await lookupCasks(homebrew, index, bothInstalled)).updates).toMatchObject([
          { homebrewToken: "example-preview", remoteVersion: version("3") }
        ]);
      }
    }
  );

  it("uses installed custom-tap metadata without borrowing a colliding public cask", async () => {
    const homebrew = new HomebrewCaskClient();
    const catalogue = homebrew.parseIndex(
      Buffer.from(
        JSON.stringify([
          { token: "example", version: "99", bundle_id: "com.example.other" },
          { token: "example-preview", version: "3", bundle_id: app.bundleIdentifier }
        ])
      )
    );
    const metadata = homebrew.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            token: "example",
            full_token: "fixture/apps/example",
            tap: "fixture/apps",
            version: "2",
            bundle_id: app.bundleIdentifier,
            homepage: "https://example.com/publisher"
          }
        ])
      )
    ).byToken.example;
    const items = [
      {
        ...installed,
        fullToken: "fixture/apps/example",
        tap: "fixture/apps",
        caskMetadata: metadata
      }
    ];
    const index = caskIndexForInstalledItems(catalogue, items);
    expect((await lookupCasks(homebrew, index, items)).updates).toMatchObject([
      {
        homebrewToken: "example",
        remoteVersion: version("2"),
        updateURL: "https://example.com/publisher"
      }
    ]);

    const missingMetadata = items.map((item) => ({ ...item, caskMetadata: undefined }));
    expect(
      (
        await lookupCasks(
          homebrew,
          caskIndexForInstalledItems(catalogue, missingMetadata),
          missingMetadata
        )
      ).updates
    ).toEqual([]);
  });

  it.each(["", ' url="http://example.com/three.zip"'])(
    "finds a valid release below an unusable appcast item (%s)",
    async (topRoute) => {
      const feed = `<rss><channel>
        <item><enclosure sparkle:shortVersionString="3"${topRoute} /></item>
        <item><enclosure sparkle:shortVersionString="2" url="https://example.com/two.zip" /></item>
      </channel></rss>`;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(feed))
      );
      const result = await new SparkleAppcastClient().lookupOutcome(
        "https://example.com/feed.xml",
        version("1")
      );
      expect(result).toMatchObject({
        type: "completed",
        providerFound: true,
        value: { remoteVersion: version("2"), updateURL: "https://example.com/two.zip" }
      });
    }
  );

  it("excludes unusable build-only items before choosing the comparison domain", () => {
    const feed = Buffer.from(`<rss><channel>
      <item><enclosure sparkle:version="999" /></item>
      <item><enclosure sparkle:shortVersionString="2" sparkle:version="200" url="https://example.com/two.zip" /></item>
      <item><enclosure sparkle:shortVersionString="3" sparkle:version="100" url="https://example.com/three.zip" /></item>
    </channel></rss>`);
    expect(new SparkleAppcastClient().parseAppcast(feed, version("1"), version("1"))).toMatchObject(
      {
        remoteVersion: version("3"),
        remoteBuildVersion: version("100"),
        versionComparison: "marketing"
      }
    );
  });

  it("keeps a lower usable Sparkle release ahead of an owned Homebrew fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`<rss><channel>
      <item><sparkle:shortVersionString>3</sparkle:shortVersionString></item>
      <item><enclosure sparkle:shortVersionString="2" url="https://example.com/two.zip" /></item>
    </channel></rss>`)
      )
    );
    const homebrew = new HomebrewCaskClient();
    const catalogue = homebrew.parseIndex(
      Buffer.from(
        JSON.stringify([{ token: "example", version: "4", bundle_id: app.bundleIdentifier }])
      )
    );
    const { updates } = await lookupCasks(
      homebrew,
      caskIndexForInstalledItems(catalogue, [installed]),
      [installed],
      { ...app, sparkleFeedURL: "https://example.com/feed.xml" },
      new SparkleAppcastClient()
    );
    expect(updates).toMatchObject([
      { source: "sparkle", remoteVersion: version("2"), updateURL: "https://example.com/two.zip" }
    ]);
  });

  it("retains a release-notes route and compares a cached feed for each installed build", async () => {
    const feed = `<rss><channel>
      <item><enclosure sparkle:shortVersionString="1" sparkle:version="102" url="http://example.com/unsafe.zip" />
        <sparkle:releaseNotesLink>https://example.com/notes</sparkle:releaseNotesLink></item>
      <item><enclosure sparkle:shortVersionString="1" sparkle:version="101" url="https://example.com/older.zip" /></item>
    </channel></rss>`;
    const fetch = vi.fn(async () => new Response(feed));
    vi.stubGlobal("fetch", fetch);
    const client = new SparkleAppcastClient();
    expect(
      await client.lookupOutcome("https://example.com/feed.xml", version("1"), version("100"))
    ).toMatchObject({
      providerFound: true,
      value: {
        remoteBuildVersion: version("102"),
        updateURL: undefined,
        releaseNotesURL: "https://example.com/notes"
      }
    });
    expect(
      await client.lookupOutcome("https://example.com/feed.xml", version("1"), version("102"))
    ).toMatchObject({ type: "completed", providerFound: true, value: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not report a provider when every versioned item has only rejected routes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`<rss><channel>
      <item><enclosure sparkle:shortVersionString="3" url="http://example.com/unsafe.zip" /></item>
      <item><enclosure sparkle:shortVersionString="2" />
        <sparkle:releaseNotesLink>javascript:alert(1)</sparkle:releaseNotesLink></item>
    </channel></rss>`)
      )
    );
    expect(
      await new SparkleAppcastClient().lookupOutcome("https://example.com/feed.xml", version("1"))
    ).toMatchObject({ type: "completed", providerFound: false, value: undefined });
  });
});
