// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { signedSelfUpdateConfiguration, signedUpdateFeedURL } from "./src/shared/signedSelfUpdate";
import upstream from "./native/self-updater/upstream.json";
import publisher from "./native/self-updater/publisher.json";

export function releaseSelfUpdateConfiguration(env = process.env) {
  const enabled = env.BASELINE_ENABLE_SIGNED_UPDATES ?? (publisher.enabled ? "1" : "0");
  if (enabled === "0") return undefined;
  if (enabled !== "1") throw new Error("Invalid signed-update build setting.");
  const configuration = signedSelfUpdateConfiguration({
    enabled: true,
    publicKey: env.BASELINE_SELF_UPDATE_PUBLIC_KEY ?? publisher.publicKey,
    feedURL: signedUpdateFeedURL
  });
  if (!configuration)
    throw new Error("Signed updates require an approved Ed25519 publisher public key.");
  return configuration;
}

export function selfUpdateInfo(configuration = releaseSelfUpdateConfiguration()) {
  return configuration
    ? {
        BaselineSignedUpdatesEnabled: true,
        SUPublicEDKey: configuration.publicKey,
        SUFeedURL: configuration.feedURL,
        SUVerifyUpdateBeforeExtraction: true,
        SURequireSignedFeed: true,
        SUSignedFeedFailureExpirationInterval: 0,
        SUEnableAutomaticChecks: false,
        SUAutomaticallyUpdate: false,
        SUAllowsAutomaticUpdates: false,
        SUEnableSystemProfiling: false
      }
    : {};
}

/** Invoked before Packager signs the outer app; this never launches anything. */
export async function packageSelfUpdater(buildPath: string, sourceRoot = __dirname): Promise<void> {
  const configuration = releaseSelfUpdateConfiguration();
  if (!configuration) return;
  const cache = path.join(sourceRoot, "node_modules/.cache/baseline-sparkle", upstream.version);
  const archive = await readFile(path.join(cache, "Sparkle.tar.xz"));
  if (createHash("sha256").update(archive).digest("hex") !== upstream.sha256)
    throw new Error("Sparkle archive failed verification. Run npm run prepare:sparkle.");
  // Re-extract into private packaging output, rather than trusting mutable extracted cache bytes.
  const staging = await mkdtemp(path.join(buildPath, ".sparkle-staging-"));
  try {
    execFileSync("/usr/bin/tar", ["-xJf", "-", "-C", staging], { input: archive });
    const contents = path.resolve(buildPath, "../..");
    await mkdir(path.join(contents, "Frameworks"), { recursive: true });
    await cp(
      path.join(staging, "Sparkle.framework"),
      path.join(contents, "Frameworks/Sparkle.framework"),
      { recursive: true, verbatimSymlinks: true }
    );
    const helper = path.join(contents, "Helpers/Baseline Updater.app/Contents");
    await mkdir(path.join(helper, "MacOS"), { recursive: true });
    await buildSelfUpdater(
      path.join(helper, "MacOS/Baseline Updater"),
      path.join(staging, "Sparkle.framework"),
      sourceRoot
    );
    const plist = {
      CFBundleIdentifier: "com.arshiaghaf.baseline.updater",
      CFBundleName: "Baseline Updater",
      CFBundleExecutable: "Baseline Updater",
      CFBundlePackageType: "APPL",
      CFBundleVersion: "1",
      LSMinimumSystemVersion: "15.0",
      LSUIElement: true,
      NSPrincipalClass: "NSApplication"
    };
    const plistPath = path.join(helper, "Info.plist");
    await writeFile(plistPath, JSON.stringify(plist));
    execFileSync("/usr/bin/plutil", ["-convert", "xml1", plistPath]);
    await writeFile(
      path.join(path.dirname(buildPath), "self-update.json"),
      JSON.stringify(configuration)
    );
    await cp(path.join(staging, "LICENSE"), path.join(path.dirname(buildPath), "Sparkle-LICENSE"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function buildSelfUpdater(
  destination: string,
  framework: string,
  sourceRoot = __dirname,
  fixture?: { bundleIdentifier: string; feedURL: string }
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const fixtureArguments: string[] = [];
  if (fixture) {
    if (
      !/^org\.example\.baselinefixture\.[a-z0-9]+$/.test(fixture.bundleIdentifier) ||
      !/^http:\/\/127\.0\.0\.1:\d+\/appcast\.xml$/.test(fixture.feedURL)
    )
      throw new Error("Invalid isolated updater fixture configuration.");
    fixtureArguments.push(
      "-DBASELINE_SELF_UPDATE_FIXTURE=1",
      `-DBASELINE_UPDATE_HOST_IDENTIFIER=@"${fixture.bundleIdentifier}"`,
      `-DBASELINE_UPDATE_FEED_URL=@"${fixture.feedURL}"`,
      "-I",
      path.join(sourceRoot, "ElectronTests/Fixtures"),
      path.join(sourceRoot, "ElectronTests/Fixtures/selfUpdaterDriver.m")
    );
  }
  execFileSync(
    "/usr/bin/xcrun",
    [
      "--sdk",
      "macosx",
      "clang",
      "-arch",
      "arm64",
      "-mmacosx-version-min=15.0",
      "-fobjc-arc",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-F",
      path.dirname(framework),
      "-framework",
      "Foundation",
      "-framework",
      "AppKit",
      "-framework",
      "Security",
      "-lproc",
      "-framework",
      "Sparkle",
      "-Wl,-rpath,@executable_path/../../../../Frameworks",
      path.join(sourceRoot, "native/self-updater/main.m"),
      path.join(sourceRoot, "native/self-updater/installGateDriver.m"),
      ...fixtureArguments,
      "-o",
      destination
    ],
    { stdio: "pipe" }
  );
}
