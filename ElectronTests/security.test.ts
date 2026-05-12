import { describe, expect, it } from "vitest";
import {
  isAllowedExternalURL,
  isAllowedFeedURL,
  isValidHomebrewToken
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
    expect(isAllowedFeedURL("https://127.0.0.1/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://10.0.0.4/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://192.168.1.10/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://0.0.0.0/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::ffff:127.0.0.1]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::ffff:10.0.0.4]/feed.xml")).toBe(false);
    expect(isAllowedFeedURL("https://[::ffff:192.168.1.10]/feed.xml")).toBe(false);
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
});
