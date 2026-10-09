// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment node

import { signAsync } from "@electron/osx-sign";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localAdHocSigningOptions, verifyMacBundle } from "../macSigning.config";

describe.skipIf(process.platform !== "darwin")("real ad-hoc resource seals", () => {
  let temporaryDirectory: string;
  let app: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "baseline-signing-fixture-"));
    app = path.join(temporaryDirectory, "Fixture.app");
    for (const [bundle, identifier] of [
      [app, "org.example.signing-fixture"],
      [
        path.join(app, "Contents/Frameworks/Fixture Helper.app"),
        "org.example.signing-fixture.helper"
      ]
    ]) {
      const contents = path.join(bundle!, "Contents");
      await mkdir(path.join(contents, "MacOS"), { recursive: true });
      await mkdir(path.join(contents, "Resources"), { recursive: true });
      await copyFile("/usr/bin/true", path.join(contents, "MacOS/Fixture"));
      await chmod(path.join(contents, "MacOS/Fixture"), 0o755);
      await writeFile(
        path.join(contents, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`
      );
      await writeFile(path.join(contents, "Resources/fixture.txt"), "sealed fixture");
    }
    await signAsync({ app, platform: "darwin", ...localAdHocSigningOptions() });
  });

  afterEach(async () => {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("verifies the outer app and nested helper", () => {
    expect(() => verifyMacBundle(app)).not.toThrow();
  });

  it.each([
    "Resources/fixture.txt",
    "Info.plist",
    "Frameworks/Fixture Helper.app/Contents/Resources/fixture.txt"
  ])("rejects changed %s", async (relativePath) => {
    await writeFile(path.join(app, "Contents", relativePath), "tampered");
    expect(() => verifyMacBundle(app)).toThrow();
  });
});
