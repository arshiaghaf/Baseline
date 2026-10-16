// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  HomebrewCaskEntry,
  HomebrewCaskIndex,
  HomebrewFormulaIndex,
  HomebrewManagedItem,
  HomebrewManagedItemKind,
  HomebrewRecentlyUpdatedRecord,
  MenuTab,
  PersistedSnapshot,
  ProfileStats,
  ProfileStatsEvent,
  SelfUpdateRecord,
  SnapshotProgress,
  SnapshotProgressEvent,
  UpdateRecord
} from "../shared/domain";
import {
  defaultProfileStatsAfterTamper,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  normalizeAppearancePreference
} from "../shared/domain";
import { type HomebrewMaintenanceRunEvent } from "../shared/homebrewProgress";
import {
  caskIndexForInstalledItems,
  homebrewCommandToken,
  homebrewItemIdentity,
  installedCaskEntry
} from "../shared/homebrewIdentity";
import type { PreferencePatch } from "../shared/ipc";
import { isAllowedExternalURL, isValidHomebrewToken } from "../shared/security";
import {
  compareVersions,
  isVersionEmpty,
  isVersionGreater,
  version,
  type VersionValue
} from "../shared/version";
import { AppStoreLookupClient } from "./appStoreLookupClient";
import { BundleScannerClient } from "./bundleScanner";
import {
  runBrewCommand as defaultRunBrewCommand,
  runMasCommand as defaultRunMasCommand,
  type CommandResult
} from "./commandRunner";
import { HomebrewCommandService, type HomebrewCommandHost } from "./homebrewCommandService";
import { HomebrewCaskClient } from "./homebrewCaskClient";
import { HomebrewFormulaClient } from "./homebrewFormulaClient";
import { HomebrewInventoryClient, type HomebrewInventoryResult } from "./homebrewInventoryClient";
import { SnapshotPersistence } from "./persistence";
import { KeychainProfileStatsIntegrity, type ProfileStatsIntegrity } from "./profileStatsIntegrity";
import { SelfUpdateClient } from "./selfUpdateClient";
import { normalizeAppVisibility } from "../shared/appVisibility";
import { SparkleAppcastClient } from "./sparkleAppcastClient";
import { ProgressPublisher } from "./progressPublisher";
import {
  failureReason,
  normalizeOperationFailures,
  type OperationFailure
} from "../shared/operationFailures";
import type { CatalogueStatus } from "./catalogueCache";
import { isSparkleVersionNewer, sparkleMarketingVersion } from "../shared/sparkleVersion";

type StoreEvents = {
  snapshot: [BaselineSnapshot];
  progress: [SnapshotProgressEvent];
  homebrewCommand: [HomebrewMaintenanceRunEvent];
};

type RefreshOptions = {
  allowHomebrewInventoryDuringActiveCommand?: boolean;
  forceMetadata?: boolean;
  onHomebrewInventoryReconciled?: (inventory: HomebrewInventoryResult) => void;
};

type AppLookupSource = Extract<UpdateRecord["source"], "appStore" | "sparkle">;
type HomebrewCaskSource = Pick<HomebrewCaskClient, "fetchIndex" | "lookupUpdate" | "searchCasks"> &
  Partial<Pick<HomebrewCaskClient, "cacheStatus">>;
type HomebrewFormulaSource = Pick<HomebrewFormulaClient, "fetchIndex" | "searchFormulae"> &
  Partial<Pick<HomebrewFormulaClient, "cacheStatus">>;

const successfulUpdateHoldMs = 2000;

export class UpdateStore extends EventEmitter<StoreEvents> {
  private readonly persistence: SnapshotPersistence;
  private readonly scanner: Pick<BundleScannerClient, "scanApplications">;
  private readonly appStore: Pick<AppStoreLookupClient, "lookupOutcome">;
  private readonly sparkle: Pick<SparkleAppcastClient, "lookupOutcome">;
  private readonly homebrew: HomebrewCaskSource;
  private readonly homebrewFormula: HomebrewFormulaSource;
  private readonly homebrewInventory: Pick<HomebrewInventoryClient, "fetchInventory">;
  private readonly selfUpdate: Pick<SelfUpdateClient, "lookup">;
  private selfUpdateCheckTask?: Promise<SelfUpdateRecord | undefined>;
  private readonly currentAppVersion: VersionValue;
  private readonly currentAppIdentity?: { bundlePath?: string; bundleIdentifier?: string };
  private readonly runBrewCommand: typeof defaultRunBrewCommand;
  private readonly runMasCommand: typeof defaultRunMasCommand;
  private readonly openExternalURL: (url: string) => Promise<boolean>;
  private readonly openAppBundle: (bundlePath: string) => Promise<void>;
  private readonly profileStatsIntegrity: ProfileStatsIntegrity;
  private readonly homebrewCommands: HomebrewCommandService;
  private refreshTask?: Promise<void>;
  private cleanupRefreshTask?: Promise<void>;
  private cleanupRefreshRequested = false;
  private homebrewCleanupRequiresInventory = false;
  private refreshSequence = 0;
  private refreshController?: AbortController;
  private autoRefreshTimer?: NodeJS.Timeout;
  private latestHomebrewIndex: HomebrewCaskIndex = emptyHomebrewCaskIndex;
  private latestHomebrewFormulaIndex: HomebrewFormulaIndex = emptyHomebrewFormulaIndex;
  private hasCheckedHomebrewAvailability = false;
  private profileStatsMutationQueue: Promise<void> = Promise.resolve();
  private activeHomebrewInventoryCount = 0;
  private homebrewRefreshLockSequence?: number;
  private activeHomebrewInventoryTask?: {
    updateMetadata: boolean;
    task: Promise<HomebrewInventoryResult>;
  };

  private state: BaselineSnapshot;
  private snapshotRevision = 0;
  private readonly progressPublisher = new ProgressPublisher((event) =>
    this.emit("progress", event)
  );

  constructor(options: {
    persistence: SnapshotPersistence;
    persisted: PersistedSnapshot;
    openExternalURL: (url: string) => Promise<boolean>;
    openAppBundle: (bundlePath: string) => Promise<void>;
    clients?: Partial<{
      scanner: Pick<BundleScannerClient, "scanApplications">;
      appStore: Pick<AppStoreLookupClient, "lookupOutcome">;
      sparkle: Pick<SparkleAppcastClient, "lookupOutcome">;
      homebrew: HomebrewCaskSource;
      homebrewFormula: HomebrewFormulaSource;
      homebrewInventory: Pick<HomebrewInventoryClient, "fetchInventory">;
      selfUpdate: Pick<SelfUpdateClient, "lookup">;
    }>;
    currentAppVersion?: string;
    currentAppIdentity?: { bundlePath?: string; bundleIdentifier?: string };
    runBrewCommand?: typeof defaultRunBrewCommand;
    runMasCommand?: typeof defaultRunMasCommand;
    profileStatsIntegrity?: ProfileStatsIntegrity;
    successRefreshDelayMS?: number;
  }) {
    super();
    this.persistence = options.persistence;
    this.scanner = options.clients?.scanner ?? new BundleScannerClient();
    this.appStore = options.clients?.appStore ?? new AppStoreLookupClient();
    this.sparkle = options.clients?.sparkle ?? new SparkleAppcastClient();
    this.homebrew = options.clients?.homebrew ?? new HomebrewCaskClient();
    this.homebrewFormula = options.clients?.homebrewFormula ?? new HomebrewFormulaClient();
    this.homebrewInventory = options.clients?.homebrewInventory ?? new HomebrewInventoryClient();
    this.selfUpdate = options.clients?.selfUpdate ?? new SelfUpdateClient();
    this.currentAppVersion = version(options.currentAppVersion);
    this.currentAppIdentity = options.currentAppIdentity;
    this.runBrewCommand = options.runBrewCommand ?? defaultRunBrewCommand;
    this.runMasCommand = options.runMasCommand ?? defaultRunMasCommand;
    this.openExternalURL = options.openExternalURL;
    this.openAppBundle = options.openAppBundle;
    this.profileStatsIntegrity =
      options.profileStatsIntegrity ?? new KeychainProfileStatsIntegrity();
    const persisted = this.excludeSelfUpdates(
      sanitizePersistedSnapshotForRuntime(options.persisted)
    );
    this.state = {
      ...persisted,
      operationFailures: normalizeOperationFailures(persisted.operationFailures),
      isMasInstalled: false,
      isHomebrewInstalled: false,
      isChecking: false,
      isRefreshing: false,
      searchText: "",
      isRunningHomebrewMaintenance: false,
      isHomebrewCommandLocked: false,
      isHomebrewCleanupLocked: false,
      isCleaningUpHomebrew: false,
      appUpdatingIDs: [],
      appUpdatedPendingRefreshIDs: [],
      homebrewUpdatingItemIDs: [],
      homebrewQueuedItemIDs: [],
      homebrewUninstallingItemIDs: [],
      homebrewUpdatedPendingRefreshItemIDs: [],
      homebrewBatchProgressByItemID: {},
      homebrewBatchFailedItemIDs: [],
      homebrewFallbackProgressByAppID: {},
      homebrewFallbackFailedAppIDs: [],
      homebrewDiscoverItems: [],
      homebrewDiscoverInstallingItemIDs: [],
      homebrewDiscoverInstalledPendingRefreshItemIDs: [],
      homebrewDiscoverFailedItemIDs: [],
      homebrewDiscoverProgressByItemID: {},
      laggingHomebrewCaskTokens: [],
      defaultScanDirectories: this.defaultScanDirectories()
    };
    this.homebrewCommands = new HomebrewCommandService(
      this.createHomebrewCommandHost(),
      options.successRefreshDelayMS ?? successfulUpdateHoldMs
    );
  }

  private isSelfApp(app: AppRecord): boolean {
    const own = this.currentAppIdentity;
    return Boolean(
      own &&
      ((own.bundlePath && path.resolve(app.bundlePath) === path.resolve(own.bundlePath)) ||
        (own.bundleIdentifier &&
          app.bundleIdentifier?.toLowerCase() === own.bundleIdentifier.toLowerCase()))
    );
  }

