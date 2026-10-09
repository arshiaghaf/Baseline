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
});
