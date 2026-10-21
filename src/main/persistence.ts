// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { profileStatsCountsAreSafe } from "../shared/profileStats";
import { macOSManagedPath } from "./macOSManagedApps";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  PersistedSnapshot,
  AppRecord,
  UpdateRecord,
  AppUpdateComparison,
  RecentlyUpdatedRecord,
  HomebrewManagedItem,
  HomebrewCaskEntry,
  HomebrewRecentlyUpdatedRecord,
  ProfileStats,
  ProfileStatsEvent,
  ProfileStatsLifetime,
  ProfileStatsLifetimeSeal,
  ProfileStatsResetNotice
} from "../shared/domain";
import {
  defaultPersistedSnapshot,
  defaultProfileStats,
  normalizeAppearancePreference
} from "../shared/domain";
import { version } from "../shared/version";
import { normalizeOperationFailures } from "../shared/operationFailures";
import { normalizeAppProviderChecks } from "./appProviderChecks";
import { normalizeAppVisibility } from "../shared/appVisibility";
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
    return { contents, snapshot: normalizeSnapshot(input as SavedRecord) };
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

type SavedRecord = Record<string, unknown>;

function normalizeSnapshot(input: SavedRecord): PersistedSnapshot {
  const defaults = defaultPersistedSnapshot();
  const updates = normalizeRows(input.updates, normalizeUpdate);
  return {
    // Only persisted fields may cross this boundary; runtime locks and tool evidence cannot.
    ...normalizeAppVisibility(input),
    appProviderChecks: normalizeAppProviderChecks(input.appProviderChecks),
    operationFailures: normalizeOperationFailures(input.operationFailures),
    selectedTab: "all",
    apps: normalizeRows(input.apps, normalizeApp),
    updates,
    // Only absent legacy baselines migrate from updates. A damaged present baseline
    // must not turn partial display results into reconciled comparison evidence.
    appUpdateComparisonBaseline: normalizeRows(
      input.appUpdateComparisonBaseline === undefined ? updates : input.appUpdateComparisonBaseline,
      normalizeComparison
    ),
    recentlyUpdated: normalizeRows(input.recentlyUpdated, normalizeRecentApp),
    homebrewItems: normalizeRows(input.homebrewItems, normalizeHomebrewItem),
    homebrewFormulaIdentityContinuity:
      input.homebrewFormulaIdentityContinuity === undefined
        ? undefined
        : normalizeRows(input.homebrewFormulaIdentityContinuity, normalizeHomebrewItem)
            .filter((item) => item.kind === "formula")
            .map((item) => ({
              ...item,
              formulaIdentityVerified: false,
              isOutdated: false,
              latestVersion: undefined
            })),
    homebrewRecentlyUpdated: normalizeRows(input.homebrewRecentlyUpdated, normalizeRecentHomebrew),
    ignoredIDs: strings(input.ignoredIDs),
    ignoredHomebrewItemIDs: strings(input.ignoredHomebrewItemIDs),
    additionalDirectories: strings(input.additionalDirectories),
    collapsedAppSectionIDs: strings(input.collapsedAppSectionIDs),
    collapsedHomebrewSectionIDs: strings(input.collapsedHomebrewSectionIDs),
    autoRefreshEnabled: boolean(input.autoRefreshEnabled) ?? defaults.autoRefreshEnabled,
    useMasForAppStoreUpdates:
      boolean(input.useMasForAppStoreUpdates) ?? defaults.useMasForAppStoreUpdates,
    profileStats: normalizeProfileStats(input.profileStats, input.startedUsingAt),
    profileStatsResetAcknowledgedID:
      typeof input.profileStatsResetAcknowledgedID === "string"
        ? input.profileStatsResetAcknowledgedID
        : undefined,
    appearancePreference: normalizeAppearancePreference(input.appearancePreference),
    refreshIntervalMinutes: clamp(
      typeof input.refreshIntervalMinutes === "number" &&
        Number.isFinite(input.refreshIntervalMinutes)
        ? input.refreshIntervalMinutes
        : defaults.refreshIntervalMinutes,
      5,
      1440
    ),
    lastRefreshDate: text(input.lastRefreshDate)
  };
}

