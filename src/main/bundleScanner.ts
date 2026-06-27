// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { execFile } from "node:child_process";
import { app as electronApp, nativeImage, type NativeImage } from "electron";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AppRecord, UpdateSource } from "../shared/domain";
import { isAllowedFeedURL } from "../shared/security";
import { version } from "../shared/version";

const execFileAsync = promisify(execFile);

type InfoPlist = Record<string, unknown>;
type AppBundleInfo = {
  info: InfoPlist;
  isIOSAppOnMac: boolean;
  hasAppStoreEvidence: boolean;
  hasSafariWebExtension: boolean;
  iconResourcesPath: string;
};
type IconLoadResult = { dataURL?: string };
type IconExecFileAsync = (
  file: string,
  args: string[],
  options?: { maxBuffer: number }
) => Promise<{ stdout: string; stderr: string }>;
type ResizedIconImage = Pick<NativeImage, "toDataURL">;
type IconNativeImage = {
  isEmpty: () => boolean;
  resize: (options: Parameters<NativeImage["resize"]>[0]) => ResizedIconImage;
  toDataURL: () => string;
};

const defaultIconRuntime = {
  createFromPath: (imagePath: string): IconNativeImage => nativeImage.createFromPath(imagePath),
  execFileAsync: execFileAsync as IconExecFileAsync
};

const iconRuntime: {
  createFromPath: (imagePath: string) => IconNativeImage;
  execFileAsync: IconExecFileAsync;
} = { ...defaultIconRuntime };

export class BundleScannerClient {
  async scanApplications(directories: string[]): Promise<AppRecord[]> {
    const seen = new Set<string>();
    const records: AppRecord[] = [];

    for (const directory of directories) {
      const apps = await this.findApps(directory);
      for (const appPath of apps) {
        const canonicalPath = await canonicalAppPath(appPath);
        if (seen.has(canonicalPath)) {
          continue;
        }
        seen.add(canonicalPath);
        const record = await this.makeRecord(appPath);
        if (record) {
          records.push(record);
        }
      }
    }

    return records.sort((lhs, rhs) =>
      lhs.displayName.localeCompare(rhs.displayName, undefined, { sensitivity: "base" })
    );
  }

