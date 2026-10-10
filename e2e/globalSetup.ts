// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createPackage, extractAll, extractFile, getRawHeader } from "@electron/asar";
import { signAsync } from "@electron/osx-sign";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { build, loadConfigFromFile, mergeConfig } from "vite";
import { assertIsolatedIntegrityBundle, assertProductionIntegrityBundle } from "./bundleIsolation";
import { localAdHocSigningOptions, verifyMacBundle } from "../macSigning.config";

// Never launch production startup during smoke tests: it can access the host Keychain.
// Instrument only a disposable copy of the packaged build, leaving out/ untouched.
export default async function globalSetup(): Promise<() => Promise<void>> {
  const root = process.cwd();
  const productionApp = path.join(root, "out", `Baseline-darwin-${process.arch}`, "Baseline.app");
  const archivePath = (app: string) => path.join(app, "Contents", "Resources", "app.asar");
  const mainPath = ".vite/build/main.js";
  // Verify the untouched production package before instrumenting the test copy.
  verifyMacBundle(productionApp);
  assertProductionIntegrityBundle(
    extractFile(archivePath(productionApp), mainPath).toString("utf8")
  );

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-app-"));
  const cleanup = () => rm(temporaryDirectory, { recursive: true, force: true });
  try {
    // Cold Swift module compilation can exceed a smoke-test timeout on CI.
    // Compile the public native observer during preflight, before GUI tests.
    const observer = path.join(temporaryDirectory, "native-window-state");
    await promisify(execFile)(
      "/usr/bin/xcrun",
      ["swiftc", path.join(root, "e2e/nativeWindowState.swift"), "-o", observer],
      { timeout: 120_000 }
    );
    process.env.BASELINE_E2E_NATIVE_OBSERVER = observer;
    const fixtureContents = path.join(temporaryDirectory, "FullScreenFixture.app", "Contents");
    await mkdir(path.join(fixtureContents, "MacOS"), { recursive: true });
    await writeFile(
      path.join(fixtureContents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>FullScreenFixture</string>
<key>CFBundleIdentifier</key><string>org.example.baseline.fullscreen-fixture</string>
<key>CFBundleName</key><string>Full-screen fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>\n`
    );
    const fullScreenFixture = path.join(fixtureContents, "MacOS", "FullScreenFixture");
    await promisify(execFile)(
      "/usr/bin/xcrun",
      ["swiftc", path.join(root, "e2e/fullScreenFixture.swift"), "-o", fullScreenFixture],
      { timeout: 120_000 }
    );
    process.env.BASELINE_E2E_FULLSCREEN_FIXTURE = fullScreenFixture;
    if (process.arch === "x64" && process.env.GITHUB_ACTIONS === "true") {
      // Targeted standalone control: no Baseline/Electron process is running.
      // Record native events without changing OS preferences or permissions.
      const probe = await promisify(execFile)(fullScreenFixture, ["--diagnose"], {
        timeout: 20_000
      });
      console.log("Standalone native full-screen probe:", probe.stderr.trim());
      const agent = await promisify(execFile)(
        "/bin/launchctl",
        ["print", `gui/${process.getuid?.()}/com.apple.iconservices.iconservicesagent`],
        { timeout: 5000 }
      ).catch(() => undefined);
      console.log(
        "Runner icon-agent state:",
        agent?.stdout
          .split("\n")
          .filter((line) =>
            /state =|runs =|successive crashes =|last terminating signal =/.test(line)
          )
          .join("\n") ?? "unavailable"
      );
      const windowServices = await promisify(execFile)(
        "/usr/bin/pgrep",
        ["-l", "Dock|WindowServer"],
        { timeout: 5000 }
      ).catch(() => undefined);
      console.log("Runner window services:", windowServices?.stdout.trim() ?? "unavailable");
      const displays = await promisify(execFile)(
        "/usr/sbin/system_profiler",
        ["SPDisplaysDataType"],
        { timeout: 10_000 }
      ).catch(() => undefined);
      console.log("Runner display capability:", displays?.stdout.trim() ?? "unavailable");
    }
    const appDirectory = path.join(temporaryDirectory, "app");
    extractAll(archivePath(productionApp), appDirectory);
    const productionProvider = path.join(root, "src/main/profileStatsIntegrity.ts");
    const fixtureProvider = path.join(root, "e2e/profileStatsIntegrity.ts");
    const productionCommands = path.join(root, "src/main/commandRunner.ts");
    const fixtureCommands = path.join(root, "e2e/commandRunner.ts");
    let fixtureIncluded = false;
    let commandFixtureIncluded = false;
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      path.join(root, "vite.main.config.mts")
    );
    if (!loaded) {
      throw new Error("Could not load the main-process build config.");
    }
    await build(
      mergeConfig(loaded.config, {
        configFile: false,
        mode: "production",
        resolve: {
          alias: [
            { find: "./profileStatsIntegrity", replacement: fixtureProvider },
            { find: "./commandRunner", replacement: fixtureCommands }
          ],
          conditions: ["node"],
          mainFields: ["module", "jsnext:main", "jsnext"]
        },
        define: {
          MAIN_WINDOW_VITE_DEV_SERVER_URL: "undefined",
          MAIN_WINDOW_VITE_NAME: JSON.stringify("main_window")
        },
        plugins: [
          {
            name: "prove-keychain-isolation",
            moduleParsed(module: { id: string }) {
              if (module.id === productionProvider) {
                throw new Error("The production Keychain provider entered the E2E bundle.");
              }
              fixtureIncluded ||= module.id === fixtureProvider;
              if (module.id === productionCommands) {
                throw new Error("The production command runner entered the E2E bundle.");
              }
              commandFixtureIncluded ||= module.id === fixtureCommands;
            }
          }
        ],
        build: {
          outDir: path.join(appDirectory, ".vite/build"),
          emptyOutDir: false,
          copyPublicDir: false,
          minify: true,
          lib: {
            entry: path.join(root, "src/main/main.ts"),
            formats: ["cjs"],
            fileName: () => "main.js"
          },
          rollupOptions: {
            external: [
              "electron",
              "electron/main",
              "electron/common",
              ...builtinModules.flatMap((name) => [name, `node:${name}`])
            ]
          }
        }
      })
    );
    if (!fixtureIncluded) {
      throw new Error("The E2E build did not inject the test integrity provider.");
    }
    if (!commandFixtureIncluded)
      throw new Error("The E2E build did not inject the test command runner.");
    assertIsolatedIntegrityBundle(await readFile(path.join(appDirectory, mainPath), "utf8"));

    const testApp = path.join(temporaryDirectory, "Baseline.app");
    await cp(productionApp, testApp, { recursive: true, verbatimSymlinks: true });
    await rm(archivePath(testApp));
    await createPackage(appDirectory, archivePath(testApp));
    assertIsolatedIntegrityBundle(extractFile(archivePath(testApp), mainPath).toString("utf8"));
    // Keep Electron's archive integrity check valid for the instrumented test copy.
    const archiveHash = createHash("sha256")
      .update(getRawHeader(archivePath(testApp)).headerString)
      .digest("hex");
    await promisify(execFile)("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${archiveHash}`,
      path.join(testApp, "Contents", "Info.plist")
    ]);
    // Re-sign only this disposable copy after changing its archive.
    await signAsync({ app: testApp, platform: "darwin", ...localAdHocSigningOptions() });
    verifyMacBundle(testApp);
    process.env.BASELINE_E2E_APP_DIR = appDirectory;
    process.env.BASELINE_E2E_EXECUTABLE = path.join(testApp, "Contents", "MacOS", "Baseline");
    console.log(
      "E2E preflight: test providers included; production Keychain and command providers excluded."
    );
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
