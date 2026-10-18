// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { operationDetailsText } from "../shared/operationReport";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  MenuTab,
  PersistedSnapshot,
  SelfUpdateRecord,
  SnapshotProgress,
  SnapshotProgressEvent,
  UpdateRecord
} from "../shared/domain";
import { emptyHomebrewCaskIndex, normalizeAppearancePreference } from "../shared/domain";
import type { HomebrewMaintenanceRunEvent } from "../shared/homebrewProgress";
import { homebrewCommandToken, installedCaskEntry } from "../shared/homebrewIdentity";
import type { PreferencePatch } from "../shared/ipc";
import { validatedPreferencePatch } from "./preferenceValidation";
import { isAllowedExternalURL, isValidHomebrewToken } from "../shared/security";
import { isVersionEmpty, version, type VersionValue } from "../shared/version";
import { AppStoreLookupClient } from "./appStoreLookupClient";
import { BundleScannerClient } from "./bundleScanner";
import {
  runBrewCommand as defaultRunBrewCommand,
  commandWasCancelled,
  runMasCommand as defaultRunMasCommand,
  homebrewCleanupIsUnconfirmed,
  type CommandResult
} from "./commandRunner";
import { HomebrewCaskClient } from "./homebrewCaskClient";
import { HomebrewFormulaClient } from "./homebrewFormulaClient";
import { FileCatalogueStorage } from "./catalogueStorage";
import { HomebrewDiagnosticsService } from "./homebrewDiagnosticsService";
import type {
  HomebrewDiagnosticsRequest,
  HomebrewDiagnosticsReport
} from "../shared/homebrewDiagnostics";
import type { HomebrewInstalledMetadata } from "./homebrewInstalledMetadata";
import type { HomebrewInstalledContext } from "../shared/homebrewInstalledContext";
import {
  HomebrewInventoryClient,
  configurationBlockedInventory,
  type HomebrewInventoryResult
} from "./homebrewInventoryClient";
import {
  homebrewConfigurationBlockedMessage,
  safeConfigurationReason
} from "./homebrewConfiguration";
import type { HomebrewConfigurationReason } from "../shared/domain";
import { homebrewConfigurationValidatedMessage } from "../shared/homebrewConfiguration";
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
import { ToolStatusService } from "./toolStatusService";
import {
  failureReason,
  normalizeOperationFailures,
  type OperationFailure
} from "../shared/operationFailures";

import { isAppUpdateNewerThanInstalledApp } from "./appUpdateLookupService";
import {
  canUseHomebrewAppUpdate,
  emptyHomebrewInventoryResult,
  homebrewCaskItemProvesAppOwnership,
  homebrewItemCanRunAppUpdate,
  installedCaskIdentifiesSelf,
  preserveFormulaIdentityContinuity,
  preservePreviousHomebrewInventoryMembership
} from "./homebrewReconciliation";
import { RefreshLifecycle } from "./refreshLifecycle";
import {
  RefreshComputationService,
  homebrewInventoryIsComplete,
  type RefreshOptions,
  type RefreshReadState
} from "./refreshComputationService";
export {
  mergeHomebrewRecentlyUpdatedRecords,
  preservePreviousHomebrewOutdatedState
} from "./homebrewReconciliation";

type StoreEvents = {
  snapshot: [BaselineSnapshot];
  progress: [SnapshotProgressEvent];
  homebrewCommand: [HomebrewMaintenanceRunEvent];
};

type HomebrewCaskSource = Pick<HomebrewCaskClient, "fetchIndex" | "lookupUpdate" | "searchCasks"> &
  Partial<Pick<HomebrewCaskClient, "cacheStatus">>;
type HomebrewFormulaSource = Pick<HomebrewFormulaClient, "fetchIndex" | "searchFormulae"> &
  Partial<Pick<HomebrewFormulaClient, "cacheStatus">>;

type RefreshRecoveryRequest = Required<Pick<RefreshOptions, "forceMetadata" | "forceAppDiscovery">>;

const successfulUpdateHoldMs = 2000;

export class UpdateStore extends EventEmitter<StoreEvents> {
  private readonly persistence: SnapshotPersistence;
  private readonly scanner: Pick<BundleScannerClient, "scanApplications">;
  private readonly appStore: Pick<AppStoreLookupClient, "lookupOutcome"> &
    Partial<Pick<AppStoreLookupClient, "lookupOutcomes" | "storefront">>;
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
  private readonly isHomebrewCleanupUnconfirmed: () => boolean;
  private readonly openExternalURL: (url: string) => Promise<boolean>;
  private readonly openAppBundle: (bundlePath: string) => Promise<void>;
  private readonly profileStatsService: ProfileStatsService;
  private readonly successRefreshDelayMS: number;
  private homebrewCleanupRequiresInventory = false;
  private hasCheckedHomebrewAvailability = false;
  private readonly homebrewWorkLock: HomebrewWorkLock<HomebrewInventoryResult>;
  private readonly homebrewOperations: HomebrewOperationsService;
  private readonly toolStatus: ToolStatusService;
  private readonly refreshComputation: RefreshComputationService;
  private readonly homebrewDiagnostics: HomebrewDiagnosticsService;
  private installedMetadataByItemID: Record<string, HomebrewInstalledMetadata> = {};

