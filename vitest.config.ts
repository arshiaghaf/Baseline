// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["ElectronTests/setup.ts"],
    include: ["ElectronTests/**/*.test.ts", "ElectronTests/**/*.test.tsx"]
  }
});
