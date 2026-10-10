// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// Retire this exact-image exception after a fixed GitHub image passes the native
// probe and full regression. Newer images and successful probes are never skipped.
export function isAffectedFullScreenImage(metadata: string): boolean {
  const groups: unknown = JSON.parse(metadata);
  if (!Array.isArray(groups)) throw new Error("Unknown GitHub runner image metadata.");
  const image: unknown = groups.find((group) => group?.group === "Runner Image")?.detail;
  if (typeof image !== "string") throw new Error("Missing GitHub runner image identity.");
  return /^Image: macos-26\nVersion: 20260824\.0517\.1$/m.test(image);
}

export function nativeFullScreenSkipReason(output: string): string | undefined {
  const probe: unknown = JSON.parse(output);
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
    throw new Error("Invalid native full-screen probe result.");
  }
  const result = probe as Record<string, unknown>;
  if (
    result.healthyWindow !== true ||
    result.transitionStarted !== true ||
    result.fullScreen !== true
  ) {
    throw new Error(`Native full-screen probe preconditions failed: ${output.trim()}`);
  }
  if (result.status === "completed") return undefined;
  if (result.status !== "stalled") {
    throw new Error(`Unknown native full-screen probe outcome: ${output.trim()}`);
  }
  return (
    "Full-screen regression unverified on GitHub macos-26-intel image 20260824.0517.1: " +
    "the independent AppKit probe stalled with healthy native window preconditions. " +
    "Only this test is skipped; successful probes run its full assertions. Evidence: " +
    "https://github.com/arshiaghaf/Baseline/actions/runs/38087651079/job/114317409490. " +
    "Image report: https://github.com/actions/runner-images/issues/14773."
  );
}