  private state: BaselineSnapshot;
  private snapshotRevision = 0;
  private closing = false;
  private refreshRequestedWhileClosing?: RefreshRecoveryRequest;
  private refreshRecoveryRequired?: RefreshRecoveryRequest;
  private readonly activeRefreshRequests = new Set<RefreshRecoveryRequest>();
  private quitTask?: Promise<boolean>;
  private readonly pendingProducers = new Set<Promise<unknown>>();
  private mutationGeneration = 0;
  private readonly failureGenerations = new Map<string, number>();
  private readonly resultGenerations = new WeakMap<CommandResult, number>();
  private readonly progressPublisher = new ProgressPublisher((event) =>
    this.emit("progress", event)
  );

  private readonly refreshLifecycle = new RefreshLifecycle<RefreshOptions>(
    async (lightweight, sequence, options, signal) => {
      await this.refreshComputation.compute(lightweight, sequence, options, signal);
      const required = this.refreshRecoveryRequired;
      const carried = this.refreshRequestStrength(lightweight, options);
      if (
        required &&
        this.refreshLifecycle.isCurrent(sequence) &&
        !signal.aborted &&
        !this.state.refreshErrorMessage &&
        (!required.forceMetadata || carried.forceMetadata) &&
        (!required.forceAppDiscovery || carried.forceAppDiscovery)
      ) {
        this.refreshRecoveryRequired = undefined;
      }
    },
    () => void this.refresh(true)
  );