  private async findApps(directory: string): Promise<string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const apps: string[] = [];
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.name.endsWith(".app")) {
          if (entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectory(entryPath)))) {
            apps.push(entryPath);
          }
          continue;
        }
        if (!entry.isDirectory()) {
          continue;
        }
        apps.push(...(await this.findApps(entryPath)));
      }
      return apps;
    } catch {
      return [];
    }
  }

  private async makeRecord(appPath: string): Promise<AppRecord | undefined> {
    const bundleInfo = await this.readAppBundleInfo(appPath);
    if (!bundleInfo) {
      return undefined;
    }
    const { info, isIOSAppOnMac, hasAppStoreEvidence, hasSafariWebExtension, iconResourcesPath } =
      bundleInfo;
    if (isWebAppBundle(info)) {
      return undefined;
    }

    const displayName =
      stringValue(info.CFBundleDisplayName) ??
      stringValue(info.CFBundleName) ??
      path.basename(appPath, ".app");
    const bundleIdentifier = stringValue(info.CFBundleIdentifier);
    const rawBundleVersion = stringValue(info.CFBundleVersion);
    const rawVersion = stringValue(info.CFBundleShortVersionString) ?? rawBundleVersion;
    const sparkleFeedURL = this.sparkleFeedURL(info);
    const hasMasReceipt = await this.hasMasReceipt(appPath);
    const sourceHint: UpdateSource = hasMasReceipt
      ? "appStore"
      : isIOSAppOnMac && hasAppStoreEvidence
        ? "appStore"
        : sparkleFeedURL
          ? "sparkle"
          : "unknown";

    return {
      id: appPath,
      bundlePath: appPath,
      displayName,
      bundleIdentifier,
      localVersion: version(rawVersion),
      bundleVersion: rawBundleVersion ? version(rawBundleVersion) : undefined,
      sourceHint,
      isIOSAppOnMac,
      hasAppStoreEvidence: hasMasReceipt || hasAppStoreEvidence,
      hasSafariWebExtension,
      sparkleFeedURL,
      iconDataURL: await this.appIconDataURL(appPath, iconResourcesPath, info)
    };
  }

  private async readAppBundleInfo(appPath: string): Promise<AppBundleInfo | undefined> {
    const info = await this.readInfoPlist(appPath);
    if (info) {
      const hasAppStoreEvidence = await this.hasMasReceipt(appPath);
      return {
        info,
        isIOSAppOnMac:
          isIOSAppOnMacInfo(info) || (hasAppStoreEvidence && isUIKitMacAppStoreInfo(info)),
        hasAppStoreEvidence,
        hasSafariWebExtension: await this.hasSafariWebExtension(appPath),
        iconResourcesPath: path.join(appPath, "Contents", "Resources")
      };
    }
    return this.readWrappedIOSAppBundleInfo(appPath);
  }

  private async readInfoPlist(appPath: string): Promise<InfoPlist | undefined> {
    return readInfoPlistAtPath(path.join(appPath, "Contents", "Info.plist"));
  }

  private async readWrappedIOSAppBundleInfo(appPath: string): Promise<AppBundleInfo | undefined> {
    const wrapperPath = path.join(appPath, "Wrapper");
    try {
      const entries = await readdir(wrapperPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.endsWith(".app")) {
          continue;
        }
        const info = await readInfoPlistAtPath(path.join(wrapperPath, entry.name, "Info.plist"));
        if (info && isIOSAppOnMacInfo(info)) {
          return {
            info,
            isIOSAppOnMac: true,
            hasAppStoreEvidence: await this.hasWrappedAppStoreEvidence(appPath, entry.name, info),
            hasSafariWebExtension: false,
            iconResourcesPath: path.join(wrapperPath, entry.name)
          };
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async hasMasReceipt(appPath: string): Promise<boolean> {
    try {
      const receipt = path.join(appPath, "Contents", "_MASReceipt", "receipt");
      const receiptStat = await stat(receipt);
      return receiptStat.isFile();
    } catch {
      return false;
    }
  }

  private async hasSafariWebExtension(appPath: string): Promise<boolean> {
    const pluginsPath = path.join(appPath, "Contents", "PlugIns");
    try {
      const entries = await readdir(pluginsPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.endsWith(".appex")) {
          continue;
        }
        const info = await readInfoPlistAtPath(
          path.join(pluginsPath, entry.name, "Contents", "Info.plist")
        );
        if (
          stringValue(recordValue(info?.NSExtension)?.NSExtensionPointIdentifier) ===
          "com.apple.Safari.web-extension"
        ) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  private async hasWrappedAppStoreEvidence(
    appPath: string,
    wrappedAppName: string,
    info: InfoPlist
  ): Promise<boolean> {
    const wrapperPath = path.join(appPath, "Wrapper");
    const metadataBundleID = await readPlistRawValue(
      path.join(wrapperPath, "iTunesMetadata.plist"),
      "softwareVersionBundleId"
    );
    const bundleIdentifier = stringValue(info.CFBundleIdentifier);
    if (!bundleIdentifier || metadataBundleID?.toLowerCase() !== bundleIdentifier.toLowerCase()) {
      return false;
    }

    try {
      const scInfo = await stat(path.join(wrapperPath, wrappedAppName, "SC_Info"));
      return scInfo.isDirectory();
    } catch {
      return false;
    }
  }

  private sparkleFeedURL(info: InfoPlist): string | undefined {
    const feed =
      stringValue(info.SUFeedURL) ??
      stringValue(info.SUFeedURLForSparkleUpdater) ??
      stringValue(info.DevMateKitUpdateFeedURL);
    return feed && isAllowedFeedURL(feed) ? feed : undefined;
  }

  private async appIconDataURL(
    appPath: string,
    iconResourcesPath: string,
    info: InfoPlist
  ): Promise<string | undefined> {
    const bundleIcon = await this.bundleIconDataURL(iconResourcesPath, info);
    if (bundleIcon.dataURL) {
      return bundleIcon.dataURL;
    }

    try {
      const image = await electronApp.getFileIcon(appPath, { size: "normal" });
      if (image.isEmpty()) {
        return undefined;
      }
      return resizedIconDataURL(image);
    } catch {
      return undefined;
    }
  }

  private async bundleIconDataURL(
    iconResourcesPath: string,
    info: InfoPlist
  ): Promise<IconLoadResult> {
    for (const iconPath of iconCandidatePaths(iconResourcesPath, info)) {
      const result = await loadIconFileDataURL(iconPath);
      if (result.dataURL) {
        return result;
      }
    }

    return {};
  }
}

async function canonicalAppPath(appPath: string): Promise<string> {
  try {
    return await realpath(appPath);
  } catch {
    return appPath;
  }
}

async function isDirectory(candidatePath: string): Promise<boolean> {
  try {
    return (await stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

async function readPlistRawValue(plistPath: string, key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", plistPath],
      {
        maxBuffer: 1024 * 1024
      }
    );
    const value = stdout.trim();
    return value ? value : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function readInfoPlistAtPath(infoPath: string): Promise<InfoPlist | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", infoPath],
      {
        maxBuffer: 4 * 1024 * 1024
      }
    );
    return JSON.parse(stdout) as InfoPlist;
  } catch {
    return undefined;
  }
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numberArrayValue(value: unknown): number[] {
  if (typeof value === "number") {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

function isIOSAppOnMacInfo(info: InfoPlist): boolean {
  if (stringArrayValue(info.CFBundleSupportedPlatforms).includes("iPhoneOS")) {
    return true;
  }
  if (hasNativeMacOSBuildMetadata(info)) {
    return false;
  }
  return info.LSRequiresIPhoneOS === true || info.UIDesignRequiresCompatibility === true;
}

function isUIKitMacAppStoreInfo(info: InfoPlist): boolean {
  if (hasNativeMacOSBuildMetadata(info)) {
    return false;
  }
  const deviceFamily = numberArrayValue(info.UIDeviceFamily);
  if (deviceFamily.includes(6)) {
    return false;
  }
  const hasUIKitDeviceFamily = deviceFamily.includes(1) || deviceFamily.includes(2);
  const hasUIKitLifecycle =
    recordValue(info.UIApplicationSceneManifest) !== undefined ||
    stringValue(info.UIMainStoryboardFile) !== undefined ||
    stringValue(info.UILaunchStoryboardName) !== undefined;
  return hasUIKitDeviceFamily && hasUIKitLifecycle;
}

function hasNativeMacOSBuildMetadata(info: InfoPlist): boolean {
  const platformName = stringValue(info.DTPlatformName)?.toLowerCase();
  const sdkName = stringValue(info.DTSDKName)?.toLowerCase();
  return platformName === "macosx" || sdkName?.startsWith("macosx") === true;
}

function iconCandidatePaths(resourcesPath: string, info: InfoPlist): string[] {
  const names = new Set<string>();
  const add = (value: string | undefined) => {
    if (value) {
      names.add(value);
    }
  };

  add(stringValue(info.CFBundleIconFile));
  add(stringValue(info.CFBundleIconName));
  for (const value of stringArrayValue(info.CFBundleIconFiles)) {
    add(value);
  }

  const icons = recordValue(info.CFBundleIcons);
  const primaryIcon = recordValue(icons?.CFBundlePrimaryIcon);
  for (const value of stringArrayValue(primaryIcon?.CFBundleIconFiles)) {
    add(value);
  }
  add(stringValue(primaryIcon?.CFBundleIconName));

  return [...names].flatMap((name) => {
    if (path.extname(name)) {
      return [path.join(resourcesPath, name)];
    }
    return [
      path.join(resourcesPath, `${name}.icns`),
      path.join(resourcesPath, `${name}@3x.png`),
      path.join(resourcesPath, `${name}@2x.png`),
      path.join(resourcesPath, `${name}@3x~ipad.png`),
      path.join(resourcesPath, `${name}@2x~ipad.png`),
      path.join(resourcesPath, `${name}.png`),
      path.join(resourcesPath, name)
    ];
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isWebAppBundle(info: InfoPlist): boolean {
  const templateParameters = recordValue(info.LSTemplateApplicationParameters);
  const templateIdentifier = stringValue(templateParameters?.CFBundleIdentifier);
  const bundleIdentifier = stringValue(info.CFBundleIdentifier);
  return (
    bundleIdentifier?.startsWith("com.apple.Safari.WebApp.") === true ||
    templateIdentifier === "com.apple.Safari.WebApp" ||
    (stringValue(info.WKManifestURL) !== undefined &&
      (bundleIdentifier?.startsWith("com.apple.Safari.") === true ||
        templateIdentifier?.startsWith("com.apple.Safari.") === true))
  );
}

function resizedIconDataURL(image: Pick<IconNativeImage, "resize">): string {
  return image.resize({ width: 64, height: 64, quality: "best" }).toDataURL();
}

async function isGrayscalePNG(pngPath: string): Promise<boolean> {
  try {
    const { stdout } = await iconRuntime.execFileAsync("/usr/bin/sips", ["-g", "space", pngPath], {
      maxBuffer: 1024 * 1024
    });
    return isGrayscaleSipsOutput(stdout);
  } catch {
    return false;
  }
}

function isGrayscaleSipsOutput(output: string): boolean {
  return /^\s*space:\s*Gray\s*$/m.test(output);
}

async function loadIconFileDataURL(iconPath: string): Promise<IconLoadResult> {
  if (path.extname(iconPath).toLowerCase() !== ".icns") {
    return loadRasterIconDataURL(iconPath);
  }

  let tempDirectory: string | undefined;
  try {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "baseline-icon-"));
    const pngPath = path.join(tempDirectory, "icon.png");
    await iconRuntime.execFileAsync(
      "/usr/bin/sips",
      ["-s", "format", "png", iconPath, "--out", pngPath],
      {
        maxBuffer: 4 * 1024 * 1024
      }
    );
    if (await shouldPadGrayscaleIcon(iconPath, pngPath)) {
      const paddedDataURL = await paddedRasterIconDataURL(pngPath);
      if (paddedDataURL) {
        return { dataURL: paddedDataURL };
      }
    }
    const image = iconRuntime.createFromPath(pngPath);
    return image.isEmpty() ? {} : { dataURL: resizedIconDataURL(image) };
  } catch {
    return {};
  } finally {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

async function loadRasterIconDataURL(iconPath: string): Promise<IconLoadResult> {
  const image = iconRuntime.createFromPath(iconPath);
  if (!image.isEmpty()) {
    return { dataURL: resizedIconDataURL(image) };
  }

  let tempDirectory: string | undefined;
  try {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "baseline-icon-"));
    const normalizedPath = path.join(tempDirectory, "icon-normalized.png");
    await iconRuntime.execFileAsync(
      "/usr/bin/sips",
      ["-s", "format", "png", iconPath, "--out", normalizedPath],
      {
        maxBuffer: 4 * 1024 * 1024
      }
    );
    const normalizedImage = iconRuntime.createFromPath(normalizedPath);
    return normalizedImage.isEmpty() ? {} : { dataURL: resizedIconDataURL(normalizedImage) };
  } catch {
    return {};
  } finally {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

async function shouldPadGrayscaleIcon(iconPath: string, pngPath: string): Promise<boolean> {
  return isGenericElectronIconName(iconPath) && (await isGrayscalePNG(pngPath));
}

function isGenericElectronIconName(iconPath: string): boolean {
  return path.basename(iconPath).toLowerCase() === "electron.icns";
}

async function paddedRasterIconDataURL(pngPath: string): Promise<string | undefined> {
  const directory = path.dirname(pngPath);
  const resizedPath = path.join(directory, "icon-resized.png");
  const paddedPath = path.join(directory, "icon-padded.png");
  try {
    await iconRuntime.execFileAsync(
      "/usr/bin/sips",
      ["-z", "54", "54", pngPath, "--out", resizedPath],
      {
        maxBuffer: 4 * 1024 * 1024
      }
    );
    await iconRuntime.execFileAsync(
      "/usr/bin/sips",
      ["--padToHeightWidth", "64", "64", "--padColor", "FFFFFF", resizedPath, "--out", paddedPath],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    const image = iconRuntime.createFromPath(paddedPath);
    return image.isEmpty() ? undefined : image.toDataURL();
  } catch {
    return undefined;
  }
}

export const testingExports = {
  iconRuntime,
  isGenericElectronIconName,
  isGrayscaleSipsOutput,
  loadIconFileDataURL,
  resetIconRuntime: () => {
    iconRuntime.createFromPath = defaultIconRuntime.createFromPath;
    iconRuntime.execFileAsync = defaultIconRuntime.execFileAsync;
  },
  shouldPadGrayscaleIcon
};
