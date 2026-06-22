// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  brewExecutableCandidates,
  isAllowedExternalURL,
  isAllowedFeedURL,
  isValidHomebrewToken,
  masExecutableCandidates,
  resolvedExecutablePath
} from "../src/shared/security";

describe("security policy", () => {
  it("allows only https external URLs", () => {
    expect(isAllowedExternalURL("https://example.com")).toBe(true);
    expect(isAllowedExternalURL("http://example.com")).toBe(false);
    expect(isAllowedExternalURL("file:///tmp/test")).toBe(false);
    expect(isAllowedExternalURL("custom-scheme://example.com")).toBe(false);
  });

  it("rejects local and private feed hosts", () => {
    expect(isAllowedFeedURL("https://localhost/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://localhost./feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://updates.local/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://updates.local./feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://local/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://127.0.0.1/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://127.0.0.1./feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://10.0.0.4/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://192.168.1.10/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://0.0.0.0/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::ffff:127.0.0.1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::ffff:10.0.0.4]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::ffff:192.168.1.10]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::ffff:0:127.0.0.1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::ffff:0:a00:4]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::127.0.0.1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::7f00:1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::10.0.0.4]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::a00:4]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[64:ff9b::127.0.0.1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[64:ff9b::7f00:1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[fe80::1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[fe90::1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[fea0::1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[febf::1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[fc00::1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[fdff::1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[2001:4860:4860::8888]/feed.xml")).toBe(true);
    expect(isAllowedFeedURL("https://[::ffff:0:808:808]/feed.xml")).toBe(true);
    expect(isAllowedFeedURL("https://updates.example.com/appcast.xml")).toBe(true);
  });

  it("validates Homebrew tokens", () => {
    expect(isValidHomebrewToken("notion")).toBe(true);
    expect(isValidHomebrewToken("figma@beta")).toBe(true);
    expect(isValidHomebrewToken("python@3.12")).toBe(true);
    expect(isValidHomebrewToken("owner/repo/formula")).toBe(true);
    expect(isValidHomebrewToken("--notion")).toBe(false);
    expect(isValidHomebrewToken("bad token")).toBe(false);
    expect(isValidHomebrewToken("Owner/repo/formula")).toBe(false);
  });

  it("resolves only absolute known executable candidates", () => {
    expect(brewExecutableCandidates()).toEqual(["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]);
    expect(masExecutableCandidates()).toEqual(["/opt/homebrew/bin/mas", "/usr/local/bin/mas"]);

    expect(
      resolvedExecutablePath(
        ["brew", "/usr/bin/env", "/opt/homebrew/bin/brew"],
        (candidate) => candidate === "/opt/homebrew/bin/brew"
      )
    ).toBe("/opt/homebrew/bin/brew");
    expect(resolvedExecutablePath(["brew", "/usr/bin/env"], () => true)).toBeUndefined();
  });
});