  constructor(options: {
    persistence: SnapshotPersistence;
    persisted: PersistedSnapshot;
    openExternalURL: (url: string) => Promise<boolean>;
    openAppBundle: (bundlePath: string) => Promise<void>;
    clients?: Partial<{
      scanner: Pick<BundleScannerClient, "scanApplications">;
      appStore: Pick<AppStoreLookupClient, "lookupOutcome"> &
        Partial<Pick<AppStoreLookupClient, "lookupOutcomes" | "storefront">>;
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
    isHomebrewCleanupUnconfirmed?: () => boolean;
    profileStatsIntegrity?: ProfileStatsIntegrity;
    successRefreshDelayMS?: number;
    catalogueCacheRoot?: string;
  }) {
    super();
    this.persistence = options.persistence;
    this.scanner = options.clients?.scanner ?? new BundleScannerClient();
    this.appStore = options.clients?.appStore ?? new AppStoreLookupClient();
    this.sparkle = options.clients?.sparkle ?? new SparkleAppcastClient();
    this.homebrew =
      options.clients?.homebrew ??
      new HomebrewCaskClient({
        storage: options.catalogueCacheRoot
          ? new FileCatalogueStorage(options.catalogueCacheRoot, "cask")
          : undefined
      });
    this.homebrewFormula =
      options.clients?.homebrewFormula ??
      new HomebrewFormulaClient({
        storage: options.catalogueCacheRoot
          ? new FileCatalogueStorage(options.catalogueCacheRoot, "formula")
          : undefined
      });
    this.homebrewInventory = options.clients?.homebrewInventory ?? new HomebrewInventoryClient();
    this.selfUpdate = options.clients?.selfUpdate ?? new SelfUpdateClient();
    this.currentAppVersion = version(options.currentAppVersion);
    this.currentAppIdentity = options.currentAppIdentity;
    this.isHomebrewCleanupUnconfirmed =
      options.isHomebrewCleanupUnconfirmed ?? homebrewCleanupIsUnconfirmed;
    const runBrew = options.runBrewCommand ?? defaultRunBrewCommand;
    this.runBrewCommand = async (...args) => {
      const generation = this.mutationGeneration;
      const result = { ...(await runBrew(...args)) };
      this.resultGenerations.set(result, generation);
      if (result.failure?.kind === "cleanup" || this.isHomebrewCleanupUnconfirmed()) {
        this.blockHomebrewAfterUnconfirmedCleanup();
      }
      if (result.failure?.kind === "configuration-blocked")
        this.blockHomebrewForConfiguration(result.failure.configurationReason);
      return result;
    };
    const runMas = options.runMasCommand ?? defaultRunMasCommand;
    this.runMasCommand = async (...args) => {
      const generation = this.mutationGeneration;
      const result = { ...(await runMas(...args)) };
      this.resultGenerations.set(result, generation);
      return result;
    };
    this.openExternalURL = options.openExternalURL;
    this.openAppBundle = options.openAppBundle;
    this.successRefreshDelayMS = options.successRefreshDelayMS ?? successfulUpdateHoldMs;
    const persisted = this.excludeSelfUpdates(
      sanitizePersistedSnapshotForRuntime(options.persisted)
    );
    this.state = {
      ...persisted,
      operationFailures: normalizeOperationFailures(persisted.operationFailures),
      operationFailureDetails: {},
      homebrewOperation: undefined,
      homebrewConfigurationBlocked: false,
      homebrewConfigurationReason: undefined,
      homebrewConfigurationValidated: false,
      isMasInstalled: false,
      masAvailability: "unknown",
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
    this.homebrewDiagnostics = new HomebrewDiagnosticsService({
      runBrew: this.runBrewCommand,
      reserveHomebrewWork: () => this.reserveHomebrewCommandLock()
    });
    this.profileStatsService = new ProfileStatsService({
      integrity: options.profileStatsIntegrity ?? new KeychainProfileStatsIntegrity(),
      getStats: () => this.state.profileStats,
      publishStats: (profileStats) => this.patch({ profileStats }),
      persist: () => this.persist()
    });
    this.toolStatus = new ToolStatusService({
      patch: (patch) =>
        this.patch({
          ...patch,
          ...(this.state.homebrewConfigurationBlocked &&
          patch.homebrewConfigurationBlocked === false &&
          patch.isHomebrewInstalled
            ? {
                lastRefreshNoticeMessage: homebrewConfigurationValidatedMessage,
                homebrewConfigurationValidated: true
              }
            : {}),
          // The runner latches refusals; only reconciled inventory clears them.
          // A delayed availability publication must not overwrite that newer state.
          homebrewConfigurationBlocked: Boolean(
            this.state.homebrewConfigurationBlocked || patch.homebrewConfigurationBlocked
          ),
          homebrewConfigurationReason: patch.homebrewConfigurationBlocked
            ? safeConfigurationReason(patch.homebrewConfigurationReason)
            : this.state.homebrewConfigurationReason,
          ...(patch.homebrewConfigurationBlocked ? { homebrewConfigurationValidated: false } : {})
        }),
      reserveHomebrewCommandLock: () => this.reserveHomebrewCommandLock(),
      runBrewCommand: this.runBrewCommand,
      runMasCommand: this.runMasCommand,
      markHomebrewAvailabilityChecked: () => {
        this.hasCheckedHomebrewAvailability = true;
      }
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
    this.refreshComputation = new RefreshComputationService(
      {
        scanner: this.scanner,
        appStore: this.appStore,
        sparkle: this.sparkle,
        homebrew: this.homebrew,
        homebrewFormula: this.homebrewFormula
      },
      {
        readState: (): RefreshReadState => {
          const {
            appProviderChecks,
            appUpdateComparisonBaseline,
            homebrewItems,
            homebrewFormulaIdentityContinuity,
            updates,
            recentlyUpdated,
            homebrewRecentlyUpdated,
            homebrewUpdatedPendingRefreshItemIDs,
            homebrewDiscoverInstallingItemIDs,
            homebrewDiscoverInstalledPendingRefreshItemIDs,
            homebrewDiscoverProgressByItemID,
            searchText
          } = this.state;
          return {
            appProviderChecks,
            appUpdateComparisonBaseline,
            homebrewItems,
            homebrewFormulaIdentityContinuity,
            updates,
            recentlyUpdated,
            homebrewRecentlyUpdated,
            homebrewUpdatedPendingRefreshItemIDs,
            homebrewDiscoverInstallingItemIDs,
            homebrewDiscoverInstalledPendingRefreshItemIDs,
            homebrewDiscoverProgressByItemID,
            searchText
          };
        },
        patch: (patch) => this.patch(patch),
        persist: () => this.persist(),
        scanDirectories: () => this.scanDirectories(),
        fetchHomebrewInventory: (lightweight, options) =>
          this.fetchHomebrewInventory(lightweight, options),
        lookupSelfUpdate: (now) => this.lookupSelfUpdate(now),
        isCurrent: (sequence) => this.refreshLifecycle.isCurrent(sequence),
        isSelfApp: (app) => this.isSelfApp(app),
        beginRefresh: (sequence) => this.homebrewWorkLock.beginRefresh(sequence),
        endRefresh: (sequence) => this.homebrewWorkLock.endRefresh(sequence),
        isHomebrewMutationActive: () => this.isHomebrewMutationActive(),
        isCleanupInventoryRequired: () => this.homebrewCleanupRequiresInventory,
        setCleanupInventoryRequired: (required, fullRefresh) => {
          this.homebrewCleanupRequiresInventory = required;
          if (!required && fullRefresh && this.state.homebrewConfigurationBlocked) {
            this.patch({
              homebrewConfigurationBlocked: false,
              homebrewConfigurationReason: undefined,
              homebrewConfigurationValidated: false
            });
          }
        },
        invalidateHomebrewUpdateTargets: () => this.invalidateHomebrewUpdateTargets(),
        processHomebrewUpdateQueue: () => {
          void this.homebrewOperations.processHomebrewUpdateQueue();
        }
      }
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
      appUpdateComparisonBaseline: snapshot.appUpdateComparisonBaseline?.filter(
        (update) => !ownIDs.has(update.appID)
      ),
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
    this.requireOpen();
    await this.refreshToolStatus();
    this.restartAutoRefreshLoop();
    void this.refresh(false);
  }

  getSnapshot(): BaselineSnapshot {
    return structuredClone({ ...this.state, snapshotRevision: this.snapshotRevision });
  }

  async verifyProfileStatsIntegrity(): Promise<void> {
    this.requireOpen();
    await this.profileStatsService.verifyIntegrity();
  }

  async refresh(lightweight = false, options: RefreshOptions = {}): Promise<void> {
    const request = this.refreshRequestStrength(lightweight, options);
    if (this.refreshRecoveryRequired) {
      request.forceMetadata ||= this.refreshRecoveryRequired.forceMetadata;
      request.forceAppDiscovery ||= this.refreshRecoveryRequired.forceAppDiscovery;
      options = { ...options, ...request };
      // Join a running recovery, but start a full scan when its work is still owed.
      if (!this.refreshLifecycle.isRefreshActive) lightweight = false;
    }
    if (this.closing) {
      this.deferRefresh(request);
      return;
    }
    this.activeRefreshRequests.add(request);
    try {
      await this.trackProducer(this.refreshLifecycle.refresh(lightweight, options));
    } finally {
      this.activeRefreshRequests.delete(request);
    }
  }

  private refreshRequestStrength(
    lightweight: boolean,
    options: RefreshOptions
  ): RefreshRecoveryRequest {
    return {
      forceMetadata:
        options.forceMetadata ??
        (!lightweight && !options.allowHomebrewInventoryDuringActiveCommand),
      forceAppDiscovery: options.forceAppDiscovery === true
    };
  }

  private deferRefresh(request: RefreshRecoveryRequest): void {
    this.refreshRequestedWhileClosing = {
      forceMetadata:
        this.refreshRequestedWhileClosing?.forceMetadata === true || request.forceMetadata,
      forceAppDiscovery:
        this.refreshRequestedWhileClosing?.forceAppDiscovery === true || request.forceAppDiscovery
    };
  }

  async refreshToolStatus(): Promise<void> {
    this.requireOpen();
    await this.trackProducer(this.toolStatus.check());
  }

  async setSearchText(searchText: string): Promise<void> {
    this.requireOpen();
    this.patch({ searchText });
    this.refreshComputation.refreshDiscoverItems();
  }

  async setSelectedTab(selectedTab: MenuTab): Promise<void> {
    this.requireOpen();
    this.patch({ selectedTab });
  }

  async updatePreferences(patch: PreferencePatch): Promise<void> {
    this.requireOpen();
    patch = validatedPreferencePatch(patch);
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
    this.requireOpen();
    if (this.selfUpdateCheckTask) return this.selfUpdateCheckTask;
    const task = this.lookupSelfUpdate(new Date().toISOString()).then((selfUpdate) => {
      this.patch({ selfUpdate });
      return selfUpdate;
    });
    this.selfUpdateCheckTask = task;
    void this.trackProducer(task).catch(() => undefined);
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
      (this.state.isHomebrewCleanupLocked && !this.homebrewWorkLock.hasUnconfirmedCleanup) ||
      this.state.appUpdatingIDs.length > 0 ||
      this.state.homebrewUpdatingItemIDs.length > 0 ||
      this.state.homebrewQueuedItemIDs.length > 0 ||
      this.state.homebrewUninstallingItemIDs.length > 0 ||
      this.state.homebrewDiscoverInstallingItemIDs.length > 0
    );
  }

  prepareToQuit(): Promise<boolean> {
    if (this.quitTask) return this.quitTask;
    if (this.hasActiveUpdateOperation()) return Promise.resolve(false);
    // Fence admission before yielding, then invalidate refresh commits and timers.
    this.closing = true;
    this.refreshRequestedWhileClosing = undefined;
    for (const request of this.activeRefreshRequests) this.deferRefresh(request);
    const interruptedRefresh = this.refreshLifecycle.isRefreshActive;
    this.refreshLifecycle.stop();
    const task = this.finishPreparingToQuit(interruptedRefresh);
    this.quitTask = task;
    return task;
  }

  private async finishPreparingToQuit(interruptedRefresh: boolean): Promise<boolean> {
    let ready = false;
    try {
      // Include superseded refreshes and writes already accepted before the fence.
      // A producer may enqueue a save while settling, so drain to quiescence.
      while (this.pendingProducers.size > 0) {
        await Promise.allSettled([...this.pendingProducers]);
      }
      await this.profileStatsService.drain();
      if (this.hasActiveUpdateOperation()) return false;
      this.patch({ isRefreshing: false });
      await this.persist();
      if (this.hasActiveUpdateOperation()) return false;
      this.homebrewOperations.dispose();
      this.progressPublisher.dispose();
      ready = true;
      return true;
    } finally {
      const requestedRefresh = this.refreshRequestedWhileClosing;
      this.refreshRequestedWhileClosing = undefined;
      if (ready) {
        this.refreshRecoveryRequired = undefined;
      } else {
        if (interruptedRefresh || requestedRefresh || this.refreshRecoveryRequired) {
          this.refreshRecoveryRequired = {
            forceMetadata:
              this.refreshRecoveryRequired?.forceMetadata === true ||
              requestedRefresh?.forceMetadata === true,
            forceAppDiscovery:
              this.refreshRecoveryRequired?.forceAppDiscovery === true ||
              requestedRefresh?.forceAppDiscovery === true
          };
        }
        this.closing = false;
        this.quitTask = undefined;
        this.patch({ isRefreshing: false });
        this.restartAutoRefreshLoop();
        if (this.refreshRecoveryRequired && !this.hasActiveUpdateOperation()) {
          void this.refresh(false, this.refreshRecoveryRequired).catch(() => undefined);
        }
      }
    }
  }

  private requireOpen(): void {
    if (this.closing) throw new Error("Baseline is finishing saving before quitting.");
  }

  private async trackProducer<T>(task: Promise<T>): Promise<T> {
    this.pendingProducers.add(task);
    try {
      return await task;
    } finally {
      this.pendingProducers.delete(task);
    }
  }

  async toggleIgnoredApp(appID: string): Promise<void> {
    this.requireOpen();
    const ignored = new Set(this.state.ignoredIDs);
    toggleSet(ignored, appID);
    this.patch({ ignoredIDs: [...ignored].sort() });
    await this.persist();
  }

  async toggleIgnoredHomebrew(itemID: string): Promise<void> {
    this.requireOpen();
    const ignored = new Set(this.state.ignoredHomebrewItemIDs);
    toggleSet(ignored, itemID);
    this.patch({ ignoredHomebrewItemIDs: [...ignored].sort() });
    await this.persist();
  }

  async acknowledgeProfileStatsReset(): Promise<void> {
    this.requireOpen();
    const resetID = this.state.profileStats.resetNotice?.id;
    if (!resetID || this.state.profileStatsResetAcknowledgedID === resetID) {
      return;
    }
    this.patch({ profileStatsResetAcknowledgedID: resetID });
    await this.persist();
  }

  operationFailureText(id: string, attemptID: string): string | undefined {
    const failure = this.state.operationFailures?.find((failure) => failure.id === id);
    const details = this.state.operationFailureDetails?.[id];
    if (!failure || (details?.attemptID ?? failure.occurredAt) !== attemptID) return;
    return operationDetailsText(failure, details?.outputTail);
  }

  async dismissOperationFailure(id: string): Promise<void> {
    this.requireOpen();
    const failures = this.state.operationFailures ?? [];
    const remaining = failures.filter((failure) => failure.id !== id);
    if (remaining.length === failures.length) return;
    this.patch({
      operationFailures: remaining,
      operationFailureDetails: Object.fromEntries(
        Object.entries(this.state.operationFailureDetails ?? {}).filter(([key]) =>
          remaining.some((failure) => failure.id === key)
        )
      )
    });
    await this.persistFailureDetails();
  }

  private clearOperationFailure(entityID: string, operation: OperationFailure["operation"]): void {
    this.failureGenerations.set(`${operation}:${entityID}`, this.mutationGeneration);
    const failures = this.state.operationFailures ?? [];
    const remaining = failures.filter(
      (failure) => failure.entityID !== entityID || failure.operation !== operation
    );
    if (remaining.length === failures.length) return;
    this.patch({
      operationFailures: remaining,
      operationFailureDetails: Object.fromEntries(
        Object.entries(this.state.operationFailureDetails ?? {}).filter(([key]) =>
          remaining.some((failure) => failure.id === key)
        )
      )
    });
    void this.persistFailureDetails();
  }

  private async recordOperationFailure(
    entityID: string,
    operation: OperationFailure["operation"],
    result: CommandResult,
    reason?: OperationFailure["reason"]
  ): Promise<string | undefined> {
    return this.recordOperationFailures([{ entityID, operation, result, reason }]);
  }

  private async recordOperationFailures(
    failures: Array<{
      entityID: string;
      operation: OperationFailure["operation"];
      result: CommandResult;
      reason?: OperationFailure["reason"];
    }>
  ): Promise<string | undefined> {
    failures = failures.filter(
      ({ result }) =>
        !commandWasCancelled(result) && result.failure?.kind !== "configuration-blocked"
    );
    if (failures.length === 0) return;
    const occurredAt = new Date().toISOString();
    const records = failures.map(({ entityID, operation, result, reason }): OperationFailure => ({
      id: `${operation}:${entityID}`,
      entityID,
      operation,
      reason:
        reason ??
        (result.failure &&
        ["cancelled", "timeout", "signal", "cleanup"].includes(result.failure.kind)
          ? "interrupted"
          : failureReason(result.stderr || result.output)),
      status: result.status,
      occurredAt
    }));
    const ids = new Set(records.map((record) => record.id));
    const details = { ...this.state.operationFailureDetails };
    failures.forEach(({ entityID, operation, result }) => {
      const id = `${operation}:${entityID}`;
      const current =
        this.failureGenerations.get(id) === this.mutationGeneration &&
        this.resultGenerations.get(result) === this.mutationGeneration;
      details[id] = {
        attemptID: randomUUID(),
        outputTail: current ? result.outputTail : undefined
      };
    });
    const operationFailures = normalizeOperationFailures([
      ...records,
      ...(this.state.operationFailures ?? []).filter((previous) => !ids.has(previous.id))
    ]);
    this.patch({
      operationFailureDetails: Object.fromEntries(
        Object.entries(details).filter(([key]) =>
          operationFailures.some((failure) => failure.id === key)
        )
      ),
      operationFailures
    });
    return this.persistFailureDetails();
  }

  private async persistFailureDetails(): Promise<string | undefined> {
    try {
      await this.persist();
    } catch {
      const notice =
        "Failure details could not be saved. They remain available until Baseline quits.";
      this.patch({ lastRefreshNoticeMessage: notice });
      return notice;
    }
  }

  async addDirectory(directory: string): Promise<void> {
    this.requireOpen();
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
    this.requireOpen();
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
    this.requireOpen();
    const appRecord = this.state.apps.find((app) => app.id === appID);
    if (appRecord) {
      await this.openAppBundle(appRecord.bundlePath);
    }
  }

  async openExternal(url: string): Promise<boolean> {
    this.requireOpen();
    if (!isAllowedExternalURL(url)) {
      this.patch({ refreshErrorMessage: "Blocked an unsafe external link." });
      return false;
    }
    return this.openExternalURL(url);
  }

  private beginUserMutation(): void {
    this.requireOpen();
    this.mutationGeneration++;
    this.failureGenerations.clear();
    this.patch({ operationFailureDetails: {} });
  }

  async performAppUpdate(appID: string): Promise<void> {
    this.beginUserMutation();
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
      this.state.masAvailability !== "missing" &&
      update.source === "appStore" &&
      update.appStoreItemID
    ) {
      await this.withAppUpdating(appID, async () => {
        this.clearOperationFailure(appID, "update");
        this.toolStatus.beginMasCommand();
        const result = await this.runMasCommand(["upgrade", String(update.appStoreItemID)]);
        this.toolStatus.recordMasCommandResult(result);
        if (result.success) {
          this.patch({
            appUpdatedPendingRefreshIDs: addToArray(this.state.appUpdatedPendingRefreshIDs, appID)
          });
          let statsNotice: string | undefined;
          try {
            await this.profileStatsService.recordEvents([
              appUpdateProfileStatsEvent({
                appRecord,
                update,
                occurredAt: new Date().toISOString()
              })
            ]);
          } catch {
            statsNotice = "App update completed, but local update history could not be saved.";
          }
          try {
            await this.holdSuccessfulUpdate();
            await this.refresh(false, { forceMetadata: false });
          } finally {
            if (statsNotice) {
              this.patch({
                lastRefreshNoticeMessage: [this.state.lastRefreshNoticeMessage, statsNotice]
                  .filter(Boolean)
                  .join(" ")
              });
            }
          }
        } else {
          if (!(result.failure?.kind === "spawn" && result.failure.code === "ENOENT")) {
            await this.recordOperationFailure(appID, "update", result);
          }
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
    this.beginUserMutation();
    await this.homebrewOperations.performHomebrewUpdate(itemID);
  }

  async performHomebrewUpdateAll(itemIDs?: string[]): Promise<void> {
    this.beginUserMutation();
    await this.homebrewOperations.performHomebrewUpdateAll(itemIDs);
  }

  async installHomebrewItem(item: HomebrewCaskDiscoveryItem): Promise<void> {
    this.beginUserMutation();
    await this.homebrewOperations.installHomebrewItem(item);
  }

  async uninstallHomebrewItem(itemID: string): Promise<void> {
    this.beginUserMutation();
    await this.homebrewOperations.uninstallHomebrewItem(itemID);
  }

  collectHomebrewDiagnostics(
    request: HomebrewDiagnosticsRequest = {}
  ): Promise<HomebrewDiagnosticsReport> {
    if (this.closing) return Promise.resolve({ status: "busy" });
    return this.homebrewDiagnostics.collect(request);
  }

  getCatalogueDiagnostics(): string {
    const lines = (
      [
        ["Casks", this.homebrew.cacheStatus?.decode],
        ["Formulae", this.homebrewFormula.cacheStatus?.decode]
      ] as const
    ).flatMap(([kind, status]) => {
      if (
        !status ||
        ![status.totalEntries, status.skippedEntries, status.schemaWarnings].every(
          (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000
        )
      )
        return [];
      return [
        `${kind}: ${status.totalEntries} entries, ${status.skippedEntries} skipped, ${status.schemaWarnings} schema warnings.`
      ];
    });
    return lines.length ? `\n\nHomebrew catalogue parsing\n${lines.join("\n")}` : "";
  }

  getHomebrewInstalledContext(itemID: string): HomebrewInstalledContext | undefined {
    if (typeof itemID !== "string" || this.homebrewWorkLock.hasUnconfirmedCleanup) return undefined;
    const items = this.state.homebrewItems.filter((candidate) => candidate.id === itemID);
    if (items.length !== 1) return undefined;
    const item = items[0]!;
    const identity = homebrewCommandToken(item);
    if (!identity) return undefined;
    // Reconciliation can retain a saved ID across a proven rename. Bind only
    // unique current verified identities, never the historical ID or bare token.
    if (
      this.state.homebrewItems.filter(
        (candidate) => candidate.kind === item.kind && homebrewCommandToken(candidate) === identity
      ).length !== 1
    )
      return undefined;
    const matches = Object.values(this.installedMetadataByItemID).filter(
      (metadata) => metadata.kind === item.kind && metadata.identity === identity
    );
    if (matches.length !== 1) return undefined;
    const metadata = matches[0]!;
    return {
      deprecated: metadata.deprecated,
      disabled: metadata.disabled,
      autoUpdates: metadata.autoUpdates,
      installedOnRequest: metadata.installedOnRequest,
      caveatsAvailable: Boolean(metadata.caveats),
      installedReceiptCount: metadata.installedReceipts.length,
      declaredDependencyCount: new Set(
        metadata.dependencies
          .filter((dependency) => dependency.source === "declaration")
          .map((dependency) => `${dependency.kind}:${dependency.token}`)
      ).size,
      observedRuntimeDependencyCount: new Set(
        metadata.dependencies
          .filter((dependency) => dependency.source === "receipt" && dependency.scope === "runtime")
          .map((dependency) => `${dependency.kind}:${dependency.token}`)
      ).size,
      observedInstalledDependentCount: metadata.installedDependents.length
    };
  }

  private reserveHomebrewCommandLock(
    options: { allowRefreshSupersession?: boolean } = {}
  ): (() => void) | undefined {
    if (this.closing) return undefined;
    return this.homebrewWorkLock.reserveCommand(options);
  }

  private blockHomebrewAfterUnconfirmedCleanup(): void {
    this.installedMetadataByItemID = {};
    this.homebrewWorkLock.blockAfterUnconfirmedCleanup();
    this.homebrewOperations.cancelQueuedHomebrewUpdates();
    this.invalidateHomebrewUpdateTargets();
    this.patch({
      lastRefreshNoticeMessage:
        "Homebrew process cleanup could not be confirmed. Check running Homebrew processes before restarting Baseline."
    });
  }

  private blockHomebrewForConfiguration(reason?: HomebrewConfigurationReason): void {
    this.installedMetadataByItemID = {};
    this.homebrewCleanupRequiresInventory = true;
    this.homebrewOperations.cancelQueuedHomebrewUpdates();
    this.invalidateFormulaMembership();
    this.invalidateHomebrewUpdateTargets();
    this.patch({
      isHomebrewInstalled: true,
      homebrewConfigurationBlocked: true,
      homebrewConfigurationReason: safeConfigurationReason(reason),
      homebrewConfigurationValidated: false,
      lastRefreshNoticeMessage: homebrewConfigurationBlockedMessage
    });
  }

  private quarantinedHomebrewInventory(): HomebrewInventoryResult {
    return {
      items: [],
      inventoryReadSucceededByKind: { formula: false, cask: false },
      outdatedDetectionSucceeded: false,
      outdatedDetectionSucceededByKind: { formula: false, cask: false },
      warning:
        "Homebrew process cleanup could not be confirmed. Check running Homebrew processes before restarting Baseline."
    };
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
      blocked: () =>
        this.homebrewWorkLock.hasUnconfirmedCleanup
          ? this.quarantinedHomebrewInventory()
          : {
              items: this.state.homebrewItems,
              outdatedDetectionSucceeded: false,
              outdatedDetectionSucceededByKind: { formula: false, cask: false }
            },
      start: (updateMetadata) => this.fetchFreshHomebrewInventory(updateMetadata),
      reconcileBeforeRelease: (result) => {
        if (result.configurationBlocked)
          this.blockHomebrewForConfiguration(result.configurationReason);
        // Older inventory transports do not preserve individual runner failure
        // details. Observe the process-wide latch as well as newer producers.
        if (
          this.isHomebrewCleanupUnconfirmed() ||
          ("cleanupUnconfirmed" in result && result.cleanupUnconfirmed === true)
        ) {
          this.blockHomebrewAfterUnconfirmedCleanup();
        }
        // Metadata is an ephemeral projection, revoked on uncertain cleanup
        // or a failed kind read before the shared reservation is released.
        const identityCounts = new Map<string, number>();
        for (const item of result.items) {
          const identity = homebrewCommandToken(item);
          if (!identity) continue;
          const key = `${item.kind}:${identity}`;
          identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
        }
        this.installedMetadataByItemID = this.homebrewWorkLock.hasUnconfirmedCleanup
          ? {}
          : Object.fromEntries(
              Object.entries(result.installedMetadataByItemID ?? {}).filter(
                ([, metadata]) =>
                  result.inventoryReadSucceededByKind?.[metadata.kind] !== false &&
                  identityCounts.get(`${metadata.kind}:${metadata.identity}`) === 1
              )
            );
        if (result.inventoryReadSucceededByKind?.formula === false) {
          this.invalidateFormulaMembership();
        }
      },
      invalidateBeforeRelease: () => {
        this.installedMetadataByItemID = {};
        if (this.isHomebrewCleanupUnconfirmed()) this.blockHomebrewAfterUnconfirmedCleanup();
        this.invalidateFormulaMembership();
      }
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
    if (this.isHomebrewCleanupUnconfirmed()) {
      this.blockHomebrewAfterUnconfirmedCleanup();
      return this.quarantinedHomebrewInventory();
    }
    if (this.hasCheckedHomebrewAvailability && !this.state.isHomebrewInstalled) {
      const brew = await this.runBrewCommand(["--version"]);
      this.hasCheckedHomebrewAvailability = true;
      if (!brew.success) {
        if (brew.failure?.kind === "configuration-blocked")
          return configurationBlockedInventory(brew.failure.configurationReason);
        if (this.homebrewCleanupRequiresInventory) {
          // Even a missing executable is not proof that cached packages disappeared.
          return {
            items: [],
            inventoryReadSucceededByKind: { formula: false, cask: false },
            outdatedDetectionSucceeded: false,
            outdatedDetectionSucceededByKind: { formula: false, cask: false },
            warning:
              "Installed Homebrew packages could not be refreshed. Refresh again before updating."
          };
        }
        return emptyHomebrewInventoryResult();
      }
      this.patch({ isHomebrewInstalled: true });
    }
    const result = await this.homebrewInventory.fetchInventory({ updateMetadata });
    if (
      this.isHomebrewCleanupUnconfirmed() ||
      ("cleanupUnconfirmed" in result && result.cleanupUnconfirmed === true)
    ) {
      this.blockHomebrewAfterUnconfirmedCleanup();
      return { ...result, ...this.quarantinedHomebrewInventory() };
    }
    return result;
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
    this.requireOpen();
    const inventoryRequired = "Refresh installed packages before cleaning up Homebrew.";
    if (this.homebrewCleanupRequiresInventory) return inventoryRequired;
    this.beginUserMutation();
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
      if (this.homebrewCleanupRequiresInventory) {
        this.patch({ homebrewCleanupMessage: inventoryRequired });
        return inventoryRequired;
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
        this.refreshComputation.compute(
          true,
          sequence,
          {
            allowHomebrewInventoryDuringActiveCommand: true,
            onHomebrewInventoryReconciled: (inventory) => {
              refreshed = homebrewInventoryIsComplete(inventory);
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
          installedCaskEntry(item, this.refreshComputation.caskIndex)
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
    this.requireOpen();
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
      !this.closing && this.state.autoRefreshEnabled,
      this.state.refreshIntervalMinutes
    );
  }

  private async persist(): Promise<void> {
    await this.trackProducer(this.persistence.save(snapshotForPersistence(this.state)));
  }

  private patch(patch: Partial<BaselineSnapshot>): void {
    const keys = Object.keys(patch) as (keyof BaselineSnapshot)[];
    // Compare only supplied fields, before cloning or advancing the stream.
    // An unchanged patch must also leave any queued progress delta intact.
    if (keys.every((key) => isDeepStrictEqual(this.state[key], patch[key]))) return;
    const progressKeys = [
      "homebrewBatchProgressByItemID",
      "homebrewFallbackProgressByAppID",
      "homebrewDiscoverProgressByItemID"
    ] as const;
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
    appProviderChecks: snapshot.appProviderChecks,
    apps: snapshot.apps,
    updates: snapshot.updates,
    appUpdateComparisonBaseline: snapshot.appUpdateComparisonBaseline,
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
