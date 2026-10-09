// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  PersistedSnapshot,
  ProfileStats,
  ProfileStatsEvent,
  ProfileStatsResetNotice
} from "../shared/domain";
import {
  defaultPersistedSnapshot,
  defaultProfileStats,
  normalizeAppearancePreference
} from "../shared/domain";
import { version } from "../shared/version";
export { defaultPersistedSnapshot };

export class SnapshotPersistence {
  private readonly snapshotPath: string;
  private readonly backupPath: string;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.snapshotPath = path.join(userDataPath, "baseline-snapshot.json");
    this.backupPath = `${this.snapshotPath}.backup`;
  }

  async load(): Promise<PersistedSnapshot> {
    await this.saveQueue;
    for (const candidate of [this.snapshotPath, this.backupPath]) {
      const saved = await readSnapshot(candidate);
      if (saved) {
        return saved.snapshot;
      }
    }
    return defaultPersistedSnapshot();
  }

  async save(snapshot: PersistedSnapshot): Promise<void> {
    // Capture at call time, before another store mutation can change the snapshot.
    const contents = `${JSON.stringify(snapshot, null, 2)}\n`;
    const save = this.saveQueue.then(async () => {
      await mkdir(path.dirname(this.snapshotPath), { recursive: true });
      const previous = await readSnapshot(this.snapshotPath, true);
      const backup = previous ?? (await readSnapshot(this.backupPath, true));
      // Never replace a valid backup with a corrupt primary during recovery.
      await replaceSnapshot(this.backupPath, backup?.contents ?? contents);
      await replaceSnapshot(this.snapshotPath, contents);
    });
    this.saveQueue = save.catch(() => undefined);
    await save;
  }
}

async function readSnapshot(
  snapshotPath: string,
  rejectReadErrors = false
): Promise<{ contents: string; snapshot: PersistedSnapshot } | undefined> {
  let contents: string;
  try {
    contents = await readFile(snapshotPath, "utf8");
  } catch (error) {
    if (rejectReadErrors && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
  try {
    const input: unknown = JSON.parse(contents);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return undefined;
    }
    return { contents, snapshot: normalizeSnapshot(input as Partial<PersistedSnapshot>) };
  } catch {
    return undefined;
  }
}

async function replaceSnapshot(snapshotPath: string, contents: string): Promise<void> {
  const temporaryPath = `${snapshotPath}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, snapshotPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
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
    profileStatsResetAcknowledgedID:
      typeof input.profileStatsResetAcknowledgedID === "string"
        ? input.profileStatsResetAcknowledgedID
        : undefined,
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
    resetNotice: normalizeProfileStatsResetNotice(input?.resetNotice),
    signature: typeof input?.signature === "string" ? input.signature : undefined,
    integrityStatus: "pending"
  };
}

function normalizeProfileStatsEvent(input: unknown): ProfileStatsEvent[] {
  if (!input || typeof input !== "object") {
    return [];
  }
  const event = input as Partial<ProfileStatsEvent>;
  if (
    typeof event.id !== "string" ||
    typeof event.targetID !== "string" ||
    typeof event.displayName !== "string" ||
    typeof event.occurredAt !== "string"
  ) {
    return [];
  }
  const type = normalizeProfileStatsEventType(event.type);
  const channel = normalizeProfileStatsChannel(event.channel);
  if (!type || !channel) {
    return [];
  }
  return [
    {
      id: event.id,
      type,
      targetID: event.targetID,
      displayName: event.displayName,
      channel,
      occurredAt: event.occurredAt
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

function normalizeProfileStatsResetNotice(input: unknown): ProfileStatsResetNotice | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const notice = input as Partial<ProfileStatsResetNotice>;
  if (
    typeof notice.id === "string" &&
    typeof notice.occurredAt === "string" &&
    notice.reason === "tamper"
  ) {
    return {
      id: notice.id,
      occurredAt: notice.occurredAt,
      reason: notice.reason
    };
  }
  return undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