  private excludeSelfUpdates<T extends PersistedSnapshot>(snapshot: T): T {
    const ownApps = snapshot.apps.filter((app) => this.isSelfApp(app));
    // The running bundle remains identifiable even if a scan temporarily cannot read it.
    const bundlePath = this.currentAppIdentity?.bundlePath;
    if (
      bundlePath &&
      !ownApps.some((app) => path.resolve(app.bundlePath) === path.resolve(bundlePath))
    ) {
      ownApps.push({
        id: bundlePath,
        bundlePath,
        displayName: path.basename(bundlePath, ".app"),
        bundleIdentifier: this.currentAppIdentity?.bundleIdentifier,
        localVersion: this.currentAppVersion,
        sourceHint: "unknown"
      });
    }
    const ownIDs = new Set(ownApps.map((app) => app.id));
    return {
      ...snapshot,
      updates: snapshot.updates.filter((update) => !ownIDs.has(update.appID)),
      homebrewItems: snapshot.homebrewItems.map((item) => {
        const entry = installedCaskEntry(item, emptyHomebrewCaskIndex);
        const isSelf =
          item.kind === "cask" &&
          Boolean(entry && ownApps.some((app) => installedCaskIdentifiesSelf(app, entry)));
        if (isSelf) return { ...item, isSelf: true, isOutdated: false, latestVersion: undefined };
        if (item.isSelf) {
          const other = { ...item };
          delete other.isSelf;
          return other;
        }
        return item;
      })
    };
  }

  async start(): Promise<void> {
    await this.refreshToolStatus();
    this.restartAutoRefreshLoop();
    void this.refresh(false);
  }

  getSnapshot(): BaselineSnapshot {
    return structuredClone({ ...this.state, snapshotRevision: this.snapshotRevision });
  }

  async verifyProfileStatsIntegrity(): Promise<void> {
    await this.runProfileStatsMutation(async () => {
      const profileStatsBeforeVerification = this.state.profileStats;
      const verifiedProfileStats = await this.profileStatsIntegrity.verifyOrInitialize(
        profileStatsBeforeVerification
      );
      const profileStats = await this.reconcileVerifiedProfileStats(
        profileStatsBeforeVerification,
        verifiedProfileStats
      );
      this.patch({ profileStats });
      await this.persist();
    });
  }

  async refresh(lightweight = false, options: RefreshOptions = {}): Promise<void> {
    if (this.cleanupRefreshTask) {
      this.cleanupRefreshRequested = true;
      await this.cleanupRefreshTask;
      if (lightweight) return;
      // A mutation after cleanup's scan began still needs its own full scan.
      return this.refresh(false, options);
    }
    if (this.refreshTask && lightweight) {
      return this.waitForRefreshCompletion(this.refreshTask);
    }
    const sequence = ++this.refreshSequence;
    this.refreshController?.abort();
    const controller = new AbortController();
    this.refreshController = controller;
    const task = this.computeRefresh(lightweight, sequence, options, controller.signal).finally(
      () => {
        if (this.refreshTask === task) {
          this.refreshTask = undefined;
          this.refreshController = undefined;
        }
      }
    );
    this.refreshTask = task;
    return this.waitForRefreshCompletion(task);
  }

  private async waitForRefreshCompletion(task: Promise<void>): Promise<void> {
    // Superseded callers must observe the winning scan's commit, not merely the
    // completion of their own aborted generation.
    for (;;) {
      try {
        await task;
      } catch (error) {
        if (!this.refreshTask || this.refreshTask === task) throw error;
      }
      if (this.cleanupRefreshTask) await this.cleanupRefreshTask;
      const next = this.refreshTask;
      if (!next || next === task) return;
      task = next;
    }
  }

  async refreshToolStatus(): Promise<void> {
    this.patch({ isChecking: true });
    const masStatus = this.runMasCommand(["version"]);
    const releaseHomebrewCommandLock = this.homebrewCommands.reserveHomebrewCommandLock();
    let brew: CommandResult | undefined;
    try {
      brew = releaseHomebrewCommandLock ? await this.runBrewCommand(["--version"]) : undefined;
    } finally {
      releaseHomebrewCommandLock?.();
    }
    if (brew) {
      this.hasCheckedHomebrewAvailability = true;
    }
    const mas = await masStatus;
    this.patch({
      isMasInstalled: mas.success,
      ...(brew ? { isHomebrewInstalled: brew.success } : {}),
      isChecking: false
    });
  }

  async setSearchText(searchText: string): Promise<void> {
    this.patch({ searchText });
    await this.refreshHomebrewDiscoverItems();
  }

  async setSelectedTab(selectedTab: MenuTab): Promise<void> {
    this.patch({ selectedTab });
  }

  async updatePreferences(patch: PreferencePatch): Promise<void> {
    const refreshIntervalMinutes =
      patch.refreshIntervalMinutes === undefined
        ? this.state.refreshIntervalMinutes
        : Math.min(Math.max(Math.trunc(patch.refreshIntervalMinutes), 5), 1440);
    const appearancePreference = normalizeAppearancePreference(
      patch.appearancePreference ?? this.state.appearancePreference
    );
    const visibility = normalizeAppVisibility({
      showDockIcon: patch.showDockIcon ?? this.state.showDockIcon,
      showMenuBarIcon:
        patch.showMenuBarIcon ?? (patch.showDockIcon === false ? true : this.state.showMenuBarIcon)
    });
    this.patch({ ...patch, ...visibility, appearancePreference, refreshIntervalMinutes });
    this.restartAutoRefreshLoop();
    await this.persist();
  }

  async checkForSelfUpdate(): Promise<SelfUpdateRecord | undefined> {
    if (this.selfUpdateCheckTask) return this.selfUpdateCheckTask;
    const task = this.lookupSelfUpdate(new Date().toISOString()).then((selfUpdate) => {
      this.patch({ selfUpdate });
      return selfUpdate;
    });
    this.selfUpdateCheckTask = task;
    try {
      return await task;
    } finally {
      if (this.selfUpdateCheckTask === task) this.selfUpdateCheckTask = undefined;
    }
  }

  hasActiveUpdateOperation(): boolean {
    return (
      this.homebrewCommands.activeCommandCount > 0 ||
      this.state.isRunningHomebrewMaintenance ||
      this.state.isHomebrewCleanupLocked ||
      this.state.appUpdatingIDs.length > 0 ||
      this.state.homebrewUpdatingItemIDs.length > 0 ||
      this.state.homebrewQueuedItemIDs.length > 0 ||
      this.state.homebrewUninstallingItemIDs.length > 0 ||
      this.state.homebrewDiscoverInstallingItemIDs.length > 0
    );
  }

  async prepareToQuit(): Promise<boolean> {
    await this.profileStatsMutationQueue;
    await this.persist();
    if (this.hasActiveUpdateOperation()) return false;
    if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
    ++this.refreshSequence;
    this.refreshController?.abort();
    return true;
  }

  async toggleIgnoredApp(appID: string): Promise<void> {
    const ignored = new Set(this.state.ignoredIDs);
    toggleSet(ignored, appID);
    this.patch({ ignoredIDs: [...ignored].sort() });
    await this.persist();
  }

  async toggleIgnoredHomebrew(itemID: string): Promise<void> {
    const ignored = new Set(this.state.ignoredHomebrewItemIDs);
    toggleSet(ignored, itemID);
    this.patch({ ignoredHomebrewItemIDs: [...ignored].sort() });
    await this.persist();
  }

  async acknowledgeProfileStatsReset(): Promise<void> {
    const resetID = this.state.profileStats.resetNotice?.id;
    if (!resetID || this.state.profileStatsResetAcknowledgedID === resetID) {
      return;
    }
    this.patch({ profileStatsResetAcknowledgedID: resetID });
    await this.persist();
  }

  async dismissOperationFailure(id: string): Promise<void> {
    const failures = this.state.operationFailures ?? [];
    const remaining = failures.filter((failure) => failure.id !== id);
    if (remaining.length === failures.length) return;
    this.patch({ operationFailures: remaining });
    await this.persistFailureDetails();
  }

  private clearOperationFailure(entityID: string, operation: OperationFailure["operation"]): void {
    const failures = this.state.operationFailures ?? [];
    const remaining = failures.filter(
      (failure) => failure.entityID !== entityID || failure.operation !== operation
    );
    if (remaining.length === failures.length) return;
    this.patch({ operationFailures: remaining });
    void this.persistFailureDetails();
  }

  private async recordOperationFailure(
    entityID: string,
    operation: OperationFailure["operation"],
    result: CommandResult,
    reason?: OperationFailure["reason"]
  ): Promise<void> {
    await this.recordOperationFailures([{ entityID, operation, result, reason }]);
  }

  private async recordOperationFailures(
    failures: Array<{
      entityID: string;
      operation: OperationFailure["operation"];
      result: CommandResult;
      reason?: OperationFailure["reason"];
    }>
  ): Promise<void> {
    if (failures.length === 0) return;
    const occurredAt = new Date().toISOString();
    const records = failures.map(({ entityID, operation, result, reason }): OperationFailure => ({
      id: `${operation}:${entityID}`,
      entityID,
      operation,
      reason: reason ?? failureReason(result.stderr || result.output),
      status: result.status,
      occurredAt
    }));
    const ids = new Set(records.map((record) => record.id));
    this.patch({
      operationFailures: normalizeOperationFailures([
        ...records,
        ...(this.state.operationFailures ?? []).filter((previous) => !ids.has(previous.id))
      ])
    });
    await this.persistFailureDetails();
  }

  private async persistFailureDetails(): Promise<void> {
    try {
      await this.persist();
    } catch {
      this.patch({
        lastRefreshNoticeMessage:
          "Failure details could not be saved. They remain available until Baseline quits."
      });
    }
  }

  async addDirectory(directory: string): Promise<void> {
    const resolved = path.resolve(directory);
    if (
      this.state.additionalDirectories.some((candidate) => path.resolve(candidate) === resolved)
    ) {
      return;
    }
    const directories = [...this.state.additionalDirectories, resolved];
    this.patch({ additionalDirectories: directories });
    await this.persist();
    await this.refresh(false, { forceMetadata: false });
  }

  async removeDirectory(directory: string): Promise<void> {
    const resolved = path.resolve(directory);
    const directories = this.state.additionalDirectories.filter(
      (candidate) => path.resolve(candidate) !== resolved
    );
    if (directories.length === this.state.additionalDirectories.length) {
      return;
    }
    this.patch({
      additionalDirectories: directories
    });
    await this.persist();
    await this.refresh(false, { forceMetadata: false });
  }

  async openApp(appID: string): Promise<void> {
    const appRecord = this.state.apps.find((app) => app.id === appID);
    if (appRecord) {
      await this.openAppBundle(appRecord.bundlePath);
    }
  }

  async openExternal(url: string): Promise<boolean> {
    if (!isAllowedExternalURL(url)) {
      this.patch({ refreshErrorMessage: "Blocked an unsafe external link." });
      return false;
    }
    return this.openExternalURL(url);
  }

