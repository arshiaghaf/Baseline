// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import {
  fetchReleaseNotes,
  isPublicNotesAddress,
  publicNotesURL
} from "../src/main/releaseNotesFetch";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));

type Reply = { status?: number; headers?: Record<string, string>; body?: Buffer | string };
let replies: Reply[];

beforeEach(() => {
  vi.resetAllMocks();
  replies = [];
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  vi.mocked(request).mockImplementation(((
    _url: unknown,
    _options: unknown,
    callback: (response: PassThrough) => void
  ) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    req.destroy = () => undefined;
    req.end = () =>
      queueMicrotask(() => {
        const reply = replies.shift() ?? {};
        const res = new PassThrough() as PassThrough & {
          statusCode: number;
          headers: Record<string, string>;
        };
        res.statusCode = reply.status ?? 200;
        res.headers = reply.headers ?? { "content-type": "text/plain" };
        callback(res);
        res.end(reply.body ?? "Release notes");
      });
    return req;
  }) as never);
});

describe("public release-notes transport", () => {
  it.each([
    "http://example.org/notes",
    "https://user:secret@example.org/notes",
    "https://localhost/notes",
    "https://127.1/notes",
    "https://[::ffff:127.0.0.1]/notes",
    "https://example.org:8443/notes"
  ])("rejects unsafe or credential-bearing URLs before DNS: %s", async (url) => {
    expect(publicNotesURL(url)).toBeUndefined();
    await expect(fetchReleaseNotes(url)).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "192.168.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:0000:1::1",
    "2001:db8::1",
    "2002:c0a8:1::1"
  ])("rejects nonpublic DNS answers: %s", async (address) => {
    expect(isPublicNotesAddress(address)).toBe(false);
    vi.mocked(lookup).mockResolvedValue([
      { address, family: address.includes(":") ? 6 : 4 }
    ] as never);
    await expect(fetchReleaseNotes("https://publisher.example.org/notes")).rejects.toThrow(
      "Unsafe release notes destination"
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects mixed public/private DNS and pins the accepted address without a second resolution", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ] as never);
    await expect(fetchReleaseNotes("https://publisher.example.org/notes")).rejects.toThrow();
    const value = await fetchReleaseNotes("https://publisher.example.org/notes");
    expect(value.data.toString()).toBe("Release notes");
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(request).mock.calls[0] as unknown as [
      URL,
      { family: number; lookup: (...args: unknown[]) => void }
    ];
    expect(url.hostname).toBe("publisher.example.org");
    expect(options.family).toBe(4);
    const pinned = vi.fn();
    options.lookup("publisher.example.org", {}, pinned);
    expect(pinned).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("validates every redirect before making the next request", async () => {
    replies = [{ status: 302, headers: { location: "https://127.0.0.1/private" } }];
    await expect(fetchReleaseNotes("https://publisher.example.org/notes")).rejects.toThrow(
      "Unsafe release notes redirect"
    );
    expect(request).toHaveBeenCalledTimes(1);
    replies = [
      { status: 302, headers: { location: "https://cdn.example.org/notes" } },
      { body: "Correct notes" }
    ];
    expect((await fetchReleaseNotes("https://publisher.example.org/notes")).url).toBe(
      "https://cdn.example.org/notes"
    );
    expect(lookup).toHaveBeenLastCalledWith("cdn.example.org", { all: true, verbatim: true });
  });

  it("bounds both encoded and decompressed content", async () => {
    replies = [{ body: "x".repeat(100) }];
    await expect(
      fetchReleaseNotes("https://publisher.example.org/notes", { maxBytes: 20 })
    ).rejects.toThrow("too large");
    replies = [{ headers: { "content-encoding": "gzip" }, body: gzipSync("x".repeat(10_000)) }];
    await expect(
      fetchReleaseNotes("https://publisher.example.org/notes", { maxBytes: 100 })
    ).rejects.toThrow("too large");
  });

  it("stops a cancelled request before DNS or network access", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchReleaseNotes("https://publisher.example.org/notes", { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(lookup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
