// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import base from "./playwright.config";

const baselineSource = "a3292e0b3a5b0735b681eb5f9568023ecbcb9ac2";
if (
  process.argv.some((argument) => argument === "-u" || argument.startsWith("--update-snapshots"))
) {
  // An explicit update is only valid against the original app, including worktree edits.
  execFileSync("git", ["diff", "--exit-code", baselineSource, "--", "src"]);
  if (
    execFileSync("git", ["ls-files", "--others", "--exclude-standard", "src"], {
      encoding: "utf8"
    }).trim()
  ) {
    throw new Error("Refusing baseline capture with untracked application source.");
  }
}
const macOS =
  process.platform === "darwin"
    ? execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" })
        .trim()
        .split(".")[0]
    : "unsupported";
const lane = process.env.BASELINE_VISUAL_LANE;
if (lane && lane !== "xcode-27") throw new Error(`Unknown visual lane: ${lane}`);
const directory = path.join(
  process.cwd(),
  "e2e",
  "visual-baselines",
  `${lane ? `${lane}-` : ""}macos-${macOS}-${process.arch}-software-srgb`
);

// System fonts and native rasterization belong to a named platform lane.
// Keep smoke coverage on every CI runner; compare pixels on xcode-27 only.
export default defineConfig(base, {
  globalSetup: "./e2e/visualSetup.ts",
  testIgnore: [],
  testMatch: "renderer-visual.spec.ts",
  workers: 1,
  timeout: 120_000,
  retries: 0,
  updateSnapshots: "none",
  metadata: { visualLane: lane ?? "local", visualBaselineDirectory: directory },
  snapshotPathTemplate: `${directory}/{arg}{ext}`,
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      // Original-source repeats vary by up to 3/255 in a few disclosure-edge
      // channels. Permit only tiny per-pixel color rounding, no changed pixels.
      threshold: 0.01,
      maxDiffPixels: 0
    }
  }
});
