// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  HomebrewCaskIndex,
  HomebrewFormulaIndex,
  HomebrewManagedItem,
  MenuTab,
  PersistedSnapshot,
  SelfUpdateRecord,
  SnapshotProgress,
  SnapshotProgressEvent,
  UpdateRecord
} from "../shared/domain";
import {
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  normalizeAppearancePreference
} from "../shared/domain";
import type { HomebrewMaintenanceRunEvent } from "../shared/homebrewProgress";
import {
  caskIndexForInstalledItems,
  homebrewCommandToken,
  installedCaskEntry
} from "../shared/homebrewIdentity";
import type { PreferencePatch } from "../shared/ipc";
import { isAllowedExternalURL, isValidHomebrewToken } from "../shared/security";
import { isVersionEmpty, version, type VersionValue } from "../shared/version";
import { AppStoreLookupClient } from "./appStoreLookupClient";
import { BundleScannerClient } from "./bundleScanner";
import {
  runBrewCommand as defaultRunBrewCommand,
  runMasCommand as defaultRunMasCommand,
  type CommandResult
} from "./commandRunner";
import { HomebrewCaskClient } from "./homebrewCaskClient";
import { HomebrewFormulaClient } from "./homebrewFormulaClient";
import { HomebrewInventoryClient, type HomebrewInventoryResult } from "./homebrewInventoryClient";
import { HomebrewWorkLock } from "./homebrewWorkLock";
import {
  HomebrewOperationsService,
  type HomebrewOperationsState
} from "./homebrewOperationsService";
import { SnapshotPersistence } from "./persistence";
import { KeychainProfileStatsIntegrity, type ProfileStatsIntegrity } from "./profileStatsIntegrity";
import { ProfileStatsService, appUpdateProfileStatsEvent } from "./profileStatsService";
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