  async performAppUpdate(appID: string): Promise<void> {
    const appRecord = this.state.apps.find((app) => app.id === appID);
    if (!appRecord) {
      return;
    }
    const update = this.state.updates.find((candidate) => candidate.appID === appID);
    if (!update) {
      await this.openAppBundle(appRecord.bundlePath);
      return;
    }

    if (
      this.state.useMasForAppStoreUpdates &&
      update.source === "appStore" &&
      update.appStoreItemID
    ) {
      await this.withAppUpdating(appID, async () => {
        this.clearOperationFailure(appID, "update");
        const result = await this.runMasCommand(["upgrade", String(update.appStoreItemID)]);
        if (result.success) {
          this.patch({
            appUpdatedPendingRefreshIDs: addToArray(this.state.appUpdatedPendingRefreshIDs, appID)
          });
          await this.recordProfileStatsEvents([
            appUpdateProfileStatsEvent({
              appRecord,
              update,
              occurredAt: new Date().toISOString()
            })
          ]);
          await this.homebrewCommands.holdSuccessfulUpdate();
          await this.refresh(false, { forceMetadata: false });
        } else {
          await this.recordOperationFailure(appID, "update", result);
          await this.routeExternalUpdate(appRecord, update);
        }
      });
      return;
    }

    if (update.source === "homebrew" && update.homebrewToken) {
      if (!isValidHomebrewToken(update.homebrewToken)) {
        this.patch({
          refreshErrorMessage: `Blocked unsafe Homebrew token for ${appRecord.displayName}.`
        });
        return;
      }
      const item = this.matchingHomebrewItemForApp(appRecord);
      if (item?.pinned) return;
      if (item && homebrewItemCanRunAppUpdate(item, update)) {
        await this.homebrewCommands.performHomebrewItemUpdate(item, {
          profileStatsEvent: appUpdateProfileStatsEvent({
            appRecord,
            update,
            occurredAt: new Date().toISOString()
          }),
          appUpdateAppID: appID,
          requiredRemoteVersion: update.remoteVersion
        });
        return;
      }
      await this.routeExternalUpdate(appRecord, { ...update, updateURL: undefined });
      return;
    }

    await this.routeExternalUpdate(appRecord, update);
  }

  async performHomebrewUpdate(itemID: string): Promise<void> {
    await this.homebrewCommands.performHomebrewUpdate(itemID);
  }

  async performHomebrewUpdateAll(itemIDs?: string[]): Promise<void> {
    await this.homebrewCommands.performHomebrewUpdateAll(itemIDs);
  }

  async installHomebrewItem(item: HomebrewCaskDiscoveryItem): Promise<void> {
    await this.homebrewCommands.installHomebrewItem(item);
  }

  async uninstallHomebrewItem(itemID: string): Promise<void> {
    await this.homebrewCommands.uninstallHomebrewItem(itemID);
  }

  private async computeRefresh(
    lightweight: boolean,
    sequence: number,
    options: RefreshOptions,
    signal: AbortSignal
  ): Promise<void> {
    this.homebrewRefreshLockSequence = sequence;
    this.homebrewCommands.updateHomebrewCommandLockState();
    this.patch({
      isRefreshing: true,
      refreshErrorMessage: undefined,
      lastRefreshNoticeMessage: undefined
    });
    const now = new Date().toISOString();
    const force =
      options.forceMetadata ?? (!lightweight && !options.allowHomebrewInventoryDuringActiveCommand);
    let homebrewInventoryTask: Promise<HomebrewInventoryResult> | undefined;
    try {
      homebrewInventoryTask = this.fetchHomebrewInventory(lightweight, options);
      const [apps, catalogueIndex, homebrewFormulaIndex, homebrewInventory, selfUpdate] =
        await Promise.all([
          this.scanner.scanApplications(this.scanDirectories()),
          this.homebrew.fetchIndex({ force }),
          this.homebrewFormula.fetchIndex({ force }),
          homebrewInventoryTask,
          this.lookupSelfUpdate(now)
        ]);
      if (sequence !== this.refreshSequence) {
        return;
      }
      const homebrewItems = preservePreviousHomebrewInventoryMembership(
        homebrewInventory.items,
        this.state.homebrewItems,
        homebrewInventory.inventoryReadSucceededByKind,
        this.state.homebrewFormulaIdentityContinuity
      );
      const homebrewIndex = caskIndexForInstalledItems(catalogueIndex, homebrewItems);
      this.latestHomebrewIndex = homebrewIndex;
      this.latestHomebrewFormulaIndex = homebrewFormulaIndex;
      const previousUpdates = new Map(this.state.updates.map((update) => [update.appID, update]));
      const updates: UpdateRecord[] = [];

      for (const appRecord of apps) {
        if (this.isSelfApp(appRecord)) continue;
        if (signal.aborted || sequence !== this.refreshSequence) return;
        if (appRecord.bundleIdentifier) {
          const outcome = await this.appStore.lookupOutcome(
            appRecord.bundleIdentifier,
            appRecord.localVersion,
            {
              signal,
              force,
              includeIOSAppStoreSoftware:
                appRecord.isIOSAppOnMac === true && appRecord.hasAppStoreEvidence === true,
              includeMacCapableAppStoreSoftware:
                appRecord.isIOSAppOnMac !== true && appRecord.hasSafariWebExtension === true
            }
          );
          if (signal.aborted || sequence !== this.refreshSequence) return;
          if (outcome.type === "completed" && outcome.value) {
            updates.push({
              id: appRecord.id,
              appID: appRecord.id,
              source: "appStore",
              supportLevel: "supported",
              localVersion: appRecord.localVersion,
              remoteVersion: outcome.value.remoteVersion,
              updateURL: outcome.value.updateURL,
              appStoreItemID: outcome.value.appStoreItemID,
              releaseNotesSummary: outcome.value.releaseNotesSummary,
              releaseDate: outcome.value.releaseDate,
              checkedAt: outcome.checkedAt ?? now
            });
            continue;
          }
          if (outcome.type === "transientFailure") {
            const previousUpdate = previousAppUpdateForTransientLookup(
              previousUpdates,
              appRecord,
              "appStore"
            );
            if (previousUpdate) {
              updates.push(previousUpdate);
              continue;
            }
          }
        }

        if (appRecord.sparkleFeedURL) {
          const outcome = await this.sparkle.lookupOutcome(
            appRecord.sparkleFeedURL,
            appRecord.localVersion,
            appRecord.bundleVersion,
            { signal, force }
          );
          if (signal.aborted || sequence !== this.refreshSequence) return;
          if (outcome.type === "completed" && outcome.value) {
            updates.push({
              id: appRecord.id,
              appID: appRecord.id,
              source: "sparkle",
              supportLevel: "limited",
              localVersion: appRecord.localVersion,
              remoteVersion: outcome.value.remoteVersion,
              localBuildVersion: appRecord.bundleVersion,
              remoteBuildVersion: outcome.value.remoteBuildVersion,
              sparkleVersionComparison: outcome.value.versionComparison,
              updateURL: outcome.value.updateURL,
              releaseNotesURL: outcome.value.releaseNotesURL,
              releaseDate: outcome.value.releaseDate,
              checkedAt: outcome.checkedAt ?? now
            });
            continue;
          }
          if (outcome.type === "transientFailure") {
            const previousUpdate = previousAppUpdateForTransientLookup(
              previousUpdates,
              appRecord,
              "sparkle"
            );
            if (previousUpdate) {
              updates.push(previousUpdate);
              continue;
            }
          }
        }

        const homebrewUpdate = this.homebrew.lookupUpdate(
          appRecord.bundleIdentifier,
          path.basename(appRecord.bundlePath),
          appRecord.localVersion,
          homebrewIndex
        );
        if (homebrewUpdate && isValidHomebrewToken(homebrewUpdate.token)) {
          if (
            canUseHomebrewAppUpdate(appRecord, homebrewUpdate.token, homebrewItems, homebrewIndex)
          ) {
            updates.push({
              id: appRecord.id,
              appID: appRecord.id,
              source: "homebrew",
              supportLevel: "limited",
              localVersion: appRecord.localVersion,
              remoteVersion: homebrewUpdate.remoteVersion,
              homebrewToken: homebrewUpdate.token,
              updateURL: homebrewUpdate.homepageURL,
              releaseNotesSummary: `Token: ${homebrewUpdate.token}`,
              checkedAt: now
            });
          }
        }
      }

      if (sequence !== this.refreshSequence) {
        return;
      }
      const previousHomebrewItems = this.state.homebrewItems;
      const reconciledHomebrewItems = reconcileHomebrewInventory(
        preservePreviousHomebrewOutdatedState(
          homebrewItems,
          homebrewIdentityReconciliationItems(this.state),
          homebrewInventory.outdatedDetectionSucceededByKind
        ),
        updates,
        apps,
        homebrewIndex,
        previousHomebrewItems,
        (app) => this.isSelfApp(app)
      );
      const homebrewFormulaIdentityContinuity = preserveFormulaIdentityContinuity(
        reconciledHomebrewItems,
        this.state,
        homebrewInventory.inventoryReadSucceededByKind
      );
      const recentlyUpdated = this.mergeRecentlyUpdated(apps, updates, previousUpdates, now);
      const homebrewRecentlyUpdated = mergeHomebrewRecentlyUpdatedRecords(
        this.state.homebrewRecentlyUpdated,
        homebrewIdentityReconciliationItems(this.state),
        homebrewIdentityReconciliationItems({
          homebrewItems: reconciledHomebrewItems,
          homebrewFormulaIdentityContinuity
        }),
        now,
        { completedItemIDs: this.state.homebrewUpdatedPendingRefreshItemIDs }
      );
      const preserveHomebrewCommandState =
        this.homebrewCommands.isHomebrewMutationActive() &&
        !options.allowHomebrewInventoryDuringActiveCommand;
      this.patch({
        apps,
        updates,
        homebrewItems: reconciledHomebrewItems,
        homebrewFormulaIdentityContinuity,
        recentlyUpdated,
        homebrewRecentlyUpdated,
        lastRefreshDate: now,
        isRefreshing: false,
        lastRefreshNoticeMessage:
          [
            homebrewInventory.warning,
            catalogueCacheNotice(this.homebrew.cacheStatus, this.homebrewFormula.cacheStatus)
          ]
            .filter(Boolean)
            .join(" ") || undefined,
        appUpdatedPendingRefreshIDs: [],
        homebrewUpdatedPendingRefreshItemIDs: preserveHomebrewCommandState
          ? this.state.homebrewUpdatedPendingRefreshItemIDs
          : [],
        homebrewDiscoverInstallingItemIDs: preserveHomebrewCommandState
          ? this.state.homebrewDiscoverInstallingItemIDs
          : [],
        homebrewDiscoverInstalledPendingRefreshItemIDs: preserveHomebrewCommandState
          ? this.state.homebrewDiscoverInstalledPendingRefreshItemIDs
          : [],
        homebrewDiscoverProgressByItemID: preserveHomebrewCommandState
          ? this.state.homebrewDiscoverProgressByItemID
          : {},
        selfUpdate,
        laggingHomebrewCaskTokens: detectLaggingHomebrewCaskTokens(
          homebrewItems,
          updates,
          apps,
          homebrewIndex
        )
      });
      await this.refreshHomebrewDiscoverItems();
      if (this.homebrewInventoryIsComplete(homebrewInventory)) {
        this.homebrewCleanupRequiresInventory = false;
      } else if (this.homebrewCleanupRequiresInventory || options.onHomebrewInventoryReconciled) {
        this.homebrewCleanupRequiresInventory = true;
        this.invalidateHomebrewUpdateTargets();
      }
      await this.persist();
      if (sequence !== this.refreshSequence) return;
      options.onHomebrewInventoryReconciled?.(homebrewInventory);
      void this.homebrewCommands.processHomebrewUpdateQueue();
    } catch (error) {
      if (sequence !== this.refreshSequence) {
        return;
      }
      // Keep this refresh's task even after the shared inventory lock is released.
      // An unrelated provider failure must not discard fresh membership evidence.
      const recoveredHomebrewInventory = await homebrewInventoryTask?.catch(() => undefined);
      if (sequence !== this.refreshSequence) {
        return;
      }
      const patch: Partial<BaselineSnapshot> = {
        isRefreshing: false,
        refreshErrorMessage: error instanceof Error ? error.message : "Refresh failed."
      };
      const inventory = recoveredHomebrewInventory ?? {
        items: [],
        inventoryReadSucceededByKind: { formula: false, cask: false },
        outdatedDetectionSucceededByKind: { formula: false, cask: false }
      };
      patch.homebrewItems = preservePreviousHomebrewOutdatedState(
        preservePreviousHomebrewInventoryMembership(
          inventory.items,
          this.state.homebrewItems,
          inventory.inventoryReadSucceededByKind,
          this.state.homebrewFormulaIdentityContinuity
        ),
        homebrewIdentityReconciliationItems(this.state),
        inventory.outdatedDetectionSucceededByKind
      );
      patch.homebrewFormulaIdentityContinuity = preserveFormulaIdentityContinuity(
        patch.homebrewItems,
        this.state,
        inventory.inventoryReadSucceededByKind
      );
      patch.homebrewRecentlyUpdated = mergeHomebrewRecentlyUpdatedRecords(
        this.state.homebrewRecentlyUpdated,
        homebrewIdentityReconciliationItems(this.state),
        homebrewIdentityReconciliationItems({
          homebrewItems: patch.homebrewItems,
          homebrewFormulaIdentityContinuity: patch.homebrewFormulaIdentityContinuity
        }),
        now,
        { completedItemIDs: this.state.homebrewUpdatedPendingRefreshItemIDs }
      );
      patch.lastRefreshNoticeMessage = recoveredHomebrewInventory?.warning;
      this.patch(patch);
      if (this.homebrewCleanupRequiresInventory || options.onHomebrewInventoryReconciled) {
        this.homebrewCleanupRequiresInventory = true;
        this.invalidateHomebrewUpdateTargets();
        await this.persist().catch(() => undefined);
      } else {
        await this.persist();
      }
      void this.homebrewCommands.processHomebrewUpdateQueue();
    } finally {
      // Fresh identity, membership and pins must reach state before any queued
      // command can resume. A superseded refresh cannot release its successor.
      if (this.homebrewRefreshLockSequence === sequence) {
        this.homebrewRefreshLockSequence = undefined;
        this.homebrewCommands.updateHomebrewCommandLockState();
        void this.homebrewCommands.processHomebrewUpdateQueue();
      }
    }
  }

