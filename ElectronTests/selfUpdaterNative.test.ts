// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { packageSelfUpdater, selfUpdateInfo } from "../selfUpdatePackaging.config";
import { signedUpdateFeedURL } from "../src/shared/signedSelfUpdate";
import upstream from "../native/self-updater/upstream.json";

const framework = path.resolve(
  "node_modules/.cache/baseline-sparkle",
  upstream.version,
  "upstream/Sparkle.framework"
);
describe.skipIf(
  process.platform !== "darwin" || process.arch !== "arm64" || !existsSync(framework)
)("native Sparkle configuration guards without a signing key, GUI or network check", () => {
  let temporary: string;
  let host: string;
  let executable: string;
  const defaults = {
    CFBundleIdentifier: "com.arshiaghaf.baseline",
    CFBundleName: "Fixture",
    CFBundleVersion: "10000",
    CFBundlePackageType: "APPL"
  };
  beforeAll(async () => {
    temporary = await mkdtemp("/tmp/baseline-sparkle-guard-");
    host = path.join(temporary, "Fixture.app/Contents");
    const helper = path.join(host, "Helpers/Baseline Updater.app/Contents");
    executable = path.join(helper, "MacOS/Baseline Updater");
    const buildPath = path.join(host, "Resources/app");
    await mkdir(buildPath, { recursive: true });
    // Public parsing fixture only. This temporary bundle never performs an update check.
    vi.stubEnv("BASELINE_ENABLE_SIGNED_UPDATES", "1");
    vi.stubEnv("BASELINE_SELF_UPDATE_PUBLIC_KEY", "pfIShU4dEXqPd5ObYNfDBiQWcXozk7estwzTnF9BamQ=");
    try {
      await packageSelfUpdater(buildPath, process.cwd());
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await readdir(buildPath)).some((name) => name.startsWith(".sparkle-staging"))).toBe(
      false
    );
    expect(await readFile(path.join(host, "Resources/Sparkle-LICENSE"), "utf8")).toContain(
      "Copyright"
    );
  }, 90000);
  afterAll(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });
  async function info(extra: Record<string, unknown>) {
    const file = path.join(host, "Info.plist");
    await writeFile(file, JSON.stringify({ ...defaults, ...extra }));
    execFileSync("/usr/bin/plutil", ["-convert", "xml1", file]);
  }
  it("builds an ARM helper that refuses disabled configuration before AppKit initialization", async () => {
    expect(execFileSync("/usr/bin/lipo", ["-archs", executable], { encoding: "utf8" }).trim()).toBe(
      "arm64"
    );
    await info({});
    for (const args of [
      ["--validate-config"],
      ["--check"],
      ["--check", "/Applications/Other.app"]
    ]) {
      const result = spawnSync(executable, args, { encoding: "utf8", timeout: 3000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('{"event":"disabled"}\n');
    }
  });
  it("validates public fixture configuration but refuses a check from another parent process", async () => {
    await info({
      ...selfUpdateInfo({
        enabled: true,
        feedURL: signedUpdateFeedURL,
        publicKey: "pfIShU4dEXqPd5ObYNfDBiQWcXozk7estwzTnF9BamQ="
      })
    });
    const diagnostic = spawnSync(executable, ["--validate-config"], {
      encoding: "utf8",
      timeout: 3000
    });
    expect(diagnostic.status).toBe(0);
    expect(diagnostic.stdout).toBe('{"event":"configured"}\n');
    const check = spawnSync(executable, ["--check"], { encoding: "utf8", timeout: 3000 });
    expect(check.status).toBe(2);
    expect(check.stdout).toBe('{"event":"disabled"}\n');
  });

  it.each([
    { SUPublicEDKey: "" },
    { SUPublicEDKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    { SURequireSignedFeed: false },
    { SUVerifyUpdateBeforeExtraction: false },
    { SUAutomaticallyUpdate: true },
    { SUSignedFeedFailureExpirationInterval: 20 },
    { SUFeedURL: "https://example.com/appcast.xml" },
    { CFBundleIdentifier: "com.example.other" }
  ])("refuses weakened or mismatched trust configuration %j", async (change) => {
    // Existing public documentation key: parsing only, no private key or update check.
    await info({
      ...selfUpdateInfo({
        enabled: true,
        feedURL: signedUpdateFeedURL,
        publicKey: "pfIShU4dEXqPd5ObYNfDBiQWcXozk7estwzTnF9BamQ="
      }),
      ...change
    });
    const result = spawnSync(executable, ["--validate-config"], {
      encoding: "utf8",
      timeout: 3000
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('{"event":"disabled"}\n');
  });
});
