// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BundleScannerClient, testingExports } from "../src/main/bundleScanner";

const electronMocks = vi.hoisted(() => ({
  getFileIcon: vi.fn(async () => ({
    isEmpty: () => true,
    resize: () => ({ toDataURL: () => "" })
  })),
  createFromPath: vi.fn(() => ({
    isEmpty: () => true,
    resize: () => ({ toDataURL: () => "" })
  }))
}));

vi.mock("electron", () => ({
  app: {
    getFileIcon: electronMocks.getFileIcon
  },
  nativeImage: {
    createFromPath: electronMocks.createFromPath
  }
}));

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirs = [];
  electronMocks.getFileIcon.mockClear();
  electronMocks.createFromPath.mockClear();
  testingExports.resetIconRuntime();
});

describe("bundle scanner", () => {
  it("recursively finds apps without descending into app bundles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    await writeAppPlist(path.join(root, "Direct.app"), {
      displayName: "Direct",
      bundleIdentifier: "com.example.direct",
      version: "1.0.0"
    });
    await writeAppPlist(path.join(root, "Vendor", "Nested.app"), {
      displayName: "Nested",
      bundleIdentifier: "com.example.nested",
      version: "2.0.0"
    });
    await writeAppPlist(
      path.join(root, "Vendor", "Nested.app", "Contents", "PlugIns", "Hidden.app"),
      {
        displayName: "Hidden",
        bundleIdentifier: "com.example.hidden",
        version: "3.0.0"
      }
    );

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records.map((record) => record.displayName)).toEqual(["Direct", "Nested"]);
    expect(records.map((record) => record.bundleIdentifier)).toEqual([
      "com.example.direct",
      "com.example.nested"
    ]);
  });

  it("ignores Safari web app bundles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    await writeAppPlist(path.join(root, "GitHub.app"), {
      displayName: "GitHub",
      bundleIdentifier: "com.apple.Safari.WebApp.96B22158-BAD1-44DA-880D-913DB7E56FC7",
      version: "1.0.0",
      extraKeys: [
        "  <key>LSTemplateApplication</key>",
        "  <true/>",
        "  <key>LSTemplateApplicationParameters</key>",
        "  <dict>",
        "    <key>CFBundleIdentifier</key>",
        "    <string>com.apple.Safari.WebApp</string>",
        "  </dict>",
        "  <key>WKManifestURL</key>",
        "  <string>https://github.com/manifest.json</string>",
        "  <key>Manifest</key>",
        "  <dict>",
        "    <key>name</key>",
        "    <string>GitHub</string>",
        "  </dict>"
      ].join("\n")
    });

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records).toEqual([]);
  });

  it("keeps normal app bundles that contain a generic manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    await writeAppPlist(path.join(root, "Manifested.app"), {
      displayName: "Manifested",
      bundleIdentifier: "com.example.manifested",
      version: "1.0.0",
      extraKeys: [
        "  <key>Manifest</key>",
        "  <dict>",
        "    <key>name</key>",
        "    <string>Manifested</string>",
        "  </dict>"
      ].join("\n")
    });

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records.map((record) => record.displayName)).toEqual(["Manifested"]);
  });

  it("keeps the bundle build version alongside the marketing version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    await writeAppPlist(path.join(root, "Build Versioned.app"), {
      displayName: "Build Versioned",
      bundleIdentifier: "com.example.build-versioned",
      version: "1.0",
      extraKeys: ["  <key>CFBundleVersion</key>", "  <string>100</string>"].join("\n")
    });

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      displayName: "Build Versioned",
      localVersion: { raw: "1.0" },
      bundleVersion: { raw: "100" }
    });
  });

  it("detects grayscale icon conversion output", () => {
    expect(testingExports.isGrayscaleSipsOutput("  space: Gray\n")).toBe(true);
    expect(testingExports.isGrayscaleSipsOutput("  space: RGB\n")).toBe(false);
    expect(testingExports.isGrayscaleSipsOutput("  profile: Generic Gray Gamma 2.2\n")).toBe(false);
  });

  it("limits grayscale padding candidates to generic Electron bundle icons", () => {
    expect(
      testingExports.isGenericElectronIconName("/Applications/Example.app/electron.icns")
    ).toBe(true);
    expect(
      testingExports.isGenericElectronIconName("/Applications/Example.app/Electron.icns")
    ).toBe(true);
    expect(testingExports.isGenericElectronIconName("/Applications/Example.app/Custom.icns")).toBe(
      false
    );
  });

  it("uses the padded raster output for grayscale generic Electron bundle icons", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);
    const iconPath = path.join(root, "Contents", "Resources", "electron.icns");

    testingExports.iconRuntime.execFileAsync = vi.fn(async (file: string, args: string[]) => {
      const execArgs = args;

      if (file !== "/usr/bin/sips") {
        throw new Error(`Unexpected executable: ${file}`);
      }

      if (execArgs.includes("-s") && execArgs.includes("format")) {
        const outputPath = execArgs.at(-1);
        await writeFile(String(outputPath), "converted png");
        return { stdout: "", stderr: "" };
      }

      if (execArgs.includes("-g") && execArgs.includes("space")) {
        return { stdout: `${execArgs.at(-1)}\n  space: Gray\n`, stderr: "" };
      }

      if (execArgs.includes("-z")) {
        const outputPath = execArgs.at(-1);
        await writeFile(String(outputPath), "resized png");
        return { stdout: "", stderr: "" };
      }

      if (execArgs.includes("--padToHeightWidth")) {
        const outputPath = execArgs.at(-1);
        await writeFile(String(outputPath), "padded png");
        return { stdout: "", stderr: "" };
      }

      throw new Error(`Unexpected sips arguments: ${execArgs.join(" ")}`);
    });
    testingExports.iconRuntime.createFromPath = vi.fn((imagePath: string) => ({
      isEmpty: () => false,
      resize: () => ({ toDataURL: () => `resized:${imagePath}` }),
      toDataURL: () => `padded:${imagePath}`
    }));

    expect(await testingExports.shouldPadGrayscaleIcon(iconPath, "converted-icon.png")).toBe(true);

    const result = await testingExports.loadIconFileDataURL(iconPath);

    expect(result.dataURL).toMatch(/^padded:.*icon-padded\.png$/u);
    expect(testingExports.iconRuntime.createFromPath).toHaveBeenCalledTimes(1);
    expect(testingExports.iconRuntime.createFromPath).toHaveBeenCalledWith(
      expect.stringMatching(/icon-padded\.png$/u)
    );
  });
});

async function writeAppPlist(
  appPath: string,
  {
    displayName,
    bundleIdentifier,
    version,
    extraKeys = ""
  }: { displayName: string; bundleIdentifier: string; version: string; extraKeys?: string }
): Promise<void> {
  await mkdir(path.join(appPath, "Contents"), { recursive: true });
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${displayName}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
${extraKeys}
</dict>
</plist>
`
  );
}