  private async refreshHomebrewDiscoverItems(): Promise<void> {
    const term = this.state.searchText.trim();
    if (!term) {
      this.patch({ homebrewDiscoverItems: [] });
      return;
    }
    const installedCasks = new Set(
      this.state.homebrewItems
        .filter((item) => item.kind === "cask")
        .map((item) => item.token.toLowerCase())
    );
    const installedFormulae = new Set(
      this.state.homebrewItems
        .filter((item) => item.kind === "formula")
        .map((item) => item.token.toLowerCase())
    );
    const casks = this.homebrew.searchCasks(term, this.latestHomebrewIndex, installedCasks);
    const formulae = this.homebrewFormula.searchFormulae(
      term,
      this.latestHomebrewFormulaIndex,
      installedFormulae
    );
    this.patch({ homebrewDiscoverItems: [...casks, ...formulae].slice(0, 18) });
  }

  private async lookupSelfUpdate(now: string): Promise<SelfUpdateRecord | undefined> {
    if (isVersionEmpty(this.currentAppVersion)) {
      return undefined;
    }
    return this.selfUpdate.lookup(this.currentAppVersion, now);
  }

  private async fetchHomebrewInventory(
    lightweight: boolean,
    options: RefreshOptions
  ): Promise<HomebrewInventoryResult> {
    const updateMetadata = !lightweight;
    const activeHomebrewInventoryTask = this.activeHomebrewInventoryTask;
    if (activeHomebrewInventoryTask) {
      const result = await activeHomebrewInventoryTask.task;
      if (!updateMetadata || activeHomebrewInventoryTask.updateMetadata) {
        return result;
      }
    }
    if (
      this.homebrewCommands.isHomebrewMutationActive() &&
      !options.allowHomebrewInventoryDuringActiveCommand
    ) {
      return {
        items: this.state.homebrewItems,
        outdatedDetectionSucceeded: false,
        outdatedDetectionSucceededByKind: { formula: false, cask: false }
      };
    }
    this.activeHomebrewInventoryCount += 1;
    this.homebrewCommands.updateHomebrewCommandLockState();
    const task = this.fetchFreshHomebrewInventory(updateMetadata);
    this.activeHomebrewInventoryTask = { updateMetadata, task };
    try {
      const result = await task;
      if (result.inventoryReadSucceededByKind?.formula === false) {
        this.invalidateFormulaMembership();
      }
      return result;
    } catch (error) {
      this.invalidateFormulaMembership();
      throw error;
    } finally {
      if (this.activeHomebrewInventoryTask?.task === task) {
        this.activeHomebrewInventoryTask = undefined;
      }
      this.activeHomebrewInventoryCount = Math.max(0, this.activeHomebrewInventoryCount - 1);
      this.homebrewCommands.updateHomebrewCommandLockState();
    }
  }

  private invalidateFormulaMembership(): void {
    // Revoke execution before releasing the inventory lock, even if another
    // refresh provider is still pending. Keep saved identity/pins as evidence.
    const readSucceeded = { formula: false, cask: true };
    const homebrewItems = preservePreviousHomebrewInventoryMembership(
      [],
      this.state.homebrewItems.filter((item) => item.kind === "formula"),
      readSucceeded
    );
    homebrewItems.push(...this.state.homebrewItems.filter((item) => item.kind === "cask"));
    this.patch({
      homebrewItems,
      homebrewFormulaIdentityContinuity: preserveFormulaIdentityContinuity(
        homebrewItems,
        this.state,
        readSucceeded
      )
    });
  }

  private async fetchFreshHomebrewInventory(
    updateMetadata: boolean
  ): Promise<HomebrewInventoryResult> {
    if (this.hasCheckedHomebrewAvailability && !this.state.isHomebrewInstalled) {
      const brew = await this.runBrewCommand(["--version"]);
      this.hasCheckedHomebrewAvailability = true;
      if (!brew.success) {
        return emptyHomebrewInventoryResult();
      }
      this.patch({ isHomebrewInstalled: true });
    }
    return this.homebrewInventory.fetchInventory({ updateMetadata });
  }

  private scanDirectories(): string[] {
    return [...new Set([...this.defaultScanDirectories(), ...this.state.additionalDirectories])];
  }

  private defaultScanDirectories(): string[] {
    return ["/Applications", path.join(os.homedir(), "Applications")];
  }

  private async routeExternalUpdate(appRecord: AppRecord, update: UpdateRecord): Promise<void> {
    if (update.updateURL && (await this.openExternal(update.updateURL))) {
      return;
    }
    await this.openAppBundle(appRecord.bundlePath);
  }

  async cleanUpHomebrew(confirm: () => Promise<boolean>): Promise<string> {
    return this.homebrewCommands.cleanUpHomebrew(confirm);
  }

  private async refreshHomebrewCleanupInventory(): Promise<boolean> {
    // Own this generation so obsolete provider lookups cannot replace the
    // inventory commit required before cleanup's reservation is released.
    const sequence = ++this.refreshSequence;
    this.refreshController?.abort();
    const controller = new AbortController();
    this.refreshController = controller;
    let refreshed = false;
    try {
      await this.computeRefresh(
        true,
        sequence,
        {
          allowHomebrewInventoryDuringActiveCommand: true,
          onHomebrewInventoryReconciled: (inventory) => {
            refreshed = this.homebrewInventoryIsComplete(inventory);
          }
        },
        controller.signal
      );
      if (!refreshed) {
        this.homebrewCleanupRequiresInventory = true;
        this.homebrewCommands.cancelQueuedHomebrewUpdates();
        this.invalidateHomebrewUpdateTargets();
        await this.persist().catch(() => undefined);
      }
    } catch {
      refreshed = false;
      this.homebrewCleanupRequiresInventory = true;
      this.homebrewCommands.cancelQueuedHomebrewUpdates();
      this.invalidateHomebrewUpdateTargets();
      await this.persist().catch(() => undefined);
    } finally {
      if (this.refreshController === controller) {
        this.refreshTask = undefined;
        this.refreshController = undefined;
      }
    }
    return refreshed;
  }

  private homebrewInventoryIsComplete(inventory: HomebrewInventoryResult): boolean {
    return (
      inventory.inventoryReadSucceededByKind?.formula !== false &&
      inventory.inventoryReadSucceededByKind?.cask !== false &&
      inventory.outdatedDetectionSucceeded &&
      inventory.outdatedDetectionSucceededByKind?.formula !== false &&
      inventory.outdatedDetectionSucceededByKind?.cask !== false
    );
  }

  private invalidateHomebrewUpdateTargets(): void {
    this.patch({
      homebrewItems: this.state.homebrewItems.map((item) => ({
        ...item,
        isOutdated: false,
        latestVersion: undefined,
        releaseDate: undefined
      })),
      updates: this.state.updates.filter((update) => update.source !== "homebrew")
    });
  }

