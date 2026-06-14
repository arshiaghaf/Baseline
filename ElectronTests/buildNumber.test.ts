// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { buildNumberForAppVersion, validBuildNumber } from "../src/shared/buildNumber";

describe("build numbers", () => {
  it("derives public release build numbers from app versions", () => {
    expect(buildNumberForAppVersion("0.1.0")).toBe("10000");
    expect(buildNumberForAppVersion("0.2.0")).toBe("20000");
    expect(buildNumberForAppVersion("0.3.0")).toBe("30000");
    expect(buildNumberForAppVersion("0.3.1")).toBe("30100");
    expect(buildNumberForAppVersion("0.4.0")).toBe("40000");
  });

  it("reserves one-off values between release builds for rebuilt artifacts", () => {
    expect(buildNumberForAppVersion("0.3.0")).toBe("30000");
    expect(validBuildNumber("30001")).toBe("30001");
    expect(buildNumberForAppVersion("0.3.1")).toBe("30100");
  });

  it("keeps pre-1.0 and post-1.0 build numbers monotonic", () => {
    expect(buildNumberForAppVersion("0.3.10")).toBe("31000");
    expect(buildNumberForAppVersion("0.4.0")).toBe("40000");
    expect(buildNumberForAppVersion("1.0.0")).toBe("1000000");
    expect(buildNumberForAppVersion("1.0.1")).toBe("1000100");
    expect(buildNumberForAppVersion("1.1.0")).toBe("1010000");
    expect(buildNumberForAppVersion("3.0.0")).toBe("3000000");
  });

  it("does not derive release build numbers for prerelease or build suffixes", () => {
    expect(buildNumberForAppVersion("0.3.0-beta.1")).toBeUndefined();
    expect(buildNumberForAppVersion("0.3.0+build.1")).toBeUndefined();
  });
});
