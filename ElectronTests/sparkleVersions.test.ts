// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { SparkleAppcastClient } from "../src/main/sparkleAppcastClient";
import { version } from "../src/shared/version";

const client = new SparkleAppcastClient();
function feed(items: string) {
  return Buffer.from(
    `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>${items}</channel></rss>`
  );
}

const feedOrders = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0]
];
function release(label: string, build?: string, marketing?: string): string {
  return `<item><enclosure url="https://example.com/${label}.zip"${build === undefined ? "" : ` sparkle:version="${build}"`}${marketing === undefined ? "" : ` sparkle:shortVersionString="${marketing}"`} /></item>`;
}

describe("Sparkle version representations", () => {
  it("reads recommended child elements without losing version formatting", () => {
    const xml = feed(
      `<item><sparkle:version>00200</sparkle:version><sparkle:shortVersionString>2.0</sparkle:shortVersionString><enclosure url="https://example.com/app.zip" /></item>`
    );
    expect(client.parseAppcast(xml, version("1.0"), version("100"))).toMatchObject({
      remoteVersion: version("2.0"),
      remoteBuildVersion: version("00200")
    });
    expect(client.parseAppcast(xml, version("2.0"), version("200"))).toBeUndefined();
    expect(client.parseAppcast(xml, version("3.0"), version("300"))).toBeUndefined();
  });

  it("preserves legacy attributes and prefers child elements when both exist", () => {
    const legacy = feed(
      `<item><enclosure url="https://example.com/app.zip" sparkle:version="200" sparkle:shortVersionString="2.0" /></item>`
    );
    expect(client.parseAppcast(legacy, version("1.0"), version("100"))?.remoteVersion).toEqual(
      version("2.0")
    );
    const both = feed(
      `<item><sparkle:version>300</sparkle:version><sparkle:shortVersionString>3.0</sparkle:shortVersionString><enclosure url="https://example.com/app.zip" sparkle:version="200" sparkle:shortVersionString="2.0" /></item>`
    );
    expect(client.parseAppcast(both, version("1.0"), version("100"))?.remoteVersion).toEqual(
      version("3.0")
    );
  });

  it.each(["100", "200"])("rejects build-only release %s when installed build is 200", (build) => {
    const xml = feed(
      `<item><enclosure url="https://example.com/app.zip" sparkle:version="${build}" /></item>`
    );
    expect(client.parseAppcast(xml, version("1.0"), version("200"))).toBeUndefined();
  });

  it("accepts a newer build-only release and retains the version-only fallback", () => {
    const xml = feed(
      `<item><sparkle:version>201</sparkle:version><enclosure url="https://example.com/app.zip" /></item>`
    );
    expect(client.parseAppcast(xml, version("1.0"), version("200"))?.remoteBuildVersion).toEqual(
      version("201")
    );
    expect(client.parseAppcast(xml, version("200"))?.remoteVersion).toEqual(version("201"));
  });

  it("orders mixed marketing/build-only releases by comparable builds", () => {
    const xml = feed(
      `<item><enclosure url="https://example.com/old.zip" sparkle:version="150" /></item><item><sparkle:version>200</sparkle:version><sparkle:shortVersionString>2.0</sparkle:shortVersionString><enclosure url="https://example.com/new.zip" /></item>`
    );
    expect(client.parseAppcast(xml, version("1.0"), version("100"))?.updateURL).toBe(
      "https://example.com/new.zip"
    );
  });

  it("uses marketing text for display when mixed representations refer to the same build", () => {
    const xml = feed(
      `<item><enclosure url="https://example.com/app.zip" sparkle:version="200" /></item><item><sparkle:version>200</sparkle:version><sparkle:shortVersionString>2.0</sparkle:shortVersionString><enclosure url="https://example.com/app.zip" /></item>`
    );
    expect(client.parseAppcast(xml, version("1.0"), version("100"))?.remoteVersion).toEqual(
      version("2.0")
    );
  });

  it.each([
    `<item><sparkle:version>200</sparkle:version><sparkle:shortVersionString></sparkle:shortVersionString><enclosure url="https://example.com/new.zip" /></item>`,
    `<item><sparkle:version>200</sparkle:version><sparkle:shortVersionString> </sparkle:shortVersionString><enclosure url="https://example.com/new.zip" /></item>`,
    `<item sparkle:version="200" sparkle:shortVersionString=""><enclosure url="https://example.com/new.zip" /></item>`,
    `<item sparkle:version="200" sparkle:shortVersionString=" "><enclosure url="https://example.com/new.zip" /></item>`,
    release("new", "200", ""),
    release("new", "200", " ")
  ])("treats blank child/item/enclosure marketing versions as absent: %s", (item) => {
    const xml = feed(item);
    expect(client.parseAppcast(xml, version("1"), version("100"))?.remoteBuildVersion).toEqual(
      version("200")
    );
    expect(client.parseAppcast(xml, version("1"), version("200"))).toBeUndefined();
  });

  it.each([
    `<item><sparkle:version></sparkle:version><sparkle:shortVersionString></sparkle:shortVersionString><enclosure url="https://example.com/new.zip" sparkle:version="200" sparkle:shortVersionString="2.0" /></item>`,
    `<item><sparkle:version> </sparkle:version><sparkle:shortVersionString> </sparkle:shortVersionString><enclosure url="https://example.com/new.zip" sparkle:version="200" sparkle:shortVersionString="2.0" /></item>`,
    `<item sparkle:version="" sparkle:shortVersionString=""><enclosure url="https://example.com/new.zip" sparkle:version="200" sparkle:shortVersionString="2.0" /></item>`,
    `<item sparkle:version=" " sparkle:shortVersionString=" "><enclosure url="https://example.com/new.zip" sparkle:version="200" sparkle:shortVersionString="2.0" /></item>`
  ])("skips blank version aliases to find nonempty fallback attributes: %s", (item) => {
    expect(client.parseAppcast(feed(item), version("1"), version("100"))).toMatchObject({
      remoteVersion: version("2.0"),
      remoteBuildVersion: version("200")
    });
  });

  it.each(feedOrders)(
    "orders the entire mixed-version pool by builds for permutation %j",
    (...order) => {
      const entries = [release("A", "400", "2.0"), release("B", "200", "3.0"), release("C", "300")];
      const xml = feed(order.map((index) => entries[index]).join(""));
      expect(client.parseAppcast(xml, version("1"), version("100"))?.updateURL).toBe(
        "https://example.com/A.zip"
      );
    }
  );

  it.each(feedOrders)(
    "keeps marketing ordering for a homogeneous pool for permutation %j",
    (...order) => {
      const entries = [
        release("A", "400", "2.0"),
        release("B", "200", "3.0"),
        release("C", "300", "2.5")
      ];
      const xml = feed(order.map((index) => entries[index]).join(""));
      expect(client.parseAppcast(xml, version("1"), version("100"))?.updateURL).toBe(
        "https://example.com/B.zip"
      );
    }
  );

  it.each(feedOrders)(
    "prefers comparable builds in mixed pools with missing builds for permutation %j",
    (...order) => {
      const entries = [
        release("A", undefined, "4.0"),
        release("B", "400", "2.0"),
        release("C", "300")
      ];
      const xml = feed(order.map((index) => entries[index]).join(""));
      expect(client.parseAppcast(xml, version("1"), version("100"))?.updateURL).toBe(
        "https://example.com/B.zip"
      );
      expect(client.parseAppcast(feed(entries[0]!), version("1"))?.remoteVersion).toEqual(
        version("4.0")
      );
    }
  );
});
