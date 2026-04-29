import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
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
      return entries
        .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
        .map((entry) => path.join(directory, entry.name));
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
      sparkleFeedURL
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
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