function record(value: unknown): SavedRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SavedRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function savedVersion(value: unknown) {
  return version(text(record(value)?.raw));
}

function optionalVersion(value: unknown) {
  return typeof record(value)?.raw === "string" ? savedVersion(value) : undefined;
}

function normalizeRows<T>(input: unknown, normalize: (value: SavedRecord) => T | undefined): T[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((value) => {
    const object = record(value);
    const normalized = object ? normalize(object) : undefined;
    return normalized ? [normalized] : [];
  });
}

function source(value: unknown): UpdateRecord["source"] | undefined {
  return value === "appStore" ||
    value === "sparkle" ||
    value === "homebrew" ||
    value === "web" ||
    value === "unknown"
    ? value
    : undefined;
}

function normalizeApp(value: SavedRecord): AppRecord | undefined {
  if (typeof value.bundlePath !== "string" || typeof value.displayName !== "string")
    return undefined;
  return {
    id: text(value.id) ?? value.bundlePath,
    bundlePath: value.bundlePath,
    displayName: value.displayName,
    providerFingerprint: text(value.providerFingerprint),
    macOSManagedPath: macOSManagedPath(value.macOSManagedPath),
    bundleIdentifier: text(value.bundleIdentifier),
    localVersion: savedVersion(value.localVersion),
    bundleVersion: optionalVersion(value.bundleVersion),
    sourceHint: source(value.sourceHint) ?? "unknown",
    isIOSAppOnMac: boolean(value.isIOSAppOnMac),
    hasAppStoreEvidence: boolean(value.hasAppStoreEvidence),
    hasSafariWebExtension: boolean(value.hasSafariWebExtension),
    sparkleFeedURL: text(value.sparkleFeedURL),
    iconDataURL: text(value.iconDataURL)
  };
}

function normalizeComparison(value: SavedRecord): AppUpdateComparison | undefined {
  const updateSource = source(value.source);
  if (typeof value.appID !== "string" || !updateSource) return undefined;
  // Malformed versions are not evidence of a previous installed version.
  if (
    !optionalVersion(value.localVersion) ||
    (value.localBuildVersion !== undefined && !optionalVersion(value.localBuildVersion))
  )
    return undefined;
  return {
    appID: value.appID,
    source: updateSource,
    localVersion: savedVersion(value.localVersion),
    localBuildVersion: optionalVersion(value.localBuildVersion)
  };
}

function normalizeUpdate(value: SavedRecord): UpdateRecord | undefined {
  const comparison = normalizeComparison(value);
  const remoteVersion = optionalVersion(value.remoteVersion);
  if (!comparison || !remoteVersion?.raw) return undefined;
  return {
    ...comparison,
    id: text(value.id) ?? comparison.appID,
    remoteVersion,
    remoteBuildVersion: optionalVersion(value.remoteBuildVersion),
    sparkleVersionComparison:
      value.sparkleVersionComparison === "marketing" || value.sparkleVersionComparison === "build"
        ? value.sparkleVersionComparison
        : undefined,
    supportLevel:
      value.supportLevel === "supported" || value.supportLevel === "limited"
        ? value.supportLevel
        : "unsupported",
    updateURL: text(value.updateURL),
    updateURLKind:
      value.source === "sparkle" && value.updateURLKind === "download" ? "download" : undefined,
    appStoreItemID:
      typeof value.appStoreItemID === "number" &&
      Number.isSafeInteger(value.appStoreItemID) &&
      value.appStoreItemID > 0
        ? value.appStoreItemID
        : undefined,
    homebrewToken: text(value.homebrewToken),
    releaseNotesURL: text(value.releaseNotesURL),
    releaseNotesSummary: text(value.releaseNotesSummary),
    releaseDate: text(value.releaseDate),
    checkedAt: text(value.checkedAt) ?? ""
  };
}