  private applyOperationNotice(message: string | undefined): void {
    if (!message) {
      return;
    }
    this.patch({
      lastRefreshNoticeMessage: this.state.lastRefreshNoticeMessage
        ? `${this.state.lastRefreshNoticeMessage} ${message}`
        : message
    });
  }

  private matchingHomebrewItemForApp(appRecord: AppRecord): HomebrewManagedItem | undefined {
    const update = this.state.updates.find((candidate) => candidate.appID === appRecord.id);
    const token = update?.homebrewToken?.toLowerCase();
    if (!token) {
      return undefined;
    }
    return this.state.homebrewItems.find(
      (item) =>
        item.kind === "cask" &&
        item.token.toLowerCase() === token &&
        homebrewCaskItemProvesAppOwnership(
          item,
          appRecord,
          installedCaskEntry(item, this.latestHomebrewIndex)
        )
    );
  }

  private mergeRecentlyUpdated(
    apps: AppRecord[],
    updates: UpdateRecord[],
    previousUpdates: Map<string, UpdateRecord>,
    now: string
  ) {
    const currentUpdateIDs = new Set(updates.map((update) => update.appID));
    const appByID = new Map(apps.map((app) => [app.id, app]));
    const records = [...this.state.recentlyUpdated];
    for (const [appID, previousUpdate] of previousUpdates.entries()) {
      if (currentUpdateIDs.has(appID)) {
        continue;
      }
      const appRecord = appByID.get(appID);
      if (!appRecord) {
        continue;
      }
      if (!hasInstalledAppAdvanced(appRecord, previousUpdate)) {
        continue;
      }
      records.unshift({
        id: appID,
        appID,
        displayName: appRecord.displayName,
        source: previousUpdate.source,
        fromVersion: previousUpdate.localVersion,
        toVersion: appRecord.localVersion,
        fromBuildVersion: previousUpdate.localBuildVersion,
        toBuildVersion: previousUpdate.localBuildVersion ? appRecord.bundleVersion : undefined,
        updatedAt: now
      });
    }
    const retentionMs = 14 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;
    const deduped = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      if (new Date(record.updatedAt).getTime() >= cutoff && !deduped.has(record.appID)) {
        deduped.set(record.appID, record);
      }
    }
    return [...deduped.values()].slice(0, 40);
  }

  private async withAppUpdating(appID: string, operation: () => Promise<void>): Promise<void> {
    if (this.state.appUpdatingIDs.includes(appID)) {
      return;
    }
    this.patch({ appUpdatingIDs: addToArray(this.state.appUpdatingIDs, appID) });
    try {
      await operation();
    } finally {
      this.patch({ appUpdatingIDs: removeFromArray(this.state.appUpdatingIDs, appID) });
    }
  }

  private restartAutoRefreshLoop(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
    }
    if (!this.state.autoRefreshEnabled) {
      return;
    }
    this.autoRefreshTimer = setInterval(
      () => void this.refresh(true),
      this.state.refreshIntervalMinutes * 60 * 1000
    );
  }

  private async persist(): Promise<void> {
    await this.persistence.save(snapshotForPersistence(this.state));
  }

  private async recordProfileStatsEvents(events: ProfileStatsEvent[]): Promise<void> {
    await this.runProfileStatsMutation(async () => {
      const profileStats = await this.profileStatsWithEvents(events);
      this.patch({ profileStats });
      await this.persist();
    });
  }

  private async runProfileStatsMutation(operation: () => Promise<void>): Promise<void> {
    const mutation = this.profileStatsMutationQueue.then(operation, operation);
    this.profileStatsMutationQueue = mutation.catch(() => undefined);
    await mutation;
  }

  private async profileStatsWithEvents(events: ProfileStatsEvent[]): Promise<ProfileStats> {
    const currentProfileStats =
      this.state.profileStats.signature || this.state.profileStats.events.length === 0
        ? this.state.profileStats
        : {
            ...defaultProfileStatsAfterTamper(),
            events: [],
            signature: undefined
          };
    const eventIDs = new Set(currentProfileStats.events.map((event) => event.id));
    const newEvents = events.filter((event) => !eventIDs.has(event.id));
    if (newEvents.length === 0) {
      return currentProfileStats;
    }
    const sealed = await this.profileStatsIntegrity.seal({
      ...currentProfileStats,
      events: [...newEvents, ...currentProfileStats.events].slice(0, 1000),
      integrityStatus:
        currentProfileStats.integrityStatus === "resetAfterTamper" ? "resetAfterTamper" : "verified"
    });
    if (sealed.integrityStatus === "unavailable") {
      return { ...currentProfileStats, integrityStatus: "unavailable" };
    }
    return sealed;
  }

  private async reconcileVerifiedProfileStats(
    statsBeforeVerification: ProfileStats,
    verifiedStats: ProfileStats
  ): Promise<ProfileStats> {
    const previousEventIDs = new Set(statsBeforeVerification.events.map((event) => event.id));
    const currentStats = this.state.profileStats;
    const concurrentEvents = currentStats.events.filter((event) => !previousEventIDs.has(event.id));
    if (concurrentEvents.length === 0) {
      return verifiedStats;
    }

    const concurrentEventIDs = new Set(concurrentEvents.map((event) => event.id));
    const profileStats = {
      ...verifiedStats,
      events: [
        ...concurrentEvents,
        ...verifiedStats.events.filter((event) => !concurrentEventIDs.has(event.id))
      ].slice(0, 1000)
    };
    const sealed = await this.profileStatsIntegrity.seal(profileStats);
    if (sealed.integrityStatus === "unavailable") {
      return { ...currentStats, integrityStatus: "unavailable" };
    }
    return sealed;
  }

  private createHomebrewCommandHost(): HomebrewCommandHost {
    const readState = () => this.state;
    const patchState = (patch: Partial<BaselineSnapshot>) => this.patch(patch);
    const readBrewCommand = () => this.runBrewCommand;
    const emitHomebrewCommand = (event: HomebrewMaintenanceRunEvent) =>
      this.emit("homebrewCommand", event);
    const recordProfileStatsEvents = (events: ProfileStatsEvent[]) =>
      this.recordProfileStatsEvents(events);
    const recordOperationFailure = (
      entityID: string,
      operation: OperationFailure["operation"],
      result: CommandResult,
      reason?: OperationFailure["reason"]
    ) => this.recordOperationFailure(entityID, operation, result, reason);
    const recordOperationFailures = (
      failures: Array<{
        entityID: string;
        operation: OperationFailure["operation"];
        result: CommandResult;
        reason?: OperationFailure["reason"];
      }>
    ) => this.recordOperationFailures(failures);
    const clearOperationFailure = (entityID: string, operation: OperationFailure["operation"]) =>
      this.clearOperationFailure(entityID, operation);
    const refresh: HomebrewCommandHost["refresh"] = (lightweight, options) =>
      this.refresh(lightweight, options);
    const applyOperationNotice = (message: string | undefined) =>
      this.applyOperationNotice(message);
    const readInventoryCount = () => this.activeHomebrewInventoryCount;
    const readRefreshLockSequence = () => this.homebrewRefreshLockSequence;
    const readCleanupRequiresInventory = () => this.homebrewCleanupRequiresInventory;
    const readHomebrewAvailability = () => this.hasCheckedHomebrewAvailability;
    const writeHomebrewAvailability = (value: boolean) => {
      this.hasCheckedHomebrewAvailability = value;
    };
    const readRefreshTask = () => this.refreshTask;
    const readCleanupRefreshTask = () => this.cleanupRefreshTask;
    const writeCleanupRefreshTask = (task: Promise<void> | undefined) => {
      this.cleanupRefreshTask = task;
    };
    const readCleanupRefreshRequested = () => this.cleanupRefreshRequested;
    const writeCleanupRefreshRequested = (value: boolean) => {
      this.cleanupRefreshRequested = value;
    };
    const refreshHomebrewCleanupInventory = () => this.refreshHomebrewCleanupInventory();
    return {
      get state() {
        return readState();
      },
      patch: patchState,
      get runBrewCommand() {
        return readBrewCommand();
      },
      emitHomebrewCommand,
      recordProfileStatsEvents,
      recordOperationFailure,
      recordOperationFailures,
      clearOperationFailure,
      refresh,
      applyOperationNotice,
      get activeHomebrewInventoryCount() {
        return readInventoryCount();
      },
      get homebrewRefreshLockSequence() {
        return readRefreshLockSequence();
      },
      get homebrewCleanupRequiresInventory() {
        return readCleanupRequiresInventory();
      },
      get hasCheckedHomebrewAvailability() {
        return readHomebrewAvailability();
      },
      set hasCheckedHomebrewAvailability(value: boolean) {
        writeHomebrewAvailability(value);
      },
      get refreshTask() {
        return readRefreshTask();
      },
      get cleanupRefreshTask() {
        return readCleanupRefreshTask();
      },
      set cleanupRefreshTask(task: Promise<void> | undefined) {
        writeCleanupRefreshTask(task);
      },
      get cleanupRefreshRequested() {
        return readCleanupRefreshRequested();
      },
      set cleanupRefreshRequested(value: boolean) {
        writeCleanupRefreshRequested(value);
      },
      refreshHomebrewCleanupInventory
    };
  }

  private patch(patch: Partial<BaselineSnapshot>): void {
    const progressKeys = [
      "homebrewBatchProgressByItemID",
      "homebrewFallbackProgressByAppID",
      "homebrewDiscoverProgressByItemID"
    ] as const;
    const keys = Object.keys(patch);
    const progressOnly =
      keys.length > 0 && keys.every((key) => progressKeys.some((candidate) => candidate === key));
    const terminal =
      progressOnly &&
      progressKeys.some((key) =>
        Object.entries(patch[key] ?? {}).some(
          ([id, progress]) => progress >= 1 && this.state[key][id] !== progress
        )
      );
    this.state = this.excludeSelfUpdates({ ...this.state, ...patch });
    const revision = ++this.snapshotRevision;
    if (progressOnly) {
      this.progressPublisher.publish(patch as Partial<SnapshotProgress>, revision, terminal);
      return;
    }
    this.progressPublisher.reset(revision);
    this.emit("snapshot", this.getSnapshot());
  }
}

