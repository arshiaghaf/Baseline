// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedSnapshot, ProfileStats, ProfileStatsEvent } from "../shared/domain";
import {
  defaultPersistedSnapshot,
  defaultProfileStats,
  normalizeAppearancePreference
} from "../shared/domain";
import { version } from "../shared/version";
export { defaultPersistedSnapshot };

export class SnapshotPersistence {
  private readonly snapshotPath: string;

  constructor(userDataPath: string) {
    this.snapshotPath = path.join(userDataPath, "baseline-snapshot.json");
  }

  async load(): Promise<PersistedSnapshot> {
    try {
      const raw = await readFile(this.snapshotPath, "utf8");
      return normalizeSnapshot(JSON.parse(raw) as Partial<PersistedSnapshot>);
    } catch {
      return defaultPersistedSnapshot();
    }
  }

  async save(snapshot: PersistedSnapshot): Promise<void> {
    await mkdir(path.dirname(this.snapshotPath), { recursive: true });
    await writeFile(this.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
}

function normalizeSnapshot(
  input: Partial<PersistedSnapshot> & { startedUsingAt?: unknown }
): PersistedSnapshot {
  const defaults = defaultPersistedSnapshot();
  return {
    ...defaults,
    ...input,
    selectedTab: "all",
    apps: (input.apps ?? []).map((app) => ({
      ...app,
      id: app.id ?? app.bundlePath,
      localVersion: version(app.localVersion?.raw),
      bundleVersion: app.bundleVersion ? version(app.bundleVersion.raw) : undefined
    })),
    updates: (input.updates ?? []).map((update) => ({
      ...update,
      id: update.id ?? update.appID,
      localVersion: version(update.localVersion?.raw),
      remoteVersion: version(update.remoteVersion?.raw),
      localBuildVersion: update.localBuildVersion
        ? version(update.localBuildVersion.raw)
        : undefined,
      remoteBuildVersion: update.remoteBuildVersion
        ? version(update.remoteBuildVersion.raw)
        : undefined
    })),
    recentlyUpdated: (input.recentlyUpdated ?? []).map((record) => ({
      ...record,
      id: record.id ?? record.appID,
      fromVersion: version(record.fromVersion?.raw),
      toVersion: version(record.toVersion?.raw),
      fromBuildVersion: record.fromBuildVersion ? version(record.fromBuildVersion.raw) : undefined,
      toBuildVersion: record.toBuildVersion ? version(record.toBuildVersion.raw) : undefined
    })),
    homebrewItems: (input.homebrewItems ?? []).map((item) => ({
      ...item,
      latestVersion: item.latestVersion ? version(item.latestVersion.raw) : undefined,
      installedVersion: version(item.installedVersion?.raw)
    })),
    homebrewRecentlyUpdated: (input.homebrewRecentlyUpdated ?? []).map((record) => ({
      ...record,
      id: record.id ?? record.itemID,
      fromVersion: version(record.fromVersion?.raw),
      toVersion: version(record.toVersion?.raw)
    })),
    profileStats: normalizeProfileStats(input.profileStats, input.startedUsingAt),
    appearancePreference: normalizeAppearancePreference(input.appearancePreference),
    refreshIntervalMinutes: clamp(
      input.refreshIntervalMinutes ?? defaults.refreshIntervalMinutes,
      5,
      1440
    )
  };
}

function normalizeProfileStats(
  input: Partial<ProfileStats> | undefined,
  legacyStartedUsingAt?: unknown
): ProfileStats {
  const defaults = defaultProfileStats();
  const events = Array.isArray(input?.events)
    ? input.events.flatMap((event) => normalizeProfileStatsEvent(event))
    : [];
  return {
    createdAt: typeof input?.createdAt === "string" ? input.createdAt : defaults.createdAt,
    startedUsingAt:
      typeof input?.startedUsingAt === "string"
        ? input.startedUsingAt
        : typeof legacyStartedUsingAt === "string"
          ? legacyStartedUsingAt
          : defaults.startedUsingAt,
    signatureVersion:
      typeof input?.signatureVersion === "number"
        ? input.signatureVersion
        : defaults.signatureVersion,
    events,
    signature: typeof input?.signature === "string" ? input.signature : undefined,
    integrityStatus: "pending"
  };
}

function normalizeProfileStatsEvent(input: Partial<ProfileStatsEvent>): ProfileStatsEvent[] {
  if (
    typeof input.id !== "string" ||
    typeof input.targetID !== "string" ||
    typeof input.displayName !== "string" ||
    typeof input.occurredAt !== "string"
  ) {
    return [];
  }
  const type = normalizeProfileStatsEventType(input.type);
  const channel = normalizeProfileStatsChannel(input.channel);
  if (!type || !channel) {
    return [];
  }
  return [
    {
      id: input.id,
      type,
      targetID: input.targetID,
      displayName: input.displayName,
      channel,
      occurredAt: input.occurredAt
    }
  ];
}

function normalizeProfileStatsEventType(value: unknown): ProfileStatsEvent["type"] | undefined {
  if (value === "appUpdate" || value === "homebrewUpdate" || value === "homebrewInstall") {
    return value;
  }
  return undefined;
}

function normalizeProfileStatsChannel(value: unknown): ProfileStatsEvent["channel"] | undefined {
  if (
    value === "appStore" ||
    value === "sparkle" ||
    value === "homebrew" ||
    value === "web" ||
    value === "unknown"
  ) {
    return value;
  }
  return undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