function normalizeRecentApp(value: SavedRecord): RecentlyUpdatedRecord | undefined {
  if (
    typeof value.appID !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.updatedAt !== "string"
  )
    return undefined;
  if (!optionalVersion(value.fromVersion) || !optionalVersion(value.toVersion)) return undefined;
  return {
    id: text(value.id) ?? value.appID,
    appID: value.appID,
    displayName: value.displayName,
    source: source(value.source),
    fromVersion: savedVersion(value.fromVersion),
    toVersion: savedVersion(value.toVersion),
    fromBuildVersion: optionalVersion(value.fromBuildVersion),
    toBuildVersion: optionalVersion(value.toBuildVersion),
    updatedAt: value.updatedAt
  };
}

function normalizeHomebrewItem(value: SavedRecord): HomebrewManagedItem | undefined {
  if (
    typeof value.id !== "string" ||
    typeof value.token !== "string" ||
    typeof value.name !== "string" ||
    (value.kind !== "cask" && value.kind !== "formula")
  )
    return undefined;
  const identity = record(value.formulaIdentity);
  return {
    id: value.id,
    token: value.token,
    name: value.name,
    kind: value.kind,
    fullToken: text(value.fullToken),
    tap: text(value.tap),
    caskMetadata: normalizeCaskMetadata(record(value.caskMetadata)),
    formulaIdentity:
      identity &&
      typeof identity.name === "string" &&
      typeof identity.fullName === "string" &&
      typeof identity.tap === "string" &&
      Array.isArray(identity.oldNames) &&
      identity.oldNames.every((name) => typeof name === "string")
        ? {
            name: identity.name,
            fullName: identity.fullName,
            tap: identity.tap,
            oldNames: identity.oldNames
          }
        : undefined,
    formulaIdentityVerified: boolean(value.formulaIdentityVerified),
    pinned: boolean(value.pinned),
    unverifiedPinObservation: boolean(value.unverifiedPinObservation),
    pinnedIdentity: text(value.pinnedIdentity),
    isSelf: boolean(value.isSelf),
    presentation: presentation(value.presentation),
    installedVersion: savedVersion(value.installedVersion),
    latestVersion: optionalVersion(value.latestVersion),
    isOutdated: value.isOutdated === true,
    releaseDate: text(value.releaseDate),
    iconDataURL: text(value.iconDataURL),
    appID: text(value.appID)
  };
}

function presentation(value: unknown): HomebrewManagedItem["presentation"] {
  return value === "formula" ||
    value === "app" ||
    value === "cli" ||
    value === "package" ||
    value === "cask"
    ? value
    : undefined;
}

function normalizeCaskMetadata(value: SavedRecord | undefined): HomebrewCaskEntry | undefined {
  if (!value || typeof value.token !== "string") return undefined;
  // Incomplete artifact lists cannot prove installed app ownership.
  if (
    ![value.bundleIdentifiers, value.appBundleNames].every(
      (list) => Array.isArray(list) && list.every((entry) => typeof entry === "string")
    )
  )
    return undefined;
  return {
    token: value.token,
    fullToken: text(value.fullToken),
    tap: text(value.tap),
    version: savedVersion(value.version),
    homepageURL: text(value.homepageURL),
    presentation: presentation(value.presentation) ?? "cask",
    bundleIdentifiers: strings(value.bundleIdentifiers),
    inferredBundleIdentifiers:
      value.inferredBundleIdentifiers === undefined
        ? undefined
        : strings(value.inferredBundleIdentifiers),
    appBundleNames: strings(value.appBundleNames),
    installedAppPaths:
      value.installedAppPaths === undefined ? undefined : strings(value.installedAppPaths)
  };
}

function normalizeRecentHomebrew(value: SavedRecord): HomebrewRecentlyUpdatedRecord | undefined {
  if (
    typeof value.itemID !== "string" ||
    typeof value.token !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.kind !== "cask" && value.kind !== "formula")
  )
    return undefined;
  if (!optionalVersion(value.fromVersion) || !optionalVersion(value.toVersion)) return undefined;
  return {
    id: text(value.id) ?? value.itemID,
    itemID: value.itemID,
    token: value.token,
    kind: value.kind,
    displayName: value.displayName,
    fromVersion: savedVersion(value.fromVersion),
    toVersion: savedVersion(value.toVersion),
    updatedAt: value.updatedAt
  };
}