function snapshotForPersistence(snapshot: BaselineSnapshot): PersistedSnapshot {
  return {
    apps: snapshot.apps,
    updates: snapshot.updates,
    recentlyUpdated: snapshot.recentlyUpdated,
    homebrewItems: snapshot.homebrewItems,
    homebrewFormulaIdentityContinuity: snapshot.homebrewFormulaIdentityContinuity,
    homebrewRecentlyUpdated: snapshot.homebrewRecentlyUpdated,
    ignoredIDs: snapshot.ignoredIDs,
    ignoredHomebrewItemIDs: snapshot.ignoredHomebrewItemIDs,
    additionalDirectories: snapshot.additionalDirectories,
    selectedTab: "all",
    collapsedAppSectionIDs: snapshot.collapsedAppSectionIDs,
    collapsedHomebrewSectionIDs: snapshot.collapsedHomebrewSectionIDs,
    autoRefreshEnabled: snapshot.autoRefreshEnabled,
    refreshIntervalMinutes: snapshot.refreshIntervalMinutes,
    appearancePreference: snapshot.appearancePreference,
    useMasForAppStoreUpdates: snapshot.useMasForAppStoreUpdates,
    showMenuBarIcon: snapshot.showMenuBarIcon,
    showDockIcon: snapshot.showDockIcon,
    profileStats: snapshot.profileStats,
    profileStatsResetAcknowledgedID: snapshot.profileStatsResetAcknowledgedID,
    operationFailures: normalizeOperationFailures(snapshot.operationFailures),
    lastRefreshDate: snapshot.lastRefreshDate
  };
}

function sanitizePersistedSnapshotForRuntime(snapshot: PersistedSnapshot): PersistedSnapshot {
  const homebrewItems = snapshot.homebrewItems.map((item) =>
    item.kind === "formula"
      ? {
          ...item,
          formulaIdentityVerified: false,
          isOutdated: false,
          latestVersion: undefined,
          releaseDate: undefined
        }
      : !homebrewCommandToken(item)
        ? {
            ...item,
            appID: undefined,
            presentation: item.kind === "cask" ? ("cask" as const) : ("formula" as const),
            iconDataURL: undefined,
            isOutdated: false,
            latestVersion: undefined,
            releaseDate: undefined
          }
        : item
  );
  const migrated = { ...snapshot, homebrewItems };
  return {
    ...migrated,
    updates: snapshot.updates.filter((update) =>
      persistedUpdateHasValidRuntimeRoute(update, migrated)
    )
  };
}

function persistedUpdateHasValidRuntimeRoute(
  update: UpdateRecord,
  snapshot: PersistedSnapshot
): boolean {
  if (update.source === "sparkle") {
    const appRecord = snapshot.apps.find((app) => app.id === update.appID);
    return Boolean(appRecord && isAppUpdateNewerThanInstalledApp(update, appRecord));
  }
  if (update.source !== "homebrew") {
    return true;
  }

  const token = update.homebrewToken?.toLowerCase();
  if (!token || !isValidHomebrewToken(token)) {
    return false;
  }
  const appRecord = snapshot.apps.find((app) => app.id === update.appID);
  if (!appRecord) return false;
  return canUseHomebrewAppUpdate(appRecord, token, snapshot.homebrewItems, emptyHomebrewCaskIndex);
}

function appUpdateProfileStatsEvent({
  appRecord,
  update,
  occurredAt
}: {
  appRecord: AppRecord;
  update: UpdateRecord;
  occurredAt: string;
}): ProfileStatsEvent {
  return {
    id: [
      "appUpdate",
      appRecord.id,
      update.localVersion.raw,
      update.remoteVersion.raw,
      update.localBuildVersion?.raw ?? "",
      update.remoteBuildVersion?.raw ?? "",
      occurredAt
    ].join(":"),
    type: "appUpdate",
    targetID: appRecord.id,
    displayName: appRecord.displayName,
    channel: profileStatsChannel(update.source),
    occurredAt
  };
}

function profileStatsChannel(
  source: UpdateRecord["source"] | undefined
): ProfileStatsEvent["channel"] {
  if (
    source === "appStore" ||
    source === "sparkle" ||
    source === "homebrew" ||
    source === "web" ||
    source === "unknown"
  ) {
    return source;
  }
  return "unknown";
}

function toggleSet(set: Set<string>, value: string): void {
  if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
}

function addToArray<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values : [...values, value];
}

function removeFromArray<T>(values: T[], value: T): T[] {
  return values.filter((candidate) => candidate !== value);
}

function previousAppUpdateForTransientLookup(
  previousUpdates: Map<string, UpdateRecord>,
  appRecord: AppRecord,
  source: AppLookupSource
): UpdateRecord | undefined {
  const previousUpdate = previousUpdates.get(appRecord.id);
  if (!previousUpdate || previousUpdate.source !== source) {
    return undefined;
  }
  if (!canPreservePreviousAppUpdate(appRecord, previousUpdate)) {
    return undefined;
  }
  return previousUpdate;
}

function canPreservePreviousAppUpdate(appRecord: AppRecord, previousUpdate: UpdateRecord): boolean {
  if (previousUpdate.appID !== appRecord.id) {
    return false;
  }
  if (compareVersions(previousUpdate.localVersion, appRecord.localVersion) !== 0) {
    return false;
  }
  if (
    previousUpdate.localBuildVersion &&
    (!appRecord.bundleVersion ||
      compareVersions(previousUpdate.localBuildVersion, appRecord.bundleVersion) !== 0)
  ) {
    return false;
  }
  return isAppUpdateNewerThanInstalledApp(previousUpdate, appRecord);
}

function isAppUpdateNewerThanInstalledApp(update: UpdateRecord, appRecord: AppRecord): boolean {
  if (update.source === "sparkle") {
    const candidate = {
      parsedVersion: sparkleMarketingVersion(update.remoteVersion, update.remoteBuildVersion),
      buildVersion: update.remoteBuildVersion ?? version(),
      hasMarketingVersion: update.sparkleVersionComparison !== "build"
    };
    const localVersion = sparkleMarketingVersion(appRecord.localVersion, appRecord.bundleVersion);
    if (isSparkleVersionNewer(candidate, localVersion, appRecord.bundleVersion)) {
      return true;
    }
    // Legacy records did not preserve the feed's comparison domain. Equal
    // display/build values are ambiguous: retain an eligible machine-version
    // interpretation until a successful lookup supplies explicit metadata.
    return (
      update.sparkleVersionComparison === undefined &&
      update.remoteBuildVersion !== undefined &&
      compareVersions(update.remoteVersion, update.remoteBuildVersion) === 0 &&
      isSparkleVersionNewer(
        { ...candidate, hasMarketingVersion: false },
        localVersion,
        appRecord.bundleVersion
      )
    );
  }
  const versionComparison = compareVersions(update.remoteVersion, appRecord.localVersion);
  if (versionComparison > 0) {
    return true;
  }
  if (versionComparison < 0) {
    return false;
  }
  if (!update.remoteBuildVersion || !update.localBuildVersion || !appRecord.bundleVersion) {
    return false;
  }
  return (
    compareVersions(update.localBuildVersion, appRecord.bundleVersion) === 0 &&
    isVersionGreater(update.remoteBuildVersion, appRecord.bundleVersion)
  );
}

function emptyHomebrewInventoryResult(): HomebrewInventoryResult {
  return {
    items: [],
    outdatedDetectionSucceeded: true,
    outdatedDetectionSucceededByKind: { formula: true, cask: true }
  };
}

function homebrewIdentityReconciliationItems(
  snapshot: Pick<PersistedSnapshot, "homebrewItems" | "homebrewFormulaIdentityContinuity">
): HomebrewManagedItem[] {
  // Visible inventory wins by saved ID; hidden records only provide identity evidence.
  return [
    ...new Map([
      ...(snapshot.homebrewFormulaIdentityContinuity ?? []).map((item) => [item.id, item] as const),
      ...snapshot.homebrewItems.map((item) => [item.id, item] as const)
    ]).values()
  ];
}

function preserveFormulaIdentityContinuity(
  items: HomebrewManagedItem[],
  snapshot: PersistedSnapshot,
  readSucceeded: HomebrewInventoryResult["inventoryReadSucceededByKind"]
): HomebrewManagedItem[] | undefined {
  const incomplete =
    readSucceeded?.formula === false ||
    items.some((item) => item.kind === "formula" && !homebrewCommandToken(item));
  if (!incomplete) return undefined;
  const visibleByID = new Map(items.map((item) => [item.id, item]));
  // Freeze one complete prior inventory generation, rather than accumulating removed packages
  // across failures. No aliases are guessed from the new rack names.
  return (snapshot.homebrewFormulaIdentityContinuity ?? snapshot.homebrewItems)
    .filter(formulaHasContinuityIdentity)
    .map((item) => {
      const visible = visibleByID.get(item.id);
      // Refresh members of the frozen generation only: later generations cannot grow it.
      return visible && formulaHasContinuityIdentity(visible) ? visible : item;
    })
    .map((item) => ({
      ...item,
      formulaIdentityVerified: false,
      isOutdated: false,
      latestVersion: undefined,
      releaseDate: undefined
    }));
}

function preservePreviousHomebrewInventoryMembership(
  currentItems: HomebrewManagedItem[],
  previousItems: HomebrewManagedItem[],
  readSucceeded: HomebrewInventoryResult["inventoryReadSucceededByKind"],
  continuity: HomebrewManagedItem[] = []
): HomebrewManagedItem[] {
  const identityItems = homebrewIdentityReconciliationItems({
    homebrewItems: previousItems,
    homebrewFormulaIdentityContinuity: continuity
  });
  // Retain saved Ignore/history IDs when installed metadata proves a same-tap rename.
  // Ambiguous aliases or a tap switch cannot inherit another package's identity.
  const occupiedIDs = new Set(currentItems.map((item) => item.id));
  currentItems = currentItems.map((item) => {
    if (item.kind !== "formula") return item;
    if (!homebrewCommandToken(item)) {
      const matches = identityItems.filter(
        (previous) =>
          previous.kind === "formula" &&
          previous.token === item.token &&
          formulaHasContinuityIdentity(previous)
      );
      const previous = matches.length === 1 ? matches[0] : undefined;
      if (!previous || (previous.id !== item.id && occupiedIDs.has(previous.id))) return item;
      occupiedIDs.add(previous.id);
      // A transient metadata failure must not detach saved preferences/history.
      // Retain identity only as continuity evidence; all commands stay blocked.
      return {
        ...item,
        id: previous.id,
        formulaIdentity: previous.formulaIdentity,
        formulaIdentityVerified: false,
        isOutdated: false,
        latestVersion: undefined,
        releaseDate: undefined
      };
    }
    const identity = item.formulaIdentity!;
    const matches = identityItems.filter(
      (previous) =>
        previous.kind === "formula" &&
        formulaHasContinuityIdentity(previous) &&
        previous.formulaIdentity?.tap === identity.tap &&
        (previous.formulaIdentity.fullName === identity.fullName ||
          identity.oldNames.includes(previous.formulaIdentity.name) ||
          identity.oldNames.includes(`${identity.tap}/${previous.formulaIdentity.name}`))
    );
    const previous = matches.length === 1 ? matches[0] : undefined;
    if (!previous || (previous.id !== item.id && occupiedIDs.has(previous.id))) return item;
    occupiedIDs.add(previous.id);
    const observations = previousItems.filter(
      (candidate) =>
        candidate.kind === "formula" &&
        candidate.token === item.token &&
        typeof candidate.unverifiedPinObservation === "boolean" &&
        (!candidate.tap || candidate.tap === identity.tap)
    );
    const observation = observations.length === 1 ? observations[0] : undefined;
    // Apply a raw rack's observation only after fresh unique same-tap identity
    // proves its relationship to the saved package. Fresh explicit fields win.
    return {
      ...item,
      id: previous.id,
      pinned: item.pinned ?? observation?.unverifiedPinObservation,
      unverifiedPinObservation: undefined
    };
  });
  if (!readSucceeded || (readSucceeded.formula && readSucceeded.cask)) {
    return currentItems;
  }
  return [
    ...currentItems.filter((item) => readSucceeded[item.kind]),
    ...previousItems
      .filter((item) => !readSucceeded[item.kind])
      .map((item) =>
        item.kind === "formula"
          ? {
              ...item,
              formulaIdentityVerified: false,
              isOutdated: false,
              latestVersion: undefined,
              releaseDate: undefined
            }
          : item
      )
  ].sort((lhs, rhs) => lhs.kind.localeCompare(rhs.kind) || lhs.name.localeCompare(rhs.name));
}

