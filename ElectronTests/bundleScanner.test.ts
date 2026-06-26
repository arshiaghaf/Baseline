// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BundleScannerClient, testingExports } from "../src/main/bundleScanner";

const electronMocks = vi.hoisted(() => ({
  getFileIcon: vi.fn(async () => ({
    isEmpty: () => true,
    resize: () => ({ toDataURL: () => "" })
  })),
  createFromPath: vi.fn(
    (imagePath: string): { isEmpty: () => boolean; resize: () => { toDataURL: () => string } } => {
      void imagePath;
      return {
        isEmpty: () => true,
        resize: () => ({ toDataURL: () => "" })
      };
    }
  )
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

  it("scans symlinked app bundles once when their target is also scanned", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);
    const scanRoot = path.join(root, "Scan");
    const targetRoot = path.join(root, "Targets");
    const targetApp = path.join(targetRoot, "Target.app");
    const linkedApp = path.join(scanRoot, "Linked.app");
    await mkdir(scanRoot, { recursive: true });
    await writeAppPlist(targetApp, {
      displayName: "Target",
      bundleIdentifier: "com.example.target",
      version: "1.0.0"
    });
    await symlink(targetApp, linkedApp);

    const records = await new BundleScannerClient().scanApplications([scanRoot, targetRoot]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      displayName: "Target",
      bundleIdentifier: "com.example.target"
    });
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

  it("marks direct iOS-on-Mac bundles as App Store apps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "Designed for iPad.app");
    await writeAppPlist(appPath, {
      displayName: "Designed for iPad",
      bundleIdentifier: "com.example.ipad-direct",
      version: "1.0.0",
      extraKeys: [
        "  <key>UIDeviceFamily</key>",
        "  <array>",
        "    <integer>2</integer>",
        "  </array>",
        "  <key>UIDesignRequiresCompatibility</key>",
        "  <true/>"
      ].join("\n")
    });
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundlePath: appPath,
      bundleIdentifier: "com.example.ipad-direct",
      sourceHint: "appStore",
      isIOSAppOnMac: true,
      hasAppStoreEvidence: true
    });
  });

  it("marks receipt-backed UIKit iPad bundles as App Store software lookup eligible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "UIKit Mac App.app");
    await writeAppPlist(appPath, {
      displayName: "UIKit Mac App",
      bundleIdentifier: "com.example.uikit-mac",
      version: "1.0.0",
      extraKeys: [
        "  <key>CFBundleSupportedPlatforms</key>",
        "  <array>",
        "    <string>MacOSX</string>",
        "  </array>",
        "  <key>UIApplicationSceneManifest</key>",
        "  <dict>",
        "    <key>UIApplicationSupportsMultipleScenes</key>",
        "    <false/>",
        "  </dict>",
        "  <key>UIDeviceFamily</key>",
        "  <array>",
        "    <integer>2</integer>",
        "  </array>",
        "  <key>UILaunchStoryboardName</key>",
        "  <string>LaunchScreen</string>"
      ].join("\n")
    });
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundlePath: appPath,
      bundleIdentifier: "com.example.uikit-mac",
      sourceHint: "appStore",
      isIOSAppOnMac: true,
      hasAppStoreEvidence: true
    });
  });

  it("does not enable iOS software lookup for native macOS UIKit App Store bundles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "Native UIKit Mac App.app");
    await writeAppPlist(appPath, {
      displayName: "Native UIKit Mac App",
      bundleIdentifier: "com.example.native-uikit-mac",
      version: "1.0.0",
      extraKeys: [
        "  <key>CFBundleSupportedPlatforms</key>",
        "  <array>",
        "    <string>MacOSX</string>",
        "  </array>",
        "  <key>DTPlatformName</key>",
        "  <string>macosx</string>",
        "  <key>DTSDKName</key>",
        "  <string>macosx26.5</string>",
        "  <key>LSMinimumSystemVersion</key>",
        "  <string>26.0</string>",
        "  <key>UIApplicationSceneManifest</key>",
        "  <dict>",
        "    <key>UIApplicationSupportsMultipleScenes</key>",
        "    <false/>",
        "  </dict>",
        "  <key>UIDeviceFamily</key>",
        "  <array>",
        "    <integer>2</integer>",
        "  </array>",
        "  <key>UILaunchStoryboardName</key>",
        "  <string>LaunchScreen</string>"
      ].join("\n")
    });
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundlePath: appPath,
      bundleIdentifier: "com.example.native-uikit-mac",
      sourceHint: "appStore",
      isIOSAppOnMac: false,
      hasAppStoreEvidence: true
    });
  });

  it("does not enable iOS software lookup for App Store UIKit bundles with Mac idiom", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "UIKit Mac Idiom App.app");
    await writeAppPlist(appPath, {
      displayName: "UIKit Mac Idiom App",
      bundleIdentifier: "com.example.uikit-mac-idiom",
      version: "1.0.0",
      extraKeys: [
        "  <key>UIApplicationSceneManifest</key>",
        "  <dict>",
        "    <key>UIApplicationSupportsMultipleScenes</key>",
        "    <false/>",
        "  </dict>",
        "  <key>UIDeviceFamily</key>",
        "  <array>",
        "    <integer>6</integer>",
        "  </array>",
        "  <key>UILaunchStoryboardName</key>",
        "  <string>LaunchScreen</string>"
      ].join("\n")
    });
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundleIdentifier: "com.example.uikit-mac-idiom",
      sourceHint: "appStore",
      isIOSAppOnMac: false,
      hasAppStoreEvidence: true
    });
  });

  it("does not enable iOS software lookup for App Store UIKit bundles with mixed iPad and Mac idioms", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "UIKit Mixed Idiom App.app");
    await writeAppPlist(appPath, {
      displayName: "UIKit Mixed Idiom App",
      bundleIdentifier: "com.example.uikit-mixed-idiom",
      version: "1.0.0",
      extraKeys: [
        "  <key>UIApplicationSceneManifest</key>",
        "  <dict>",
        "    <key>UIApplicationSupportsMultipleScenes</key>",
        "    <false/>",
        "  </dict>",
        "  <key>UIDeviceFamily</key>",
        "  <array>",
        "    <integer>2</integer>",
        "    <integer>6</integer>",
        "  </array>",
        "  <key>UILaunchStoryboardName</key>",
        "  <string>LaunchScreen</string>"
      ].join("\n")
    });
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundlePath: appPath,
      bundleIdentifier: "com.example.uikit-mixed-idiom",
      sourceHint: "appStore",
      isIOSAppOnMac: false,
      hasAppStoreEvidence: true
    });
  });

  it("marks App Store UIKit Mac bundles with scalar device family as lookup eligible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "UIKit Scalar Device Family.app");
    await writeAppPlist(appPath, {
      displayName: "UIKit Scalar Device Family",
      bundleIdentifier: "com.example.uikit-scalar-device-family",
      version: "1.0.0",
      extraKeys: [
        "  <key>UIApplicationSceneManifest</key>",
        "  <dict>",
        "    <key>UIApplicationSupportsMultipleScenes</key>",
        "    <false/>",
        "  </dict>",
        "  <key>UIDeviceFamily</key>",
        "  <integer>2</integer>",
        "  <key>UILaunchStoryboardName</key>",
        "  <string>LaunchScreen</string>"
      ].join("\n")
    });
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundleIdentifier: "com.example.uikit-scalar-device-family",
      sourceHint: "appStore",
      isIOSAppOnMac: true,
      hasAppStoreEvidence: true
    });
  });

  it("does not enable iOS software lookup for UIKit-style Mac bundles without App Store evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    await writeAppPlist(path.join(root, "Sideloaded UIKit Mac App.app"), {
      displayName: "Sideloaded UIKit Mac App",
      bundleIdentifier: "com.example.sideloaded-uikit-mac",
      version: "1.0.0",
      extraKeys: [
        "  <key>UIApplicationSceneManifest</key>",
        "  <dict>",
        "    <key>UIApplicationSupportsMultipleScenes</key>",
        "    <false/>",
        "  </dict>",
        "  <key>UIDeviceFamily</key>",
        "  <array>",
        "    <integer>2</integer>",
        "  </array>",
        "  <key>UILaunchStoryboardName</key>",
        "  <string>LaunchScreen</string>"
      ].join("\n")
    });

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundleIdentifier: "com.example.sideloaded-uikit-mac",
      sourceHint: "unknown",
      isIOSAppOnMac: false,
      hasAppStoreEvidence: false
    });
  });

  it("marks native Safari web extension apps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "Content Blocker.app");
    await writeAppPlist(appPath, {
      displayName: "Content Blocker",
      bundleIdentifier: "com.example.content-blocker",
      version: "1.0.0",
      extraKeys: [
        "  <key>CFBundleSupportedPlatforms</key>",
        "  <array>",
        "    <string>MacOSX</string>",
        "  </array>",
        "  <key>LSMinimumSystemVersion</key>",
        "  <string>13.5</string>"
      ].join("\n")
    });
    await writeExtensionPlist(
      path.join(appPath, "Contents", "PlugIns", "Content Blocker Extension.appex"),
      "com.apple.Safari.web-extension"
    );
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundlePath: appPath,
      bundleIdentifier: "com.example.content-blocker",
      sourceHint: "appStore",
      isIOSAppOnMac: false,
      hasAppStoreEvidence: true,
      hasSafariWebExtension: true
    });
  });

  it("does not mark other app extensions as Safari web extension apps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "Native Service App.app");
    await writeAppPlist(appPath, {
      displayName: "Native Service App",
      bundleIdentifier: "com.example.native-service",
      version: "1.0.0"
    });
    await writeExtensionPlist(
      path.join(appPath, "Contents", "PlugIns", "Service Extension.appex"),
      "com.example.native-service-extension"
    );

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundleIdentifier: "com.example.native-service",
      hasSafariWebExtension: false
    });
  });

  it("scans App Store wrapper bundles for iOS-on-Mac apps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);
    const appPath = path.join(root, "Wrapped iPad App.app");

    await writeWrappedIOSAppPlist(appPath, {
      displayName: "Wrapped iPad App",
      bundleIdentifier: "com.example.ipad-wrapper",
      version: "3.22"
    });
    electronMocks.createFromPath.mockImplementation((imagePath: string) => ({
      isEmpty: () => !imagePath.endsWith("AppIcon60x60@2x.png"),
      resize: () => ({ toDataURL: () => `icon:${imagePath}` })
    }));

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      id: appPath,
      bundlePath: appPath,
      displayName: "Wrapped iPad App",
      bundleIdentifier: "com.example.ipad-wrapper",
      localVersion: { raw: "3.22" },
      sourceHint: "appStore",
      isIOSAppOnMac: true,
      hasAppStoreEvidence: true,
      iconDataURL: `icon:${path.join(appPath, "Wrapper", "Wrapped iPad App.app", "AppIcon60x60@2x.png")}`
    });
  });

  it("does not treat wrapper iOS apps without App Store metadata as App Store managed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);
    const appPath = path.join(root, "Sideloaded iPad App.app");

    await writeWrappedIOSAppPlist(appPath, {
      displayName: "Sideloaded iPad App",
      bundleIdentifier: "com.example.sideloaded-ipad-wrapper",
      version: "1.0",
      includeAppStoreEvidence: false
    });

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundleIdentifier: "com.example.sideloaded-ipad-wrapper",
      sourceHint: "unknown",
      isIOSAppOnMac: true,
      hasAppStoreEvidence: false
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

  it("normalizes unreadable raster app icons before falling back to system icons", async () => {
    const iconPath = "/Applications/Wrapped.app/Wrapper/Wrapped.app/AppIcon60x60@2x.png";

    testingExports.iconRuntime.execFileAsync = vi.fn(async (file: string, args: string[]) => {
      if (file !== "/usr/bin/sips") {
        throw new Error(`Unexpected executable: ${file}`);
      }
      if (args.includes("-s") && args.includes("format")) {
        const outputPath = args.at(-1);
        await writeFile(String(outputPath), "normalized png");
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected sips arguments: ${args.join(" ")}`);
    });
    testingExports.iconRuntime.createFromPath = vi.fn((imagePath: string) => ({
      isEmpty: () => !imagePath.endsWith("icon-normalized.png"),
      resize: () => ({ toDataURL: () => `normalized:${imagePath}` }),
      toDataURL: () => `original:${imagePath}`
    }));

    const result = await testingExports.loadIconFileDataURL(iconPath);

    expect(result.dataURL).toMatch(/^normalized:.*icon-normalized\.png$/u);
    expect(testingExports.iconRuntime.createFromPath).toHaveBeenCalledWith(iconPath);
    expect(testingExports.iconRuntime.createFromPath).toHaveBeenCalledWith(
      expect.stringMatching(/icon-normalized\.png$/u)
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

async function writeWrappedIOSAppPlist(
  appPath: string,
  {
    displayName,
    bundleIdentifier,
    version,
    includeAppStoreEvidence = true
  }: {
    displayName: string;
    bundleIdentifier: string;
    version: string;
    includeAppStoreEvidence?: boolean;
  }
): Promise<void> {
  const wrappedAppPath = path.join(appPath, "Wrapper", `${displayName}.app`);
  await mkdir(wrappedAppPath, { recursive: true });
  await writeFile(path.join(wrappedAppPath, "AppIcon60x60@2x.png"), "icon");
  await writeFile(
    path.join(wrappedAppPath, "Info.plist"),
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
  <key>CFBundleIconFiles</key>
  <array>
    <string>AppIcon60x60</string>
  </array>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleSupportedPlatforms</key>
  <array>
    <string>iPhoneOS</string>
  </array>
  <key>LSRequiresIPhoneOS</key>
  <true/>
  <key>UIDeviceFamily</key>
  <array>
    <integer>1</integer>
    <integer>2</integer>
  </array>
</dict>
</plist>
`
  );
  if (includeAppStoreEvidence) {
    await mkdir(path.join(wrappedAppPath, "SC_Info"), { recursive: true });
    await writeFile(
      path.join(appPath, "Wrapper", "iTunesMetadata.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>softwareVersionBundleId</key>
  <string>${bundleIdentifier}</string>
  <key>itemId</key>
  <integer>123456789</integer>
</dict>
</plist>
`
    );
  }
}

async function writeExtensionPlist(
  appExtensionPath: string,
  extensionPoint: string
): Promise<void> {
  await mkdir(path.join(appExtensionPath, "Contents"), { recursive: true });
  await writeFile(
    path.join(appExtensionPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.example.extension</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>${extensionPoint}</string>
  </dict>
</dict>
</plist>
`
  );
}
