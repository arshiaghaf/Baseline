// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { macOSManagedPath } from "./macOSManagedApps";
import { runCommand } from "./commandRunner";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { app as electronApp, nativeImage, type NativeImage } from "electron";
import { access, lstat, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { constants } from "node:fs";
import type { AppRecord, UpdateSource } from "../shared/domain";
import { isAllowedFeedURL } from "../shared/security";
import { version } from "../shared/version";
import { IconCache, type IconLoadResult } from "./iconCache";
import { cancellableRead, readSignal, rethrowCancelledRead } from "./readCancellation";

const execFileAsync = promisify(execFile);
const directoryRuntime = { readdir, access, lstat, realpath, stat };

type InfoPlist = Record<string, unknown>;
type AppBundleInfo = {
  info: InfoPlist;
  isIOSAppOnMac: boolean;
  hasAppStoreEvidence: boolean;
  hasSafariWebExtension: boolean;
  iconResourcesPath: string;
  providerFiles: string[];
};
type IconExecFileAsync = (
  file: string,
  args: string[],
  options?: { maxBuffer: number; timeout?: number; killSignal?: NodeJS.Signals }
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

export type ScanRootHealth = {
  directory: string;
  complete: boolean;
  /** Individual entries whose targets could not be read, separate from directory traversal. */
  unavailableApps?: { bundlePath: string; notFound: boolean }[];
};
export type ScanOptions = {
  signal?: AbortSignal;
  onRootRead?: (health: ScanRootHealth) => void;
  onAppRead?: (bundlePath: string, canonicalPath: string) => void;
};

export class BundleScannerClient {
  private readonly icons = new IconCache(loadIconFileDataURL);

  scanApplications(directories: string[], options: ScanOptions = {}): Promise<AppRecord[]> {
    return new BundleScan(this.icons, options).scan(directories);
  }
}

class BundleScan {
  private rootComplete = true;
  private rootDirectory = "";
  private unavailableApps = new Map<string, boolean>();
  constructor(
    private readonly icons: IconCache,
    private readonly options: ScanOptions
  ) {}

  private read<T>(task: Promise<T>): Promise<T> {
    return cancellableRead(task, readSignal(this.options.signal));
  }

  async scan(directories: string[]): Promise<AppRecord[]> {
    const seen = new Set<string>();
    const records: AppRecord[] = [];
    for (const directory of directories) {
      this.options.signal?.throwIfAborted();
      this.rootComplete = true;
      this.rootDirectory = directory;
      this.unavailableApps = new Map();
      try {
        const apps = await this.findApps(directory);
        for (const appPath of apps) {
          this.options.signal?.throwIfAborted();
          const resolved = await resolveAppPath(appPath, this.options.signal);
          if (resolved.value === undefined) {
            this.unavailableApps.set(appPath, resolved.notFound);
            continue;
          }
          const resolvedPath = resolved.value;
          const canonicalPath = resolvedPath;
          if (seen.has(canonicalPath)) {
            this.options.onAppRead?.(appPath, canonicalPath);
            continue;
          }
          const record = await this.makeRecord(appPath, resolvedPath);
          if (record) {
            seen.add(canonicalPath);
            this.options.onAppRead?.(appPath, canonicalPath);
            records.push(record);
          }
        }
      } catch {
        this.options.signal?.throwIfAborted();
        // A read deadline is incomplete evidence, never an empty directory.
        this.rootComplete = false;
      }
      this.options.signal?.throwIfAborted();
      this.options.onRootRead?.({
        directory,
        complete: this.rootComplete,
        ...(this.unavailableApps.size
          ? {
              unavailableApps: [...this.unavailableApps].map(([bundlePath, notFound]) => ({
                bundlePath,
                notFound
              }))
            }
          : {})
      });
    }
    this.options.signal?.throwIfAborted();
    return records.sort((lhs, rhs) =>
      lhs.displayName.localeCompare(rhs.displayName, undefined, { sensitivity: "base" })
    );
  }

  private async findApps(directory: string): Promise<string[]> {
    try {
      const entries = await this.read(directoryRuntime.readdir(directory, { withFileTypes: true }));
      const apps: string[] = [];
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.name.endsWith(".app")) {
          if (entry.isDirectory()) apps.push(entryPath);
          else if (entry.isSymbolicLink()) {
            const directory = await isDirectory(entryPath, this.options.signal);
            if (directory.value === undefined)
              this.unavailableApps.set(entryPath, directory.notFound);
            else if (directory.value) apps.push(entryPath);
          }
          continue;
        }
        if (!entry.isDirectory()) {
          continue;
        }
        apps.push(...(await this.findApps(entryPath)));
      }
      return apps;
    } catch (error) {
      rethrowCancelledRead(error, this.options.signal);
      if (!(await this.isAbsentOptionalRoot(directory, error))) this.rootComplete = false;
      return [];
    }
  }

  private async isAbsentOptionalRoot(directory: string, error: unknown): Promise<boolean> {
    const home = os.homedir();
    if (
      directory !== this.rootDirectory ||
      path.resolve(directory) !== path.join(home, "Applications") ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    )
      return false;
    try {
      // lstat must see no entry: readdir's ENOENT also describes broken aliases.
      await this.read(directoryRuntime.lstat(directory));
      return false;
    } catch (probeError) {
      rethrowCancelledRead(probeError, this.options.signal);
      if ((probeError as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    try {
      const entries = await this.read(directoryRuntime.readdir(home, { withFileTypes: true }));
      return !entries.some((entry) => entry.name === "Applications");
    } catch (probeError) {
      rethrowCancelledRead(probeError, this.options.signal);
      return false;
    }
  }

  private async makeRecord(appPath: string, resolvedPath?: string): Promise<AppRecord | undefined> {
    const bundleInfo = await this.readAppBundleInfo(appPath);
    if (!bundleInfo) return undefined;
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
      canonicalBundlePath: resolvedPath,
      providerFingerprint: await providerFingerprint(
        appPath,
        bundleInfo.providerFiles,
        {
          bundleIdentifier,
          rawVersion,
          rawBundleVersion,
          sparkleFeedURL,
          isIOSAppOnMac,
          hasAppStoreEvidence: hasMasReceipt || hasAppStoreEvidence,
          hasSafariWebExtension
        },
        this.options.signal
      ),
      displayName,
      bundleIdentifier,
      localVersion: version(rawVersion),
      bundleVersion: rawBundleVersion ? version(rawBundleVersion) : undefined,
      sourceHint,
      macOSManagedPath: macOSManagedPath(resolvedPath),
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
        providerFiles: bundleIdentityFiles(path.join(appPath, "Contents"), info, false),
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
    return readInfoPlistAtPath(path.join(appPath, "Contents", "Info.plist"), this.options.signal);
  }

  private async readWrappedIOSAppBundleInfo(appPath: string): Promise<AppBundleInfo | undefined> {
    const wrapperPath = path.join(appPath, "Wrapper");
    try {
      const entries = await this.read(
        directoryRuntime.readdir(wrapperPath, { withFileTypes: true })
      );
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.endsWith(".app")) {
          continue;
        }
        const info = await readInfoPlistAtPath(
          path.join(wrapperPath, entry.name, "Info.plist"),
          this.options.signal
        );
        if (info && isIOSAppOnMacInfo(info)) {
          return {
            info,
            providerFiles: bundleIdentityFiles(path.join(wrapperPath, entry.name), info, true),
            isIOSAppOnMac: true,
            hasAppStoreEvidence: await this.hasWrappedAppStoreEvidence(appPath, entry.name, info),
            hasSafariWebExtension: false,
            iconResourcesPath: path.join(wrapperPath, entry.name)
          };
        }
      }
    } catch (error) {
      rethrowCancelledRead(error, this.options.signal);
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      return undefined;
    }
    return undefined;
  }

  private async hasMasReceipt(appPath: string): Promise<boolean> {
    try {
      const receipt = path.join(appPath, "Contents", "_MASReceipt", "receipt");
      const receiptStat = await this.read(stat(receipt));
      return receiptStat.isFile();
    } catch (error) {
      rethrowCancelledRead(error, this.options.signal);
      return false;
    }
  }

  private async hasSafariWebExtension(appPath: string): Promise<boolean> {
    const pluginsPath = path.join(appPath, "Contents", "PlugIns");
    try {
      const entries = await this.read(
        directoryRuntime.readdir(pluginsPath, { withFileTypes: true })
      );
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.endsWith(".appex")) {
          continue;
        }
        const info = await readInfoPlistAtPath(
          path.join(pluginsPath, entry.name, "Contents", "Info.plist"),
          this.options.signal
        );
        if (
          stringValue(recordValue(info?.NSExtension)?.NSExtensionPointIdentifier) ===
          "com.apple.Safari.web-extension"
        ) {
          return true;
        }
      }
    } catch (error) {
      rethrowCancelledRead(error, this.options.signal);
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
      "softwareVersionBundleId",
      this.options.signal
    );
    const bundleIdentifier = stringValue(info.CFBundleIdentifier);
    if (!bundleIdentifier || metadataBundleID?.toLowerCase() !== bundleIdentifier.toLowerCase()) {
      return false;
    }

    try {
      const scInfo = await this.read(stat(path.join(wrapperPath, wrappedAppName, "SC_Info")));
      return scInfo.isDirectory();
    } catch (error) {
      rethrowCancelledRead(error, this.options.signal);
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
    try {
      const bundleIcon = await this.bundleIconDataURL(iconResourcesPath, info);
      if (bundleIcon.dataURL) {
        return bundleIcon.dataURL;
      }
      const image = await this.read(electronApp.getFileIcon(appPath, { size: "normal" }));
      if (image.isEmpty()) {
        return undefined;
      }
      return resizedIconDataURL(image);
    } catch {
      // Icons are optional. Their deadlines must not discard readable app
      // metadata, while cancellation of the scan must still stop immediately.
      this.options.signal?.throwIfAborted();
      return undefined;
    }
  }

  private async bundleIconDataURL(
    iconResourcesPath: string,
    info: InfoPlist
  ): Promise<IconLoadResult> {
    for (const iconPath of iconCandidatePaths(iconResourcesPath, info)) {
      const result = await this.read(this.icons.get(iconPath));
      if (result.dataURL) {
        return result;
      }
    }

    return {};
  }
}