function normalizeProfileStats(value: unknown, legacyStartedUsingAt?: unknown): ProfileStats {
  const input = record(value) as Partial<ProfileStats> | undefined;
  const defaults = defaultProfileStats();
  const events = Array.isArray(input?.events)
    ? input.events.flatMap((event) => normalizeProfileStatsEvent(event))
    : [];
  const lifetime = normalizeProfileStatsLifetime(input?.lifetime);
  // Dropping malformed authenticated data must not recreate a previously valid
  // payload (or an empty first-run history). Keep an invalid envelope marker so
  // integrity verification rejects it, even when the original signature matches.
  const malformed =
    (value !== undefined && !input) ||
    (input?.events !== undefined &&
      (!Array.isArray(input.events) || events.length !== input.events.length)) ||
    (input?.createdAt !== undefined && typeof input.createdAt !== "string") ||
    (input?.startedUsingAt !== undefined && typeof input.startedUsingAt !== "string") ||
    (input?.signatureVersion !== undefined &&
      (typeof input.signatureVersion !== "number" ||
        !Number.isSafeInteger(input.signatureVersion))) ||
    (input?.signature !== undefined && typeof input.signature !== "string") ||
    (input !== undefined && Object.hasOwn(input, "lifetime") && !lifetime) ||
    (input?.resetNotice !== undefined && !normalizeProfileStatsResetNotice(input.resetNotice));
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
    lifetime,
    lifetimeSeal: malformed ? null : normalizeProfileStatsLifetimeSeal(input),
    resetNotice: normalizeProfileStatsResetNotice(input?.resetNotice),
    signature: typeof input?.signature === "string" ? input.signature : undefined,
    integrityStatus: "pending"
  };
}

function normalizeProfileStatsLifetimeSeal(
  input: Partial<ProfileStats> | undefined
): ProfileStatsLifetimeSeal | null | undefined {
  if (!input || (!Object.hasOwn(input, "lifetime") && !Object.hasOwn(input, "lifetimeSeal")))
    return undefined;
  // Preserve aggregate-only v3 drafts for full-payload verification, never legacy fallback.
  if (input.signatureVersion === 3 && !Object.hasOwn(input, "lifetimeSeal")) return undefined;
  const seal = input.lifetimeSeal;
  if (
    !normalizeProfileStatsLifetime(input.lifetime) ||
    !seal ||
    seal.version !== 1 ||
    typeof seal.eventSignature !== "string" ||
    typeof seal.signature !== "string"
  )
    return null;
  return { version: 1, eventSignature: seal.eventSignature, signature: seal.signature };
}

function normalizeProfileStatsLifetime(input: unknown): ProfileStatsLifetime | undefined {
  if (!input || typeof input !== "object") return undefined;
  const lifetime = input as Partial<ProfileStatsLifetime>;
  if (
    (lifetime.coverage !== "complete" && lifetime.coverage !== "lowerBound") ||
    !Array.isArray(lifetime.entries)
  )
    return undefined;
  const entries: ProfileStatsLifetime["entries"] = [];
  for (const inputEntry of lifetime.entries) {
    if (!inputEntry || typeof inputEntry !== "object") return undefined;
    const entry = inputEntry as Partial<ProfileStatsLifetime["entries"][number]>;
    const type = normalizeProfileStatsEventType(entry.type);
    const channel = normalizeProfileStatsChannel(entry.channel);
    if (
      !type ||
      !channel ||
      typeof entry.targetID !== "string" ||
      typeof entry.displayName !== "string" ||
      typeof entry.count !== "number" ||
      !Number.isSafeInteger(entry.count) ||
      entry.count <= 0
    )
      return undefined;
    entries.push({
      type,
      channel,
      targetID: entry.targetID,
      displayName: entry.displayName,
      count: entry.count
    });
  }
  return profileStatsCountsAreSafe(entries) ? { coverage: lifetime.coverage, entries } : undefined;
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