function knownPinIdentity(item: HomebrewManagedItem): string | undefined {
  const identity =
    homebrewItemIdentity(item) ??
    (formulaHasContinuityIdentity(item)
      ? homebrewItemIdentity({ ...item, formulaIdentityVerified: undefined })
      : item.pinnedIdentity);
  return identity && isValidHomebrewToken(identity) ? identity : undefined;
}

function pinIdentityCanContinue(
  item: HomebrewManagedItem,
  previous: HomebrewManagedItem,
  previousIdentity: string,
  candidates: HomebrewManagedItem[]
): boolean {
  if (item.kind !== previous.kind) return false;
  const identity = homebrewItemIdentity(item);
  if (identity) {
    if (identity === previousIdentity) return true;
    const currentFormula = item.formulaIdentity;
    if (item.kind !== "formula" || !currentFormula) return false;
    const matches = candidates.filter(
      (candidate) =>
        formulaHasContinuityIdentity(candidate) &&
        candidate.formulaIdentity?.tap === currentFormula.tap &&
        (candidate.formulaIdentity.fullName === currentFormula.fullName ||
          currentFormula.oldNames.includes(candidate.formulaIdentity.name) ||
          currentFormula.oldNames.includes(
            `${currentFormula.tap}/${candidate.formulaIdentity.name}`
          ))
    );
    return matches.length === 1 && matches[0]?.id === previous.id;
  }
  // Unknown identity may retain a pin only under the existing saved ID and rack.
  // It supplies no execution capability, alias inference, or cross-tap transfer.
  return (
    item.id === previous.id &&
    item.token === previous.token &&
    (!item.tap ||
      previousIdentity.startsWith(`${item.tap}/`) ||
      (item.tap === "homebrew/core" && !previousIdentity.includes("/"))) &&
    (!item.formulaIdentity ||
      (formulaHasContinuityIdentity(item) &&
        homebrewItemIdentity({ ...item, formulaIdentityVerified: undefined }) === previousIdentity))
  );
}

export function preservePreviousHomebrewOutdatedState(
  currentItems: HomebrewManagedItem[],
  previousItems: HomebrewManagedItem[],
  outdatedDetectionSucceededByKind: Record<HomebrewManagedItemKind, boolean>
): HomebrewManagedItem[] {
  const previousByID = new Map(previousItems.map((item) => [item.id, item]));
  currentItems = currentItems.map((item) => {
    const previous = previousByID.get(item.id);
    const identity = homebrewItemIdentity(item);
    const previousIdentity = previous && knownPinIdentity(previous);
    if (!identity) {
      const observation =
        typeof item.pinned === "boolean"
          ? item.pinned
          : previous?.kind === item.kind && previous.token === item.token
            ? previous.unverifiedPinObservation
            : undefined;
      if (typeof observation === "boolean") {
        return {
          ...item,
          pinned: observation,
          unverifiedPinObservation: observation,
          pinnedIdentity:
            previous &&
            previousIdentity &&
            pinIdentityCanContinue(item, previous, previousIdentity, previousItems)
              ? previousIdentity
              : undefined
        };
      }
    }
    if (
      identity &&
      item.pinned === undefined &&
      previous &&
      previousIdentity &&
      typeof previous.unverifiedPinObservation === "boolean" &&
      pinIdentityCanContinue(item, previous, previousIdentity, previousItems)
    ) {
      return {
        ...item,
        pinned: previous.unverifiedPinObservation,
        pinnedIdentity: previous.unverifiedPinObservation ? identity : undefined,
        unverifiedPinObservation: undefined
      };
    }
    if (item.pinned !== undefined && identity) {
      return {
        ...item,
        pinnedIdentity: item.pinned ? identity : undefined,
        unverifiedPinObservation: undefined
      };
    }
    if (
      item.pinned !== false &&
      previous?.pinned &&
      previousIdentity &&
      pinIdentityCanContinue(item, previous, previousIdentity, previousItems)
    ) {
      // Retain pin evidence even when identity is not executable. Recovery still
      // requires fresh same-package proof; explicit false is authoritative.
      return { ...item, pinned: true, pinnedIdentity: identity ?? previousIdentity };
    }
    return item;
  });
  if (outdatedDetectionSucceededByKind.formula && outdatedDetectionSucceededByKind.cask) {
    return currentItems;
  }

  return currentItems.map((item) => {
    const previous = previousByID.get(item.id);
    if (outdatedDetectionSucceededByKind[item.kind]) {
      return item;
    }
    if (
      !homebrewCommandToken(item) ||
      !previous ||
      !homebrewCommandToken(previous) ||
      homebrewItemIdentity(item) !== homebrewItemIdentity(previous)
    )
      return item;
    if (!previous?.isOutdated) {
      return item;
    }
    const preserveSameVersionCaskUpdate =
      previous.latestVersion !== undefined &&
      homebrewReportedSameVersionCaskUpdate(
        previous,
        item.installedVersion,
        previous.latestVersion
      );
    if (
      previous.latestVersion &&
      !isVersionGreater(previous.latestVersion, item.installedVersion) &&
      !preserveSameVersionCaskUpdate
    ) {
      return item;
    }
    return {
      ...item,
      latestVersion: previous.latestVersion ?? item.latestVersion,
      isOutdated: true,
      releaseDate: previous.releaseDate ?? item.releaseDate,
      iconDataURL: previous.iconDataURL ?? item.iconDataURL
    };
  });
}

function canUseHomebrewAppUpdate(
  appRecord: AppRecord,
  homebrewToken: string,
  homebrewItems: HomebrewManagedItem[],
  caskIndex: HomebrewCaskIndex
): boolean {
  const token = homebrewToken.toLowerCase();
  return homebrewItems.some(
    (item) =>
      item.kind === "cask" &&
      item.token.toLowerCase() === token &&
      homebrewCaskItemProvesAppOwnership(item, appRecord, installedCaskEntry(item, caskIndex))
  );
}

function homebrewItemCanRunAppUpdate(item: HomebrewManagedItem, update: UpdateRecord): boolean {
  return (
    !item.pinned &&
    (item.isOutdated || isVersionGreater(update.remoteVersion, item.installedVersion))
  );
}

function homebrewCaskItemProvesAppOwnership(
  item: HomebrewManagedItem,
  appRecord: AppRecord,
  caskEntry: HomebrewCaskEntry | undefined
): boolean {
  if (!homebrewCommandToken(item)) return false;
  if (item.appID === appRecord.id) {
    return true;
  }
  if (item.kind !== "cask" || !caskEntry) {
    return false;
  }
  return appMatchesCaskEntry(appRecord, caskEntry);
}

function reconcileHomebrewInventory(
  items: HomebrewManagedItem[],
  updates: UpdateRecord[],
  apps: AppRecord[] = [],
  caskIndex: HomebrewCaskIndex = emptyHomebrewCaskIndex,
  previousItems: HomebrewManagedItem[] = [],
  isSelfApp?: (app: AppRecord) => boolean
): HomebrewManagedItem[] {
  const updatesByToken = new Map<string, UpdateRecord>();
  for (const update of updates) {
    if (update.source === "homebrew" && update.homebrewToken) {
      const key = update.homebrewToken.toLowerCase();
      const existing = updatesByToken.get(key);
      if (!existing || compareVersions(update.remoteVersion, existing.remoteVersion) > 0) {
        updatesByToken.set(key, update);
      }
    }
  }
  const appsByID = new Map(apps.map((app) => [app.id, app]));
  const previousItemsByID = new Map(previousItems.map((item) => [item.id, item]));
  return items.map((item) => {
    if (item.kind !== "cask") {
      return item;
    }
    if (!homebrewCommandToken(item))
      return {
        ...item,
        appID: undefined,
        presentation: "cask" as const,
        iconDataURL: undefined,
        isOutdated: false,
        latestVersion: undefined
      };
    const caskEntry = installedCaskEntry(item, caskIndex);
    const matchingApp = matchingHomebrewApp(
      updatesByToken,
      appsByID,
      apps,
      item,
      caskEntry,
      isSelfApp
    );
    const iconDataURL =
      matchingApp?.iconDataURL ??
      (caskEntry ? undefined : matchingHomebrewAppIcon(item, updatesByToken, appsByID, apps));
    const preservedIconDataURL = caskEntry && !matchingApp ? undefined : item.iconDataURL;
    const update = updatesByToken.get(item.token.toLowerCase());
    const installedVersion =
      matchingApp && isVersionGreater(matchingApp.localVersion, item.installedVersion)
        ? matchingApp.localVersion
        : item.installedVersion;
    const latestVersion = bestHomebrewCaskLatestVersion(item, update, caskEntry);
    const previousItem = previousItemsByID.get(item.id);
    const previousAppID = previousItem?.appID;
    const preservedAppID =
      !caskEntry &&
      !matchingApp &&
      previousAppID &&
      appsByID.has(previousAppID) &&
      !isSelfApp?.(appsByID.get(previousAppID)!) &&
      homebrewItemIdentity(previousItem) === homebrewItemIdentity(item)
        ? previousAppID
        : undefined;
    const appID = matchingApp?.id ?? preservedAppID;
    const presentation: HomebrewManagedItem["presentation"] = appID
      ? "app"
      : (caskEntry?.presentation ?? previousItem?.presentation ?? item.presentation);
    const latestVersionComparison = latestVersion
      ? compareVersions(latestVersion, installedVersion)
      : undefined;
    const keepHomebrewReportedSameVersionUpdate =
      latestVersion !== undefined &&
      homebrewReportedSameVersionCaskUpdate(item, installedVersion, latestVersion);

    if (
      !latestVersion ||
      ((latestVersionComparison ?? 0) <= 0 && !keepHomebrewReportedSameVersionUpdate)
    ) {
      return {
        ...item,
        appID,
        presentation,
        name: matchingApp?.displayName ?? item.name,
        iconDataURL: iconDataURL ?? preservedIconDataURL,
        installedVersion,
        latestVersion: undefined,
        isOutdated: false,
        releaseDate: undefined
      };
    }
    return {
      ...item,
      appID,
      presentation,
      name: matchingApp?.displayName ?? item.name,
      iconDataURL: iconDataURL ?? preservedIconDataURL,
      installedVersion,
      latestVersion,
      isOutdated: true
    };
  });
}