type AppPathRead<T> = { value: T } | { value?: undefined; notFound: boolean };

async function readAppPath<T>(task: Promise<T>, signal?: AbortSignal): Promise<AppPathRead<T>> {
  try {
    return { value: await cancellableRead(task, readSignal(signal)) };
  } catch (error) {
    signal?.throwIfAborted();
    return { notFound: (error as NodeJS.ErrnoException).code === "ENOENT" };
  }
}

function resolveAppPath(appPath: string, signal?: AbortSignal): Promise<AppPathRead<string>> {
  return readAppPath(directoryRuntime.realpath(appPath), signal);
}

async function canonicalAppPath(appPath: string, signal?: AbortSignal): Promise<string> {
  return (await resolveAppPath(appPath, signal)).value ?? appPath;
}

function isDirectory(candidatePath: string, signal?: AbortSignal): Promise<AppPathRead<boolean>> {
  return readAppPath(
    directoryRuntime.stat(candidatePath).then((info) => info.isDirectory()),
    signal
  );
}

async function readPlistRawValue(
  plistPath: string,
  key: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    const result = await runCommand(
      "/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", plistPath],
      undefined,
      { maxOutputBytes: 1024 * 1024, timeoutMs: 8000, signal }
    );
    signal?.throwIfAborted();
    if (result.failure?.kind === "timeout")
      throw new DOMException("App metadata read timed out.", "TimeoutError");
    if (!result.success) return undefined;
    const value = (result.stdout ?? "").trim();
    return value ? value : undefined;
  } catch (error) {
    rethrowCancelledRead(error, signal);
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function readInfoPlistAtPath(
  infoPath: string,
  signal?: AbortSignal
): Promise<InfoPlist | undefined> {
  try {
    // A missing plist or unsupported format is not a failed directory read.
    // Permission and filesystem failures remain incomplete scan evidence.
    await cancellableRead(directoryRuntime.access(infoPath, constants.R_OK), readSignal(signal));
    const result = await runCommand(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", infoPath],
      undefined,
      { maxOutputBytes: 4 * 1024 * 1024, timeoutMs: 8000, signal }
    );
    signal?.throwIfAborted();
    if (result.failure?.kind === "timeout")
      throw new DOMException("App metadata read timed out.", "TimeoutError");
    if (result.failure || result.cancelled || result.signal)
      throw new Error("App metadata helper could not complete.");
    if (!result.success) {
      // A helper exit alone cannot distinguish malformed input from lost access.
      await cancellableRead(directoryRuntime.access(infoPath, constants.R_OK), readSignal(signal));
      return undefined;
    }
    return JSON.parse(result.stdout ?? "") as InfoPlist;
  } catch (error) {
    rethrowCancelledRead(error, signal);
    if (
      !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") &&
      !(error instanceof SyntaxError)
    )
      throw error;
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
      maxBuffer: 1024 * 1024,
      timeout: 8000,
      killSignal: "SIGKILL"
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
        maxBuffer: 4 * 1024 * 1024,
        timeout: 8000,
        killSignal: "SIGKILL"
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
        maxBuffer: 4 * 1024 * 1024,
        timeout: 8000,
        killSignal: "SIGKILL"
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
        maxBuffer: 4 * 1024 * 1024,
        timeout: 8000,
        killSignal: "SIGKILL"
      }
    );
    await iconRuntime.execFileAsync(
      "/usr/bin/sips",
      ["--padToHeightWidth", "64", "64", "--padColor", "FFFFFF", resizedPath, "--out", paddedPath],
      { maxBuffer: 4 * 1024 * 1024, timeout: 8000, killSignal: "SIGKILL" }
    );
    const image = iconRuntime.createFromPath(paddedPath);
    return image.isEmpty() ? undefined : image.toDataURL();
  } catch {
    return undefined;
  }
}

