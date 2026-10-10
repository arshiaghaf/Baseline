// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { isAffectedFullScreenImage, nativeFullScreenSkipReason } from "../e2e/fullScreenCapability";

const healthy = { healthyWindow: true, transitionStarted: true, fullScreen: true };
const metadata = (image: string, version: string) =>
  JSON.stringify([{ group: "Runner Image", detail: `Image: ${image}\nVersion: ${version}` }]);

describe("native full-screen capability exception", () => {
  it("applies only to the exact affected image, keeping other images strict", () => {
    expect(isAffectedFullScreenImage(metadata("macos-26", "20260824.0517.1"))).toBe(true);
    for (const [image, version] of [
      ["macos-15", "20260824.0517.1"],
      ["macos-26-arm64", "20260824.0517.1"],
      ["macos-26", "20260824.0517.2"],
      ["macos-26", "20261010.1"]
    ]) {
      expect(isAffectedFullScreenImage(metadata(image!, version!))).toBe(false);
    }
  });

  it("keeps the full regression enabled when the native probe succeeds", () => {
    expect(
      nativeFullScreenSkipReason(JSON.stringify({ ...healthy, status: "completed" }))
    ).toBeUndefined();
  });

  it("permits the exception for the healthy known stall", () => {
    expect(
      nativeFullScreenSkipReason(JSON.stringify({ ...healthy, status: "stalled" }))
    ).toBeDefined();
  });

  it("fails unexpected window, session, or native transition preconditions", () => {
    for (const field of Object.keys(healthy)) {
      expect(() =>
        nativeFullScreenSkipReason(
          JSON.stringify({ ...healthy, [field]: false, status: "stalled" })
        )
      ).toThrow("preconditions failed");
    }
  });

  it("fails unknown or malformed probe and image results instead of skipping", () => {
    for (const result of ["", "null", "[]", JSON.stringify({ ...healthy, status: "failed" })]) {
      expect(() => nativeFullScreenSkipReason(result)).toThrow();
    }
    for (const image of ["", "null", "{}", "[]"]) {
      expect(() => isAffectedFullScreenImage(image)).toThrow();
    }
  });
});