function hasInstalledAppAdvanced(appRecord: AppRecord, previousUpdate: UpdateRecord): boolean {
  if (isVersionGreater(appRecord.localVersion, previousUpdate.localVersion)) {
    return true;
  }
  if (!previousUpdate.localBuildVersion || !appRecord.bundleVersion) {
    return false;
  }
  return isVersionGreater(appRecord.bundleVersion, previousUpdate.localBuildVersion);
}

export function mergeHomebrewRecentlyUpdatedRecords(
  existingRecords: HomebrewRecentlyUpdatedRecord[],
  previousItems: HomebrewManagedItem[],
  currentItems: HomebrewManagedItem[],
  now: string,
  options: { completedItemIDs?: string[]; currentDate?: Date } = {}
): HomebrewRecentlyUpdatedRecord[] {
  const records = [...existingRecords];
  const previousByID = new Map(previousItems.map((item) => [item.id, item]));
  const completedItemIDs = new Set(options.completedItemIDs ?? []);

  for (const currentItem of currentItems) {
    const previousItem = previousByID.get(currentItem.id);
    if (!previousItem) {
      continue;
    }
    const versionComparison = compareVersions(
      currentItem.installedVersion,
      previousItem.installedVersion
    );
    const completedSameVersionCaskUpdate =
      versionComparison === 0 &&
      currentItem.kind === "cask" &&
      previousItem.kind === "cask" &&
      previousItem.isOutdated &&
      !currentItem.isOutdated &&
      completedItemIDs.has(currentItem.id);
    if (versionComparison < 0 || (versionComparison === 0 && !completedSameVersionCaskUpdate)) {
      continue;
    }
    records.unshift({
      id: currentItem.id,
      itemID: currentItem.id,
      token: currentItem.token,
      kind: currentItem.kind,
      displayName: currentItem.name,
      fromVersion: previousItem.installedVersion,
      toVersion: currentItem.installedVersion,
      updatedAt: now
    });
  }

  const retentionMs = 14 * 24 * 60 * 60 * 1000;
  const cutoff = (options.currentDate?.getTime() ?? Date.now()) - retentionMs;
  const currentByID = new Map(currentItems.map((item) => [item.id, item]));
  const deduped = new Map<string, HomebrewRecentlyUpdatedRecord>();
  for (const record of records) {
    const currentItem = currentByID.get(record.itemID);
    if (
      currentItem &&
      compareVersions(record.toVersion, currentItem.installedVersion) === 0 &&
      new Date(record.updatedAt).getTime() >= cutoff &&
      !deduped.has(record.itemID)
    ) {
      deduped.set(record.itemID, record);
    }
  }
  return [...deduped.values()].slice(0, 40);
}

function bestHomebrewCaskLatestVersion(
  item: HomebrewManagedItem,
  update: UpdateRecord | undefined,
  caskEntry: HomebrewCaskEntry | undefined
): HomebrewManagedItem["latestVersion"] {
  const caskIndexVersion = item.isOutdated ? caskEntry?.version : undefined;
  const candidates = [item.latestVersion, update?.remoteVersion, caskIndexVersion].filter(
    (candidate): candidate is NonNullable<HomebrewManagedItem["latestVersion"]> =>
      Boolean(candidate) && !isVersionEmpty(candidate)
  );
  if (candidates.length === 0) {
    return undefined;
  }
  return candidates.reduce((latest, candidate) =>
    compareVersions(candidate, latest) > 0 ? candidate : latest
  );
}

function homebrewReportedSameVersionCaskUpdate(
  item: HomebrewManagedItem,
  installedVersion: VersionValue,
  latestVersion: VersionValue
): boolean {
  return (
    item.kind === "cask" &&
    item.isOutdated &&
    compareVersions(latestVersion, installedVersion) === 0 &&
    compareVersions(installedVersion, item.installedVersion) === 0
  );
}

function matchingHomebrewApp(
  updatesByToken: Map<string, UpdateRecord>,
  appsByID: Map<string, AppRecord>,
  apps: AppRecord[],
  item: HomebrewManagedItem,
  caskEntry: HomebrewCaskEntry | undefined,
  isSelfApp?: (app: AppRecord) => boolean
): AppRecord | undefined {
  const matches = (app: AppRecord) =>
    (!isSelfApp?.(app) || Boolean(caskEntry && installedCaskIdentifiesSelf(app, caskEntry))) &&
    appMatchesCaskEntry(app, caskEntry);
  const update = updatesByToken.get(item.token.toLowerCase());
  const appFromUpdate = update ? appsByID.get(update.appID) : undefined;
  if (appFromUpdate && matches(appFromUpdate)) {
    return appFromUpdate;
  }

  if (caskEntry) {
    const byCaskMetadata = apps.find(matches);
    if (byCaskMetadata) {
      return byCaskMetadata;
    }
  }

  return undefined;
}

function installedCaskIdentifiesSelf(app: AppRecord, entry: HomebrewCaskEntry): boolean {
  const identifier = app.bundleIdentifier?.toLowerCase();
  if (
    identifier &&
    entry.bundleIdentifiers.some((candidate) => candidate.toLowerCase() === identifier)
  )
    return true;
  // appID and artifact basenames may come from generic name matching; they cannot prove self ownership.
  return (entry.installedAppPaths ?? []).some(
    (target) => path.resolve(target) === path.resolve(app.bundlePath)
  );
}

function appMatchesCaskEntry(app: AppRecord, caskEntry: HomebrewCaskEntry | undefined): boolean {
  if (!caskEntry) {
    return true;
  }

  const bundleIdentifiers = new Set(
    caskEntry.bundleIdentifiers.map((identifier) => identifier.toLowerCase())
  );
  const bundleIdentifier = app.bundleIdentifier?.toLowerCase();
  if (bundleIdentifier && bundleIdentifiers.size > 0) {
    return bundleIdentifiers.has(bundleIdentifier);
  }
  const matchesAppBundleName = new Set(caskEntry.appBundleNames).has(
    normalizedAppBundleName(app.bundlePath)
  );
  const inferredBundleIdentifiers = new Set(
    (caskEntry.inferredBundleIdentifiers ?? []).map((identifier) => identifier.toLowerCase())
  );
  if (bundleIdentifier && inferredBundleIdentifiers.has(bundleIdentifier)) {
    return matchesAppBundleName;
  }

  return matchesAppBundleName;
}

function matchingHomebrewAppIcon(
  item: HomebrewManagedItem,
  updatesByToken: Map<string, UpdateRecord>,
  appsByID: Map<string, AppRecord>,
  apps: AppRecord[]
): string | undefined {
  const update = updatesByToken.get(item.token.toLowerCase());
  const appFromUpdate = update ? appsByID.get(update.appID) : undefined;
  if (appFromUpdate?.iconDataURL) {
    return appFromUpdate.iconDataURL;
  }

  const token = normalizedName(item.token);
  const name = normalizedName(item.name);
  return apps.find((app) => {
    const candidates = normalizedAppCandidates(app);
    return candidates.has(token) || candidates.has(name);
  })?.iconDataURL;
}

function normalizedAppBundleName(bundlePath: string): string {
  const fileName = bundlePath.split("/").pop() ?? bundlePath;
  return fileName.toLowerCase().endsWith(".app")
    ? fileName.toLowerCase()
    : `${fileName.toLowerCase()}.app`;
}

function normalizedAppCandidates(app: AppRecord): Set<string> {
  const fileName = app.bundlePath
    .split("/")
    .pop()
    ?.replace(/\.app$/iu, "");
  const candidates = [app.displayName, app.bundleIdentifier, fileName]
    .filter((value): value is string => Boolean(value))
    .map(normalizedName);
  return new Set(candidates.flatMap((value) => [value, value.replace(/^com/u, "")]));
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function detectLaggingHomebrewCaskTokens(
  items: HomebrewManagedItem[],
  updates: UpdateRecord[],
  apps: AppRecord[] = [],
  caskIndex: HomebrewCaskIndex = emptyHomebrewCaskIndex
): string[] {
  const reconciled = reconcileHomebrewInventory(items, updates, apps, caskIndex);
  return reconciled
    .filter((item, index) => item.kind === "cask" && item.isOutdated && !items[index]?.isOutdated)
    .map((item) => item.token.toLowerCase());
}

function catalogueCacheNotice(...statuses: Array<CatalogueStatus | undefined>): string | undefined {
  if (statuses.some((status) => status?.unavailable)) {
    return "Homebrew catalogue metadata is unavailable. Refresh to retry.";
  }
  const stale = statuses.filter((status): status is CatalogueStatus => Boolean(status?.stale));
  if (stale.length === 0) return undefined;
  const checkedAt = stale
    .map((status) => status.checkedAt)
    .filter(Boolean)
    .sort()[0];
  return `Using cached Homebrew catalogue metadata${checkedAt ? ` (last checked ${checkedAt})` : ""}. Refresh to retry.`;
}

function formulaHasContinuityIdentity(item: HomebrewManagedItem): boolean {
  // Validate saved structural identity independently of its current verification.
  // This helper is for ID reconciliation only; execution uses homebrewCommandToken.
  return (
    item.kind === "formula" &&
    Boolean(homebrewCommandToken({ ...item, formulaIdentityVerified: undefined }))
  );
}