export const testingExports = {
  directoryRuntime,
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

function bundleIdentityFiles(contentsPath: string, info: InfoPlist, flat: boolean): string[] {
  const files = [
    path.join(contentsPath, "Info.plist"),
    path.join(contentsPath, "_CodeSignature", "CodeResources")
  ];
  const executable = stringValue(info.CFBundleExecutable);
  // The plist field names a single file, never a relative or absolute path.
  if (executable && executable !== "." && executable !== ".." && !/[\\/\0]/.test(executable)) {
    files.push(path.join(contentsPath, ...(flat ? [] : ["MacOS"]), executable));
  }
  return files;
}

async function providerFingerprint(
  appPath: string,
  providerFiles: string[],
  evidence: object,
  signal?: AbortSignal
): Promise<string> {
  const canonicalRoot = await canonicalAppPath(appPath, signal);
  const files = [
    appPath,
    ...providerFiles,
    path.join(appPath, "Contents", "_MASReceipt", "receipt"),
    path.join(appPath, "Wrapper")
  ];
  const identities = await Promise.all(
    files.map(async (file) => {
      try {
        const resolved = await cancellableRead(realpath(file), readSignal(signal));
        const relative = path.relative(canonicalRoot, resolved);
        // Ignore executable/resource symlinks that escape the installed bundle.
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          return null;
        const value = await cancellableRead(stat(resolved), readSignal(signal));
        return [relative, value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs];
      } catch (error) {
        rethrowCancelledRead(error, signal);
        return null;
      }
    })
  );
  return createHash("sha256")
    .update(JSON.stringify([canonicalRoot, evidence, identities]))
    .digest("hex");
}
