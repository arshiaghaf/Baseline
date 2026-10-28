// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "vite";

/** Bundle with Electron's existing Node runtime, before outer app signing. */
export async function packageCLI(buildPath: string): Promise<void> {
  const directory = path.join(path.dirname(buildPath), "cli");
  await mkdir(path.join(directory, "bin"), { recursive: true });
  await build({
    configFile: false,
    build: {
      outDir: directory,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: path.join(__dirname, "src/cli/main.ts"),
        formats: ["cjs"],
        fileName: () => "cli.cjs"
      },
      rollupOptions: { external: (id) => id.startsWith("node:") }
    }
  });
  const launcher = path.join(directory, "bin/baseline");
  await copyFile(path.join(__dirname, "scripts/baseline"), launcher);
  await chmod(launcher, 0o755);
}
