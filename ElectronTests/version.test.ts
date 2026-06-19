// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { compareVersions, isVersionGreater, version } from "../src/shared/version";

describe("version comparison", () => {
  it("normalizes numeric version components", () => {
    expect(isVersionGreater(version("1.2.10"), version("1.2.2"))).toBe(true);
    expect(isVersionGreater(version("v3-beta"), version("2"))).toBe(true);
    expect(compareVersions(version("1.0"), version("1.0.0"))).toBe(0);
    expect(compareVersions(version(undefined), version(""))).toBe(0);
  });

  it("orders prerelease suffixes before matching stable releases", () => {
    expect(compareVersions(version("1.0.0"), version("1.0.0-beta.2"))).toBeGreaterThan(0);
    expect(compareVersions(version("1.0.0-beta.2"), version("1.0.0"))).toBeLessThan(0);
    expect(compareVersions(version("2.0"), version("2.0-rc.1"))).toBeGreaterThan(0);
    expect(compareVersions(version("2.0-rc.1"), version("2.0"))).toBeLessThan(0);
    expect(compareVersions(version("1.0.0-rc.1"), version("1.0.0-beta.9"))).toBeGreaterThan(0);
    expect(compareVersions(version("1.0.0-beta.10"), version("1.0.0-beta.2"))).toBeGreaterThan(0);
  });
});
