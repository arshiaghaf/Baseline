// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { buildNumberForAppVersion, validBuildNumber } from "../src/shared/buildNumber";

describe("build numbers", () => {
  it("derives public release build numbers from app versions", () => {
    expect(buildNumberForAppVersion("0.1.0")).toBe("100");
    expect(buildNumberForAppVersion("0.2.0")).toBe("200");
    expect(buildNumberForAppVersion("0.3.0")).toBe("300");
    expect(buildNumberForAppVersion("0.3.1")).toBe("310");
    expect(buildNumberForAppVersion("0.4.0")).toBe("400");
  });

  it("reserves one-off values between release builds for rebuilt artifacts", () => {
    expect(buildNumberForAppVersion("0.3.0")).toBe("300");
    expect(validBuildNumber("301")).toBe("301");
    expect(buildNumberForAppVersion("0.3.1")).toBe("310");
  });

  it("keeps pre-1.0 and post-1.0 build numbers monotonic", () => {
    expect(buildNumberForAppVersion("1.0.0")).toBe("10000");
    expect(buildNumberForAppVersion("1.0.1")).toBe("10010");
    expect(buildNumberForAppVersion("1.1.0")).toBe("10100");
  });
});
