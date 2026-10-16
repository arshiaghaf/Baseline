// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// Temporary PR-288-only artifact capture. Remove before normal CI acceptance.
import { defineConfig } from "@playwright/test";
import path from "node:path";
import comparison from "./playwright.visual.config";

if (process.env.BASELINE_VISUAL_LANE !== "xcode-27")
  throw new Error("Original CI capture requires the explicit xcode-27 lane.");
const directory = path.join(
  process.cwd(),
  "ci-original-capture",
  "xcode-27-macos-27-arm64-software-srgb"
);
export default defineConfig(comparison, {
  metadata: { ...comparison.metadata, visualBaselineDirectory: directory },
  snapshotPathTemplate: `${directory}/{arg}{ext}`
});
