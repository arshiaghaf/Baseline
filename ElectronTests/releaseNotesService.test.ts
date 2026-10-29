// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import {
  defaultPersistedSnapshot,
  type BaselineSnapshot,
  type HomebrewManagedItem,
  type UpdateRecord
} from "../src/shared/domain";
import type { ReleaseNotesTarget } from "../src/shared/releaseNotes";
import { version } from "../src/shared/version";
import { ReleaseNotesService, githubReleaseFromMetadata } from "../src/main/releaseNotesService";
import type { ReleaseNotesFetcher, ReleaseNotesResponse } from "../src/main/releaseNotesFetch";
import { releaseNotesText } from "../src/main/releaseNotesText";
import { exactSparkleReleaseNotes, SparkleAppcastClient } from "../src/main/sparkleAppcastClient";
import { SnapshotPersistence } from "../src/main/persistence";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const app = {
  id: "app:example",
  displayName: "Example",
  bundlePath: "/Applications/Example.app",
  bundleIdentifier: "org.example.app",
  localVersion: version("1.0"),
  sourceHint: "sparkle" as const,
  sparkleFeedURL: "https://updates.example.org/feed.xml"
};
const target: ReleaseNotesTarget = { kind: "app", id: app.id, version: "2.0", buildVersion: "20" };
const update: UpdateRecord = {
  id: app.id,
  appID: app.id,
  source: "sparkle",
  supportLevel: "limited",
  localVersion: app.localVersion,
  remoteVersion: version("2.0"),
  remoteBuildVersion: version("20"),
  checkedAt: "2026-10-28T12:00:00Z",
  releaseNotesURL: "https://updates.example.org/2.0.html"
};
const snapshot = (patch: Partial<BaselineSnapshot> = {}) =>
  ({
    ...defaultPersistedSnapshot(),
    apps: [app],
    updates: [update],
    ...patch
  }) as BaselineSnapshot;
const response = (
  url: string,
  content: string | object,
  status = 200,
  type = "application/json"
): ReleaseNotesResponse => ({
  url,
  status,
  data: Buffer.from(typeof content === "string" ? content : JSON.stringify(content)),
  headers: { "content-type": type }
});
const formula: HomebrewManagedItem = {
  id: "formula:example",
  kind: "formula",
  token: "example",
  name: "Example Tool",
  installedVersion: version("1.0"),
  latestVersion: version("2.0_1"),
  isOutdated: true,
  formulaIdentity: { name: "example", fullName: "example", tap: "homebrew/core", oldNames: [] }
};
const formulaTarget: ReleaseNotesTarget = { kind: "homebrew", id: formula.id, version: "2.0_1" };
const formulaMetadata = {
  name: "example",
  tap: "homebrew/core",
  versions: { stable: "2.0" },
  revision: 1,
  homepage: "https://example.org",
  urls: { stable: { url: "https://github.com/example/project/archive/refs/tags/v2.0.tar.gz" } }
};

describe("release notes content", () => {
  it("reduces publisher HTML to inert readable blocks, excluding hidden/executable content", () => {
    const result = releaseNotesText(
      '<head><title>Noise</title></head><h2>What &amp; why</h2><p>New <b>feature</b>.</p><ul><li>Fixes</li></ul><script>alert(1)</script><iframe>remote</iframe><p hidden>secret</p><p aria-hidden="true">hidden</p><img src="https://tracking.example.org/pixel">',
      "html"
    );
    expect(result.blocks).toEqual([
      { type: "heading", text: "What & why" },
      { type: "paragraph", text: "New feature." },
      { type: "list-item", text: "Fixes" }
    ]);
    expect(result.truncated).toBe(false);
  });

  it("preserves plain App Store text and bounds very long content", () => {
    expect(releaseNotesText("Use <a> literally.\nNext line", "plain-text").blocks[0]?.text).toBe(
      "Use <a> literally.\nNext line"
    );
    const result = releaseNotesText(`<p>${"x".repeat(100_000)}</p>`, "html");
    expect(result.truncated).toBe(true);
    expect(result.blocks.reduce((sum, block) => sum + block.text.length, 0)).toBeLessThanOrEqual(
      64_000
    );
    expect(releaseNotesText("# Release\r\n\r\n- Fixed\r\n- Added", "markdown").blocks).toEqual([
      { type: "heading", text: "Release" },
      { type: "list-item", text: "Fixed" },
      { type: "list-item", text: "Added" }
    ]);
  });
});

