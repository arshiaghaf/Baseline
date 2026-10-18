// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, expect, it, vi } from "vitest";
import { SparkleAppcastClient } from "../src/main/sparkleAppcastClient";
import { version } from "../src/shared/version";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("distinguishes a current feed release from an empty or malformed source response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          '<rss><channel><item><enclosure url="https://example.com/release.zip" sparkle:shortVersionString="2.0" sparkle:version="200" /></item></channel></rss>'
        )
    )
  );
  expect(
    await new SparkleAppcastClient().lookupOutcome("https://example.com/current.xml", version("3"))
  ).toMatchObject({ type: "completed", providerFound: true, value: undefined });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("<rss><channel><title>Example</title></channel></rss>"))
  );
  expect(
    await new SparkleAppcastClient().lookupOutcome("https://example.com/empty.xml", version("3"))
  ).toMatchObject({ type: "completed", providerFound: false, value: undefined });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("<html><body>Unavailable</body></html>"))
  );
  expect(
    await new SparkleAppcastClient().lookupOutcome(
      "https://example.com/malformed.xml",
      version("3")
    )
  ).toEqual({ type: "transientFailure" });
});