import {
  isAppUpdateNewerThanInstalledApp,
  lookupAppUpdates,
  mergeRecentlyUpdated
} from "./appUpdateLookupService";
import {
  canUseHomebrewAppUpdate,
  detectLaggingHomebrewCaskTokens,
  emptyHomebrewInventoryResult,
  homebrewCaskItemProvesAppOwnership,
  homebrewIdentityReconciliationItems,
  homebrewItemCanRunAppUpdate,
  installedCaskIdentifiesSelf,
  mergeHomebrewRecentlyUpdatedRecords,
  preserveFormulaIdentityContinuity,
  preservePreviousHomebrewInventoryMembership,
  preservePreviousHomebrewOutdatedState,
  reconcileHomebrewInventory
} from "./homebrewReconciliation";
import { RefreshLifecycle } from "./refreshLifecycle";
export {
  mergeHomebrewRecentlyUpdatedRecords,
  preservePreviousHomebrewOutdatedState
} from "./homebrewReconciliation";

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
  private readonly profileStatsService: ProfileStatsService;
  private readonly successRefreshDelayMS: number;
  private homebrewCleanupRequiresInventory = false;
  private latestHomebrewIndex: HomebrewCaskIndex = emptyHomebrewCaskIndex;
  private latestHomebrewFormulaIndex: HomebrewFormulaIndex = emptyHomebrewFormulaIndex;
  private hasCheckedHomebrewAvailability = false;
  private readonly homebrewWorkLock: HomebrewWorkLock<HomebrewInventoryResult>;
  private readonly homebrewOperations: HomebrewOperationsService;

  private state: BaselineSnapshot;
  private snapshotRevision = 0;
  private readonly progressPublisher = new ProgressPublisher((event) =>
    this.emit("progress", event)
  );

  private readonly refreshLifecycle = new RefreshLifecycle<RefreshOptions>(
    (lightweight, sequence, options, signal) =>
      this.computeRefresh(lightweight, sequence, options, signal),
    () => void this.refresh(true)
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
    this.successRefreshDelayMS = options.successRefreshDelayMS ?? successfulUpdateHoldMs;
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
    this.homebrewWorkLock = new HomebrewWorkLock({
      hasOtherMutation: () =>
        this.state.isRunningHomebrewMaintenance ||
        this.state.homebrewUninstallingItemIDs.length > 0 ||
        this.state.homebrewDiscoverInstallingItemIDs.length > 0,
      onLockStateChange: () => this.updateHomebrewCommandLockState(),
      onCommandReleased: () => void this.homebrewOperations.processHomebrewUpdateQueue()
    });
    this.profileStatsService = new ProfileStatsService({
      integrity: options.profileStatsIntegrity ?? new KeychainProfileStatsIntegrity(),
      getStats: () => this.state.profileStats,
      publishStats: (profileStats) => this.patch({ profileStats }),
      persist: () => this.persist()
    });
    this.homebrewOperations = new HomebrewOperationsService({
      getState: (): HomebrewOperationsState => {
        const {
          homebrewItems,
          updates,
          apps,
          ignoredIDs,
          ignoredHomebrewItemIDs,
          homebrewUpdatingItemIDs,
          homebrewQueuedItemIDs,
          homebrewBatchFailedItemIDs,
          homebrewBatchProgressByItemID,
          homebrewUpdatedPendingRefreshItemIDs,
          homebrewDiscoverInstallingItemIDs,
          homebrewDiscoverFailedItemIDs,
          homebrewDiscoverProgressByItemID,
          homebrewDiscoverInstalledPendingRefreshItemIDs,
          homebrewUninstallingItemIDs,
          isRunningHomebrewMaintenance,
          isHomebrewInstalled,
          refreshErrorMessage,
          lastRefreshNoticeMessage
        } = this.state;
        return {
          homebrewItems,
          updates,
          apps,
          ignoredIDs,
          ignoredHomebrewItemIDs,
          homebrewUpdatingItemIDs,
          homebrewQueuedItemIDs,
          homebrewBatchFailedItemIDs,
          homebrewBatchProgressByItemID,
          homebrewUpdatedPendingRefreshItemIDs,
          homebrewDiscoverInstallingItemIDs,
          homebrewDiscoverFailedItemIDs,
          homebrewDiscoverProgressByItemID,
          homebrewDiscoverInstalledPendingRefreshItemIDs,
          homebrewUninstallingItemIDs,
          isRunningHomebrewMaintenance,
          isHomebrewInstalled,
          refreshErrorMessage,
          lastRefreshNoticeMessage
        };
      },
      patch: (patch) => this.patch(patch),
      lock: this.homebrewWorkLock,
      runBrewCommand: this.runBrewCommand,
      emitHomebrewCommand: (event) => this.emit("homebrewCommand", event),
      refresh: (allowInventory) =>
        this.refresh(false, {
          allowHomebrewInventoryDuringActiveCommand: allowInventory
        }),
      recordProfileStatsEvents: (events) => this.profileStatsService.recordEvents(events),
      clearOperationFailure: (entityID, operation) =>
        this.clearOperationFailure(entityID, operation),
      recordOperationFailure: (entityID, operation, result) =>
        this.recordOperationFailure(entityID, operation, result),
      recordOperationFailures: (failures) => this.recordOperationFailures(failures),
      hasCheckedHomebrewAvailability: () => this.hasCheckedHomebrewAvailability,
      markHomebrewAvailabilityChecked: () => {
        this.hasCheckedHomebrewAvailability = true;
      },
      requiresInventory: () => this.homebrewCleanupRequiresInventory,
      successRefreshDelayMS: this.successRefreshDelayMS
    });
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
    await this.profileStatsService.verifyIntegrity();
  }

  async refresh(lightweight = false, options: RefreshOptions = {}): Promise<void> {
    return this.refreshLifecycle.refresh(lightweight, options);
  }

  async refreshToolStatus(): Promise<void> {
    this.patch({ isChecking: true });
    const masStatus = this.runMasCommand(["version"]);
    const releaseHomebrewCommandLock = this.reserveHomebrewCommandLock();
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
      this.homebrewWorkLock.activeCommandCount > 0 ||
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
    await this.profileStatsService.drain();
    await this.persist();
    if (this.hasActiveUpdateOperation()) return false;
    this.refreshLifecycle.stop();
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
          await this.profileStatsService.recordEvents([
            appUpdateProfileStatsEvent({
              appRecord,
              update,
              occurredAt: new Date().toISOString()
            })
          ]);
          await this.holdSuccessfulUpdate();
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
        await this.homebrewOperations.performHomebrewItemUpdate(item, {
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
    await this.homebrewOperations.performHomebrewUpdate(itemID);
  }

  async performHomebrewUpdateAll(itemIDs?: string[]): Promise<void> {
    await this.homebrewOperations.performHomebrewUpdateAll(itemIDs);
  }

  async installHomebrewItem(item: HomebrewCaskDiscoveryItem): Promise<void> {
    await this.homebrewOperations.installHomebrewItem(item);
  }

  async uninstallHomebrewItem(itemID: string): Promise<void> {
    await this.homebrewOperations.uninstallHomebrewItem(itemID);
  }

  private reserveHomebrewCommandLock(
    options: { allowRefreshSupersession?: boolean } = {}
  ): (() => void) | undefined {
    return this.homebrewWorkLock.reserveCommand(options);
  }

  private async computeRefresh(
    lightweight: boolean,
    sequence: number,
    options: RefreshOptions,
    signal: AbortSignal
  ): Promise<void> {
    this.homebrewWorkLock.beginRefresh(sequence);
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
      if (!this.refreshLifecycle.isCurrent(sequence)) {
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
      const updates = await lookupAppUpdates(
        { appStore: this.appStore, sparkle: this.sparkle, homebrew: this.homebrew },
        {
          apps,
          previousUpdates,
          homebrewItems,
          homebrewIndex,
          now,
          force,
          signal,
          isCurrent: () => this.refreshLifecycle.isCurrent(sequence),
          isSelfApp: (app) => this.isSelfApp(app),
          canUseHomebrewAppUpdate
        }
      );
      if (!updates) return;

      if (!this.refreshLifecycle.isCurrent(sequence)) {
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
      const recentlyUpdated = mergeRecentlyUpdated(
        this.state.recentlyUpdated,
        apps,
        updates,
        previousUpdates,
        now
      );
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
        this.isHomebrewMutationActive() && !options.allowHomebrewInventoryDuringActiveCommand;
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
      if (!this.refreshLifecycle.isCurrent(sequence)) return;
      options.onHomebrewInventoryReconciled?.(homebrewInventory);
      void this.homebrewOperations.processHomebrewUpdateQueue();
    } catch (error) {
      if (!this.refreshLifecycle.isCurrent(sequence)) {
        return;
      }
      // Keep this refresh's task even after the shared inventory lock is released.
      // An unrelated provider failure must not discard fresh membership evidence.
      const recoveredHomebrewInventory = await homebrewInventoryTask?.catch(() => undefined);
      if (!this.refreshLifecycle.isCurrent(sequence)) {
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
      void this.homebrewOperations.processHomebrewUpdateQueue();
    } finally {
      // Fresh identity, membership and pins must reach state before any queued
      // command can resume. A superseded refresh cannot release its successor.
      if (this.homebrewWorkLock.endRefresh(sequence)) {
        void this.homebrewOperations.processHomebrewUpdateQueue();
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
    return this.homebrewWorkLock.readInventory({
      updateMetadata: !lightweight,
      allowDuringMutation: Boolean(options.allowHomebrewInventoryDuringActiveCommand),
      blocked: () => ({
        items: this.state.homebrewItems,
        outdatedDetectionSucceeded: false,
        outdatedDetectionSucceededByKind: { formula: false, cask: false }
      }),
      start: (updateMetadata) => this.fetchFreshHomebrewInventory(updateMetadata),
      reconcileBeforeRelease: (result) => {
        if (result.inventoryReadSucceededByKind?.formula === false) {
          this.invalidateFormulaMembership();
        }
      },
      invalidateBeforeRelease: () => this.invalidateFormulaMembership()
    });
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
    if (!this.state.isHomebrewInstalled) return "Homebrew is not available.";
    const release = this.reserveHomebrewCommandLock({ allowRefreshSupersession: true });
    if (!release) return "Homebrew is busy. Try again when the current operation finishes.";
    const reservation = this.refreshLifecycle.beginCleanup();
    const refreshWasActive = reservation.refreshWasActive;
    this.patch({ isCleaningUpHomebrew: true, homebrewCleanupMessage: undefined });
    try {
      let confirmed = false;
      let confirmationRejected = false;
      let confirmationError: unknown;
      try {
        confirmed = await confirm();
      } catch (error) {
        confirmationRejected = true;
        confirmationError = error;
      }
      if (!confirmed) {
        // A refresh that overlaps confirmation may have observed new pins or
        // membership without committing them. Reconcile before releasing work,
        // even when no cleanup command was run.
        const refreshed =
          !(refreshWasActive || this.refreshLifecycle.wasRefreshRequestedDuringCleanup) ||
          (await this.refreshHomebrewCleanupInventory());
        let message = confirmationRejected
          ? "Homebrew cleanup could not run. Please try again."
          : "";
        if (!refreshed) {
          message = `${message || "Homebrew cleanup cancelled."} Installed packages could not be refreshed. Refresh again before updating.`;
        }
        this.patch({ homebrewCleanupMessage: message || undefined });
        if (confirmationRejected) throw confirmationError;
        return message;
      }
      let message: string;
      try {
        const result = await this.homebrewOperations.runBrewWithResultEvents(
          ["cleanup"],
          () => undefined
        );
        message = result.success
          ? "Homebrew cleanup completed."
          : "Homebrew cleanup did not complete. Some old versions, downloads, or unused dependencies may remain. Try again or check Homebrew in Terminal.";
      } catch {
        message = "Homebrew cleanup could not run. Try again or check Homebrew in Terminal.";
      }
      const refreshed = await this.refreshHomebrewCleanupInventory();
      if (!refreshed) {
        message += " Installed packages could not be refreshed. Refresh again before updating.";
      }
      this.patch({ homebrewCleanupMessage: message });
      return message;
    } finally {
      this.patch({ isCleaningUpHomebrew: false });
      reservation.finish();
      release();
    }
  }

  private async refreshHomebrewCleanupInventory(): Promise<boolean> {
    let refreshed = false;
    try {
      await this.refreshLifecycle.runCleanupGeneration((sequence, signal) =>
        this.computeRefresh(
          true,
          sequence,
          {
            allowHomebrewInventoryDuringActiveCommand: true,
            onHomebrewInventoryReconciled: (inventory) => {
              refreshed = this.homebrewInventoryIsComplete(inventory);
            }
          },
          signal
        )
      );
      if (!refreshed) {
        this.homebrewCleanupRequiresInventory = true;
        this.homebrewOperations.cancelQueuedHomebrewUpdates();
        this.invalidateHomebrewUpdateTargets();
        await this.persist().catch(() => undefined);
      }
    } catch {
      refreshed = false;
      this.homebrewCleanupRequiresInventory = true;
      this.homebrewOperations.cancelQueuedHomebrewUpdates();
      this.invalidateHomebrewUpdateTargets();
      await this.persist().catch(() => undefined);
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

  private isHomebrewCommandActive(): boolean {
    return this.homebrewWorkLock.isCommandActive;
  }

  private isHomebrewMutationActive(): boolean {
    return this.homebrewWorkLock.isMutationActive;
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

  private async holdSuccessfulUpdate(): Promise<void> {
    if (this.successRefreshDelayMS <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, this.successRefreshDelayMS));
  }

  private restartAutoRefreshLoop(): void {
    this.refreshLifecycle.restartAutoRefreshLoop(
      this.state.autoRefreshEnabled,
      this.state.refreshIntervalMinutes
    );
  }

  private async persist(): Promise<void> {
    await this.persistence.save(snapshotForPersistence(this.state));
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

  private updateHomebrewCommandLockState(): void {
    const isHomebrewCommandLocked = this.homebrewWorkLock.isCommandLocked;
    const isHomebrewCleanupLocked = this.homebrewWorkLock.isCleanupLocked;
    if (
      this.state.isHomebrewCommandLocked === isHomebrewCommandLocked &&
      this.state.isHomebrewCleanupLocked === isHomebrewCleanupLocked
    ) {
      return;
    }
    this.patch({ isHomebrewCommandLocked, isHomebrewCleanupLocked });
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