describe("release notes service", () => {
  it("uses exact App Store text without a network request or HTML interpretation", async () => {
    const fetch = vi.fn<ReleaseNotesFetcher>();
    const service = new ReleaseNotesService({
      getSnapshot: () =>
        snapshot({
          updates: [
            {
              ...update,
              source: "appStore",
              releaseNotesSummary: "Fixed <widgets>.\n\nImproved speed."
            }
          ]
        }),
      fetch
    });
    const result = await service.getNotes(target);
    expect(result.status).toBe("available");
    expect(result.source).toBe("App Store");
    expect(result.blocks?.[0]?.text).toBe("Fixed <widgets>.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses selected inline Sparkle notes and persists them across relaunch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-notes-"));
    try {
      const persistence = new SnapshotPersistence(directory);
      const saved = snapshot({
        updates: [
          {
            ...update,
            releaseNotesContent: "<h2>New</h2><p>Improved.</p>",
            releaseNotesFormat: "html"
          }
        ]
      });
      await persistence.save(saved);
      const loaded = await persistence.load();
      const fetch = vi.fn<ReleaseNotesFetcher>();
      const result = await new ReleaseNotesService({
        getSnapshot: () => loaded as BaselineSnapshot,
        fetch
      }).getNotes(target);
      expect(result.blocks).toEqual([
        { type: "heading", text: "New" },
        { type: "paragraph", text: "Improved." }
      ]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares and caches remote notes while isolating one cancelled subscriber", async () => {
    let finish!: (value: ReleaseNotesResponse) => void;
    const fetch = vi.fn<ReleaseNotesFetcher>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const service = new ReleaseNotesService({ getSnapshot: () => snapshot(), fetch });
    const controller = new AbortController();
    const first = service.getNotes(target, { signal: controller.signal });
    const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = service.getNotes(target);
    controller.abort();
    finish(
      response(update.releaseNotesURL!, "<h2>Release 2.0</h2><p>Fixed.</p>", 200, "text/html")
    );
    await cancelled;
    expect((await second).status).toBe("available");
    expect(fetch).toHaveBeenCalledTimes(1);
    const cached = await service.getNotes(target);
    cached.blocks![0]!.text = "Changed by caller";
    expect((await service.getNotes(target)).blocks?.[0]?.text).toBe("Release 2.0");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not deliver a late result for a changed update or reuse its cache", async () => {
    let state = snapshot();
    let finish!: (value: ReleaseNotesResponse) => void;
    const fetch = vi.fn<ReleaseNotesFetcher>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const service = new ReleaseNotesService({ getSnapshot: () => state, fetch });
    const task = service.getNotes(target);
    state = snapshot({ updates: [{ ...update, remoteVersion: version("3.0") }] });
    finish(response(update.releaseNotesURL!, "Old", 200, "text/plain"));
    expect(await task).toMatchObject({
      status: "unavailable",
      message: "This update changed. Open release notes again."
    });
    expect((await service.getNotes(target)).status).toBe("unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts only abandoned work and allows a new hover to retry immediately", async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn<ReleaseNotesFetcher>(async (url, options) => {
      signals.push(options!.signal!);
      if (signals.length > 1) return response(url, "Fresh notes", 200, "text/plain");
      return new Promise((_resolve, reject) =>
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
          once: true
        })
      );
    });
    const service = new ReleaseNotesService({ getSnapshot: () => snapshot(), fetch });
    const controller = new AbortController();
    const first = service.getNotes(target, { signal: controller.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(signals[0]?.aborted).toBe(true);
    expect((await service.getNotes(target)).blocks?.[0]?.text).toBe("Fresh notes");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns unavailable for empty or unsupported remote note bodies", async () => {
    const fetch = vi
      .fn<ReleaseNotesFetcher>()
      .mockImplementationOnce(async (url) =>
        response(url, "<script>bad()</script>", 200, "text/html")
      )
      .mockImplementationOnce(async (url) =>
        response(url, "binary", 200, "application/octet-stream")
      );
    const service = new ReleaseNotesService({ getSnapshot: () => snapshot(), fetch });
    expect((await service.getNotes(target)).status).toBe("unavailable");
    expect((await service.getNotes(target, { force: true })).status).toBe("unavailable");
  });

  it("distinguishes absent notes from errors and respects publisher rate limits even on retry", async () => {
    let now = 0;
    const fetch = vi
      .fn<ReleaseNotesFetcher>()
      .mockResolvedValueOnce(response(update.releaseNotesURL!, "", 404));
    fetch.mockResolvedValueOnce({
      ...response(update.releaseNotesURL!, "", 429),
      headers: { "retry-after": "60" }
    });
    const service = new ReleaseNotesService({
      getSnapshot: () => snapshot(),
      fetch,
      now: () => now
    });
    expect((await service.getNotes(target)).status).toBe("unavailable");
    expect(await service.getNotes(target, { force: true })).toMatchObject({
      status: "error",
      message: "The publisher is limiting requests. Try again later."
    });
    expect((await service.getNotes(target, { force: true })).status).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(2);
    now = 61_000;
    fetch.mockResolvedValueOnce(response(update.releaseNotesURL!, "Fixed", 200, "text/plain"));
    expect((await service.getNotes(target, { force: true })).status).toBe("available");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("maps official Homebrew formula revisions to the explicit upstream GitHub tag", async () => {
    const fetch = vi.fn<ReleaseNotesFetcher>(async (url) =>
      url.includes("formulae.brew.sh")
        ? response(url, formulaMetadata)
        : response(url, { tag_name: "v2.0", body: "## New\n\n- Fixed", draft: false })
    );
    const service = new ReleaseNotesService({
      getSnapshot: () => snapshot({ homebrewItems: [formula] }),
      fetch
    });
    expect(await service.getNotes(formulaTarget)).toMatchObject({
      status: "available",
      source: "GitHub",
      version: "2.0_1",
      sourceURL: "https://github.com/example/project/releases/tag/v2.0"
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://formulae.brew.sh/api/formula/example.json",
      "https://api.github.com/repos/example/project/releases/tags/v2.0"
    ]);
  });

  it("honours HTTP-date Retry-After deadlines rather than retrying after one minute", async () => {
    let now = 0;
    const retryAt = new Date(Date.now() + 120_000).toUTCString();
    const fetch = vi
      .fn<ReleaseNotesFetcher>()
      .mockResolvedValueOnce({
        ...response(update.releaseNotesURL!, "", 429),
        headers: { "retry-after": retryAt }
      })
      .mockImplementationOnce(async (url) => response(url, "Fixed", 200, "text/plain"));
    const service = new ReleaseNotesService({
      getSnapshot: () => snapshot(),
      fetch,
      now: () => now
    });
    expect((await service.getNotes(target)).status).toBe("error");
    now = 61_000;
    expect((await service.getNotes(target, { force: true })).status).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 121_000;
    expect((await service.getNotes(target, { force: true })).status).toBe("available");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...formulaMetadata, versions: { stable: "3.0" } },
    { ...formulaMetadata, tap: "other/tap" },
    {
      ...formulaMetadata,
      urls: { stable: { url: "https://github.com/example/project/archive/refs/heads/main.tar.gz" } }
    },
    {
      ...formulaMetadata,
      urls: {
        stable: { url: "https://github.com/example/project/releases/download/v9.0/file.zip" }
      }
    }
  ])("does not guess a GitHub source for stale or ambiguous package metadata", async (metadata) => {
    const fetch = vi.fn<ReleaseNotesFetcher>(async (url) => response(url, metadata));
    const result = await new ReleaseNotesService({
      getSnapshot: () => snapshot({ homebrewItems: [formula] }),
      fetch
    }).getNotes(formulaTarget);
    expect(result.status).toBe("unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not substitute formula diagnostics or custom taps for developer notes", async () => {
    const fetch = vi.fn<ReleaseNotesFetcher>();
    const state = snapshot({
      updates: [
        {
          ...update,
          source: "homebrew",
          homebrewToken: "example",
          releaseNotesSummary: "Token: example"
        }
      ],
      homebrewItems: [
        {
          ...formula,
          formulaIdentity: {
            ...formula.formulaIdentity!,
            tap: "other/tap",
            fullName: "other/tap/example"
          }
        }
      ]
    });
    const result = await new ReleaseNotesService({ getSnapshot: () => state, fetch }).getNotes(
      formulaTarget
    );
    expect(result.status).toBe("unavailable");
    expect(result.blocks).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses only the exact proven cask app feed release, not a newer feed item", async () => {
    const cask: HomebrewManagedItem = {
      ...formula,
      id: "cask:example",
      kind: "cask",
      fullToken: "example",
      tap: "homebrew/cask",
      appID: app.id,
      latestVersion: version("2.0"),
      caskMetadata: {
        token: "example",
        version: version("2.0"),
        fullToken: "example",
        tap: "homebrew/cask",
        presentation: "app",
        installedAppPaths: [app.bundlePath],
        bundleIdentifiers: [app.bundleIdentifier],
        appBundleNames: ["Example.app"]
      }
    };
    const feed =
      "<rss><channel><item><sparkle:shortVersionString>3.0</sparkle:shortVersionString><sparkle:version>30</sparkle:version><description><![CDATA[<p>Too new</p>]]></description></item><item><sparkle:shortVersionString>2.0</sparkle:shortVersionString><sparkle:version>20</sparkle:version><description><![CDATA[<p>Correct release</p>]]></description></item></channel></rss>";
    const fetch = vi.fn<ReleaseNotesFetcher>(async (url) =>
      response(url, feed, 200, "application/rss+xml")
    );
    const result = await new ReleaseNotesService({
      getSnapshot: () => snapshot({ homebrewItems: [cask] }),
      fetch,
      host: { platform: "darwin", systemVersion: "26.0" }
    }).getNotes({ kind: "homebrew", id: cask.id, version: "2.0" });
    expect(result).toMatchObject({
      status: "available",
      source: "Sparkle",
      blocks: [{ type: "paragraph", text: "Correct release" }]
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("source fidelity", () => {
  it("preserves inline Sparkle formats without promoting notes-only items into update actions", () => {
    const xml =
      '<rss><channel><item><sparkle:version>2.0</sparkle:version><description sparkle:format="plain-text">New &amp; improved</description></item></channel></rss>';
    const client = new SparkleAppcastClient({ platform: "darwin", systemVersion: "26.0" });
    expect(client.parseAppcast(Buffer.from(xml), version("1.0"))).toBeUndefined();
    expect(
      exactSparkleReleaseNotes(Buffer.from(xml), "2.0", undefined, {
        platform: "darwin",
        systemVersion: "26.0"
      })
    ).toMatchObject({ content: "New & improved", format: "plain-text" });
  });

  it("rejects marketing-version ambiguity and unrelated GitHub tag conventions", () => {
    const xml =
      "<rss><channel><item><sparkle:shortVersionString>2.0</sparkle:shortVersionString><sparkle:version>20</sparkle:version><description>A</description></item><item><sparkle:shortVersionString>2.0</sparkle:shortVersionString><sparkle:version>21</sparkle:version><description>B</description></item></channel></rss>";
    expect(
      exactSparkleReleaseNotes(Buffer.from(xml), "2.0", undefined, {
        platform: "darwin",
        systemVersion: "26.0"
      })
    ).toBeUndefined();
    expect(
      exactSparkleReleaseNotes(Buffer.from(xml), "2.0", "21", {
        platform: "darwin",
        systemVersion: "26.0"
      })
    ).toMatchObject({ content: "B" });
    expect(
      githubReleaseFromMetadata(
        { url: "https://github.com/example/monorepo/releases/download/other-package@2.0/file.zip" },
        "cask",
        "2.0"
      )
    ).toBeUndefined();
  });
});
