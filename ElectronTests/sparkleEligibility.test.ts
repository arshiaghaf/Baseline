// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { XMLParser } from "fast-xml-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupAppUpdates } from "../src/main/appUpdateLookupService";
import { SparkleAppcastClient } from "../src/main/sparkleAppcastClient";
import { externalAppUpdateAction } from "../src/shared/appUpdateAction";
import { emptyHomebrewCaskIndex, type AppRecord } from "../src/shared/domain";
import { version } from "../src/shared/version";

const host = { platform: "darwin" as const, systemVersion: "14.5.1" };
const feedURL = "https://example.com/appcast.xml";
const feed = (...items: string[]) => Buffer.from(`<rss><channel>${items.join("")}</channel></rss>`);
const release = (number: number, metadata = "", attributes = "") =>
  `<item>${metadata}<enclosure url="https://example.com/release-${number}.zip"
    sparkle:version="${number * 100}" sparkle:shortVersionString="${number}.0" ${attributes}/></item>`;

// All requests below use in-memory feeds, without contacting a provider or archive.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Sparkle release eligibility", () => {
  it.each(["beta", "nightly", "staged", "stable"])(
    "requires explicit opt-in to the named %s channel even for plain numeric versions",
    (channel) => {
      const client = new SparkleAppcastClient(host);
      const data = feed(release(2), release(3, `<sparkle:channel>${channel}</sparkle:channel>`));
      expect(client.parseAppcast(data, version("1"))?.remoteVersion.raw).toBe("2.0");
      expect(
        client.parseAppcast(data, version("1"), undefined, { allowedChannels: [channel] })
          ?.remoteVersion.raw
      ).toBe("3.0");
      expect(client.parseAppcast(data, version("2"), version("200"))).toBeUndefined();
    }
  );

  it("keeps default-channel releases eligible for apps that opted into another channel", () => {
    const client = new SparkleAppcastClient(host);
    const result = client.parseAppcast(
      feed(release(3, "<sparkle:channel>beta</sparkle:channel>"), release(4)),
      version("1"),
      undefined,
      { allowedChannels: ["beta"] }
    );
    expect(result?.remoteVersion.raw).toBe("4.0");
  });

  it.each([
    ["minimum OS", "<sparkle:minimumSystemVersion>99.0</sparkle:minimumSystemVersion>", ""],
    ["maximum OS", "<sparkle:maximumSystemVersion>14.5.0</sparkle:maximumSystemVersion>", ""],
    ["other OS", "", 'sparkle:os="windows"'],
    ["unknown OS", "", 'sparkle:os="other"'],
    [
      "malformed OS bound",
      "<sparkle:minimumSystemVersion>unknown</sparkle:minimumSystemVersion>",
      ""
    ],
    [
      "duplicate channels",
      "<sparkle:channel>beta</sparkle:channel><sparkle:channel>staged</sparkle:channel>",
      ""
    ]
  ])(
    "selects a compatible fallback before ranking when a newer release has %s",
    (_name, tags, attrs) => {
      const client = new SparkleAppcastClient(host);
      const data = feed(release(2), release(3, tags, attrs));
      const result = client.parseAppcast(data, version("1"));
      expect(result?.remoteVersion.raw).toBe("2.0");
      expect(result?.updateURL).toBe("https://example.com/release-2.zip");
      expect(client.parseAppcast(data, version("2"), version("200"))).toBeUndefined();
    }
  );

  it.each([
    ["", ""],
    ["<sparkle:minimumSystemVersion>14.5.1</sparkle:minimumSystemVersion>", 'sparkle:os="macos"'],
    ["<sparkle:maximumSystemVersion>14.5.1</sparkle:maximumSystemVersion>", ""],
    [
      "<sparkle:minimumSystemVersion>14.5</sparkle:minimumSystemVersion><sparkle:maximumSystemVersion>15</sparkle:maximumSystemVersion>",
      ""
    ]
  ])("accepts absent requirements and inclusive compatible OS bounds (%s)", (tags, attrs) => {
    expect(
      new SparkleAppcastClient(host).parseAppcast(feed(release(3, tags, attrs)), version("1"))
        ?.remoteVersion.raw
    ).toBe("3.0");
  });

  it("does not assume compatibility when the host OS version is unavailable", () => {
    const client = new SparkleAppcastClient({ platform: "darwin" });
    expect(
      client.parseAppcast(
        feed(
          release(2),
          release(3, "<sparkle:minimumSystemVersion>12</sparkle:minimumSystemVersion>")
        ),
        version("1")
      )?.remoteVersion.raw
    ).toBe("2.0");
    expect(
      new SparkleAppcastClient({ platform: "win32", systemVersion: "14.5.1" }).parseAppcast(
        feed(release(2)),
        version("1")
      )
    ).toBeUndefined();
  });

  it.each([false, true])("finds a usable macOS enclosure regardless of order (%s)", (reverse) => {
    const enclosures = [
      '<enclosure sparkle:os="windows" url="https://example.com/windows.exe" />',
      '<enclosure sparkle:os="macos" url="https://example.com/mac.zip" />'
    ];
    if (reverse) enclosures.reverse();
    const data = feed(`<item><sparkle:version>300</sparkle:version>
      <sparkle:shortVersionString>3.0</sparkle:shortVersionString>${enclosures.join("")}</item>`);
    expect(new SparkleAppcastClient(host).parseAppcast(data, version("1"))?.updateURL).toBe(
      "https://example.com/mac.zip"
    );
  });

  it("does not offer release notes for an ineligible enclosure", () => {
    const data = feed(
      release(
        3,
        "<sparkle:releaseNotesLink>https://example.com/notes</sparkle:releaseNotesLink>",
        'sparkle:os="windows"'
      )
    );
    expect(new SparkleAppcastClient(host).parseAppcast(data, version("1"))).toBeUndefined();
  });

  it("selects channels independently for apps sharing fetched and decoded feed metadata", async () => {
    const data = feed(release(2), release(3, "<sparkle:channel>beta</sparkle:channel>"));
    const fetchMock = vi.fn(async () => new Response(data.toString()));
    vi.stubGlobal("fetch", fetchMock);
    const parse = vi.spyOn(XMLParser.prototype, "parse");
    const client = new SparkleAppcastClient(host);
    const refresh = { force: true, signal: new AbortController().signal };
    const optedIn = await client.lookupOutcome(feedURL, version("1"), undefined, {
      ...refresh,
      allowedChannels: ["beta"]
    });
    expect(optedIn).toMatchObject({ value: { remoteVersion: version("3.0") } });
    const ordinary = await client.lookupOutcome(feedURL, version("1"), undefined, refresh);
    expect(ordinary).toMatchObject({ value: { remoteVersion: version("2.0") } });
    expect(
      await client.lookupOutcome(feedURL, version("2"), version("200"), refresh)
    ).toMatchObject({
      type: "completed",
      providerFound: true,
      value: undefined
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("publishes only eligible external download actions through app lookup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            feed(
              release(2),
              release(3, "<sparkle:channel>beta</sparkle:channel>"),
              release(4, "<sparkle:minimumSystemVersion>99</sparkle:minimumSystemVersion>"),
              release(5, "", 'sparkle:os="windows"')
            ).toString()
          )
      )
    );
    const apps: AppRecord[] = ["1.0", "2.0"].map((localVersion, index) => ({
      id: `app-${index}`,
      displayName: `Example ${index}`,
      bundlePath: `/fixtures/Example ${index}.app`,
      localVersion: version(localVersion),
      bundleVersion: version(`${(index + 1) * 100}`),
      sparkleFeedURL: feedURL,
      sourceHint: "sparkle"
    }));
    const updates = await lookupAppUpdates(
      {
        sparkle: new SparkleAppcastClient(host),
        appStore: { lookupOutcome: vi.fn().mockResolvedValue({ type: "completed" }) },
        homebrew: { lookupUpdate: vi.fn() }
      },
      {
        apps,
        previousUpdates: new Map(),
        homebrewItems: [],
        homebrewIndex: emptyHomebrewCaskIndex,
        now: "2026-10-23T00:00:00.000Z",
        force: true,
        signal: new AbortController().signal,
        isCurrent: () => true,
        isSelfApp: () => false,
        canUseHomebrewAppUpdate: () => false
      }
    );
    expect(updates).toHaveLength(1);
    expect(updates![0]).toMatchObject({
      appID: "app-0",
      source: "sparkle",
      remoteVersion: version("2.0")
    });
    expect(externalAppUpdateAction(updates![0]!)).toEqual({
      kind: "download",
      url: "https://example.com/release-2.zip"
    });
  });
});
