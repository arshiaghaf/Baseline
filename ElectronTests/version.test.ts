import { describe, expect, it } from "vitest";
import { compareVersions, isVersionGreater, version } from "../src/shared/version";

describe("version comparison", () => {
  it("matches the Swift numeric component behavior", () => {
    expect(isVersionGreater(version("1.2.10"), version("1.2.2"))).toBe(true);
    expect(isVersionGreater(version("v3-beta"), version("2"))).toBe(true);
    expect(compareVersions(version("1.0"), version("1.0.0"))).toBe(0);
    expect(compareVersions(version(undefined), version(""))).toBe(0);
  });
});
