// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { extractFile, listPackage } from "@electron/asar";
import type { FullConfig } from "@playwright/test";
import ViteConfigGenerator from "@electron-forge/plugin-vite/dist/ViteConfig";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import setup from "./globalSetup";

const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export default async function visualSetup(config: FullConfig): Promise<() => Promise<void>> {
  const root = process.cwd();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "baseline-renderer-proof-"));
  try {
    // Rebuild with Forge's own renderer config and compare every shipped byte.
    // This rejects a stale package even when the working tree has the expected source.
    const generator = new ViteConfigGenerator(
      { build: [], renderer: [{ name: "main_window", config: "vite.renderer.config.mts" }] },
      root,
      true
    );
    const rendererConfig = (await generator.getRendererConfig())[0];
    if (!rendererConfig) throw new Error("Missing Forge renderer build configuration.");
    await build({
      ...rendererConfig,
      configFile: false,
      build: { ...rendererConfig.build, outDir: temporary, emptyOutDir: true }
    });
    const archive = path.join(
      root,
      "out",
      `Baseline-darwin-${process.arch}`,
      "Baseline.app",
      "Contents",
      "Resources",
      "app.asar"
    );
    const prefix = "/.vite/renderer/main_window/";
    const packaged = listPackage(archive, { isPack: false }).filter(
      (file) => file.startsWith(prefix) && !file.endsWith(".map")
    );
    const fresh: Record<string, string> = {};
    const collect = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(absolute);
        else if (!entry.name.endsWith(".map"))
          fresh[path.relative(temporary, absolute)] = digest(await readFile(absolute));
      }
    };
    await collect(temporary);
    const packageHashes: Record<string, string> = {};
    for (const file of packaged) {
      const relative = file.slice(prefix.length);
      if (!(relative in fresh)) {
        // listPackage also includes directories; reject every unexpected file.
        if (Object.keys(fresh).some((name) => name.startsWith(`${relative}/`))) continue;
        throw new Error(`Unexpected packaged renderer file: ${relative}. Run npm run build.`);
      }
      packageHashes[relative] = digest(extractFile(archive, file.slice(1)));
      if (packageHashes[relative] !== fresh[relative])
        throw new Error(
          `Packaged renderer differs from current source: ${relative}. Run npm run build.`
        );
    }
    if (Object.keys(fresh).length !== Object.keys(packageHashes).length)
      throw new Error("Packaged renderer has missing files. Run npm run build.");
    const sourceFiles = execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
      .trim()
      .split("\n");
    const sourceHashes = Object.fromEntries(
      await Promise.all(
        sourceFiles.map(async (file) => [file, digest(await readFile(path.join(root, file)))])
      )
    );
    const provenance = {
      schemaVersion: 1,
      baselineSource: "a3292e0b3a5b0735b681eb5f9568023ecbcb9ac2",
      checkoutCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      rendererTree: execFileSync("git", ["rev-parse", "HEAD:src/renderer"], {
        encoding: "utf8"
      }).trim(),
      sourceHash: digest(JSON.stringify(sourceHashes)),
      rendererFiles: packageHashes,
      rendererHash: digest(JSON.stringify(packageHashes)),
      node: process.version,
      architecture: process.arch,
      macOS: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
      macOSBuild: execFileSync("/usr/bin/sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim(),
      kernel: os.release(),
      visualLane: config.metadata.visualLane,
      configuration: path.basename(config.configFile ?? ""),
      runner: {
        imageOS: process.env.ImageOS,
        imageVersion: process.env.ImageVersion,
        os: process.env.RUNNER_OS,
        architecture: process.env.RUNNER_ARCH,
        runID: process.env.GITHUB_RUN_ID,
        commit: process.env.GITHUB_SHA
      },
      toolFiles: Object.fromEntries(
        await Promise.all(
          [
            "package-lock.json",
            "playwright.visual.config.ts",
            "e2e/renderer-visual.spec.ts",
            "e2e/visualSnapshot.ts",
            "e2e/visualSetup.ts",
            ".github/workflows/ci.yml"
          ].map(async (file) => [file, digest(await readFile(path.join(root, file)))])
        )
      ),
      capturedAt: new Date().toISOString()
    };
    process.env.BASELINE_VISUAL_PROVENANCE = JSON.stringify(provenance);
    if (
      process.argv.some(
        (argument) => argument === "-u" || argument.startsWith("--update-snapshots")
      )
    ) {
      const directory = config.metadata.visualBaselineDirectory as string;
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "provenance.json"),
        `${JSON.stringify(provenance, null, 2)}\n`
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return setup();
}
