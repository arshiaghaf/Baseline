import { execFile } from "node:child_process";
import { app as electronApp, nativeImage, type NativeImage } from "electron";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AppRecord, UpdateSource } from "../shared/domain";
import { isAllowedFeedURL } from "../shared/security";
import { version } from "../shared/version";

const execFileAsync = promisify(execFile);

type InfoPlist = Record<string, unknown>;

export class BundleScannerClient {
  async scanApplications(directories: string[]): Promise<AppRecord[]> {
    const seen = new Set<string>();
    const records: AppRecord[] = [];

    for (const directory of directories) {
      const apps = await this.findApps(directory);
      for (const appPath of apps) {
        if (seen.has(appPath)) {
          continue;
        }
        seen.add(appPath);
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
        if (!entry.isDirectory()) {
          continue;
        }
        const entryPath = path.join(directory, entry.name);
        if (entry.name.endsWith(".app")) {
          apps.push(entryPath);
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
    const info = await this.readInfoPlist(appPath);
    if (!info) {
      return undefined;
    }

    const displayName =
      stringValue(info.CFBundleDisplayName) ??
      stringValue(info.CFBundleName) ??
      path.basename(appPath, ".app");
    const bundleIdentifier = stringValue(info.CFBundleIdentifier);
    const rawVersion =
      stringValue(info.CFBundleShortVersionString) ?? stringValue(info.CFBundleVersion);
    const sparkleFeedURL = this.sparkleFeedURL(info);
    const sourceHint: UpdateSource = (await this.hasMasReceipt(appPath))
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
      sourceHint,
      sparkleFeedURL,
      iconDataURL: await this.appIconDataURL(appPath)
    };
  }

  private async readInfoPlist(appPath: string): Promise<InfoPlist | undefined> {
    const infoPath = path.join(appPath, "Contents", "Info.plist");
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

  private async hasMasReceipt(appPath: string): Promise<boolean> {
    try {
      const receipt = path.join(appPath, "Contents", "_MASReceipt", "receipt");
      const receiptStat = await stat(receipt);
      return receiptStat.isFile();
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

  private async appIconDataURL(appPath: string): Promise<string | undefined> {
    const bundleIcon = await this.bundleIconDataURL(appPath);
    if (bundleIcon) {
      return bundleIcon;
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

  private async bundleIconDataURL(appPath: string): Promise<string | undefined> {
    const info = await this.readInfoPlist(appPath);
    if (!info) {
      return undefined;
    }

    for (const iconPath of iconCandidatePaths(appPath, info)) {
      const dataURL = await loadIconFileDataURL(iconPath);
      if (dataURL) {
        return dataURL;
      }
    }

    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function iconCandidatePaths(appPath: string, info: InfoPlist): string[] {
  const resourcesPath = path.join(appPath, "Contents", "Resources");
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
    const withExtension = path.extname(name) ? name : `${name}.icns`;
    return [path.join(resourcesPath, withExtension), path.join(resourcesPath, name)];
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function resizedIconDataURL(image: NativeImage): string {
  return image.resize({ width: 64, height: 64, quality: "best" }).toDataURL();
}

async function loadIconFileDataURL(iconPath: string): Promise<string | undefined> {
  if (path.extname(iconPath).toLowerCase() !== ".icns") {
    const image = nativeImage.createFromPath(iconPath);
    return image.isEmpty() ? undefined : resizedIconDataURL(image);
  }

  let tempDirectory: string | undefined;
  try {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "baseline-icon-"));
    const pngPath = path.join(tempDirectory, "icon.png");
    await execFileAsync("/usr/bin/sips", ["-s", "format", "png", iconPath, "--out", pngPath], {
      maxBuffer: 4 * 1024 * 1024
    });
    const image = nativeImage.createFromPath(pngPath);
    return image.isEmpty() ? undefined : resizedIconDataURL(image);
  } catch {
    return undefined;
  } finally {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}
