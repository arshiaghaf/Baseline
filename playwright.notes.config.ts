// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { defineConfig } from "@playwright/test";

// Read-only hidden Electron validation never activates an app or changes the user's desktop.
export default defineConfig({
  testDir: "e2e",
  testMatch: "release-notes-preview.spec.ts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]]
});
