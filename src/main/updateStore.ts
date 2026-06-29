// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
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
  UpdateRecord
} from "../shared/domain";
import {
  defaultProfileStatsAfterTamper,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  normalizeAppearancePreference
} from "../shared/domain";
import {
  HomebrewMaintenanceOutputParser,
  HomebrewMaintenanceProgressStage,
  type HomebrewMaintenanceRunEvent
} from "../shared/homebrewProgress";
import { homebrewItemHasAppRepresentation } from "../shared/homebrewAppLinking";
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
import { HomebrewCaskClient } from "./homebrewCaskClient";
import { HomebrewFormulaClient } from "./homebrewFormulaClient";
import { HomebrewInventoryClient, type HomebrewInventoryResult } from "./homebrewInventoryClient";
import { SnapshotPersistence } from "./persistence";
import { KeychainProfileStatsIntegrity, type ProfileStatsIntegrity } from "./profileStatsIntegrity";
import { SelfUpdateClient } from "./selfUpdateClient";
import { SparkleAppcastClient } from "./sparkleAppcastClient";

type StoreEvents = {
  snapshot: [BaselineSnapshot];
  homebrewCommand: [HomebrewMaintenanceRunEvent];
};

type RefreshOptions = {
  allowHomebrewInventoryDuringActiveCommand?: boolean;
};

type AppLookupSource = Extract<UpdateRecord["source"], "appStore" | "sparkle">;

type HomebrewUpdateQueueEntry = {
  item: HomebrewManagedItem;
  profileStatsEvent?: ProfileStatsEvent;
  appUpdateAppID?: string;
  requiredRemoteVersion?: VersionValue;
  requireOutdated: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const TRANSIENT_HOMEBREW_FAILURE_MS = 4000;
const successfulUpdateHoldMs = 2000;

export class UpdateStore extends EventEmitter<StoreEvents> {
  private readonly persistence: SnapshotPersistence;
  private readonly scanner: Pick<BundleScannerClient, "scanApplications">;
  private readonly appStore: Pick<AppStoreLookupClient, "lookupOutcome">;
  private readonly sparkle: Pick<SparkleAppcastClient, "lookupOutcome">;
  private readonly homebrew: Pick<
    HomebrewCaskClient,
    "fetchIndex" | "lookupUpdate" | "searchCasks"
  >;
  private readonly homebrewFormula: Pick<HomebrewFormulaClient, "fetchIndex" | "searchFormulae">;
  private readonly homebrewInventory: Pick<HomebrewInventoryClient, "fetchInventory">;
  private readonly selfUpdate: Pick<SelfUpdateClient, "lookup">;
  private readonly currentAppVersion: VersionValue;
  private readonly runBrewCommand: typeof defaultRunBrewCommand;
  private readonly runMasCommand: typeof defaultRunMasCommand;
  private readonly openExternalURL: (url: string) => Promise<boolean>;
  private readonly openAppBundle: (bundlePath: string) => Promise<void>;
  private readonly profileStatsIntegrity: ProfileStatsIntegrity;
  private readonly successRefreshDelayMS: number;
  private refreshTask?: Promise<void>;
  private refreshSequence = 0;
  private autoRefreshTimer?: NodeJS.Timeout;
  private readonly homebrewBatchFailureClearTimers = new Map<string, NodeJS.Timeout>();
  private readonly homebrewDiscoverFailureClearTimers = new Map<string, NodeJS.Timeout>();
  private latestHomebrewIndex: HomebrewCaskIndex = emptyHomebrewCaskIndex;
  private latestHomebrewFormulaIndex: HomebrewFormulaIndex = emptyHomebrewFormulaIndex;
  private hasCheckedHomebrewAvailability = false;
  private profileStatsMutationQueue: Promise<void> = Promise.resolve();
  private activeHomebrewCommandCount = 0;
  private activeHomebrewInventoryCount = 0;
  private activeHomebrewInventoryTask?: {
    updateMetadata: boolean;
    task: Promise<HomebrewInventoryResult>;
  };
  private readonly homebrewUpdateQueue: HomebrewUpdateQueueEntry[] = [];
  private isProcessingHomebrewUpdateQueue = false;

  private state: BaselineSnapshot;

  constructor(options: {
    persistence: SnapshotPersistence;
    persisted: PersistedSnapshot;
    openExternalURL: (url: string) => Promise<boolean>;
    openAppBundle: (bundlePath: string) => Promise<void>;
    clients?: Partial<{
      scanner: Pick<BundleScannerClient, "scanApplications">;
      appStore: Pick<AppStoreLookupClient, "lookupOutcome">;
      sparkle: Pick<SparkleAppcastClient, "lookupOutcome">;
      homebrew: Pick<HomebrewCaskClient, "fetchIndex" | "lookupUpdate" | "searchCasks">;
      homebrewFormula: Pick<HomebrewFormulaClient, "fetchIndex" | "searchFormulae">;
      homebrewInventory: Pick<HomebrewInventoryClient, "fetchInventory">;
      selfUpdate: Pick<SelfUpdateClient, "lookup">;
    }>;
    currentAppVersion?: string;
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
    this.runBrewCommand = options.runBrewCommand ?? defaultRunBrewCommand;
    this.runMasCommand = options.runMasCommand ?? defaultRunMasCommand;
    this.openExternalURL = options.openExternalURL;
    this.openAppBundle = options.openAppBundle;
    this.profileStatsIntegrity =
      options.profileStatsIntegrity ?? new KeychainProfileStatsIntegrity();
    this.successRefreshDelayMS = options.successRefreshDelayMS ?? successfulUpdateHoldMs;
    const persisted = sanitizePersistedSnapshotForRuntime(options.persisted);
    this.state = {
      ...persisted,
      isMasInstalled: false,
      isHomebrewInstalled: false,
      isChecking: false,
      isRefreshing: false,
      searchText: "",
      isRunningHomebrewMaintenance: false,
      isHomebrewCommandLocked: false,
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
  }

  async start(): Promise<void> {
    await this.refreshToolStatus();
    this.restartAutoRefreshLoop();
    void this.refresh(false);
  }

  getSnapshot(): BaselineSnapshot {
    return structuredClone(this.state);
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
    if (this.refreshTask && lightweight) {
      return this.refreshTask;
    }
    const sequence = ++this.refreshSequence;
    const task = this.computeRefresh(lightweight, sequence, options);
    this.refreshTask = task;
    return task.finally(() => {
      if (this.refreshTask === task) {
        this.refreshTask = undefined;
      }
    });
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
    this.patch({ ...patch, appearancePreference, refreshIntervalMinutes });
    this.restartAutoRefreshLoop();
    await this.persist();
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
    await this.refresh(false);
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
    await this.refresh(false);
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
          await this.holdSuccessfulUpdate();
          await this.refresh();
        } else {
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
      if (item && homebrewItemCanRunAppUpdate(item, update)) {
        await this.performHomebrewItemUpdate(item, {
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
    const item = this.state.homebrewItems.find((candidate) => candidate.id === itemID);
    if (!item?.isOutdated || !isValidHomebrewToken(item.token)) {
      return;
    }
    await this.performHomebrewItemUpdate(item, { requireOutdated: true });
  }

  private async performHomebrewItemUpdate(
    item: HomebrewManagedItem,
    options: {
      profileStatsEvent?: ProfileStatsEvent;
      appUpdateAppID?: string;
      requiredRemoteVersion?: VersionValue;
      requireOutdated?: boolean;
    } = {}
  ): Promise<void> {
    const queuedUpdate = this.queueHomebrewItemUpdate(item, options);
    if (queuedUpdate) {
      await queuedUpdate;
    }
  }

  private queueHomebrewItemUpdate(
    item: HomebrewManagedItem,
    options: {
      profileStatsEvent?: ProfileStatsEvent;
      appUpdateAppID?: string;
      requiredRemoteVersion?: VersionValue;
      requireOutdated?: boolean;
    } = {}
  ): Promise<void> | undefined {
    if (!isValidHomebrewToken(item.token)) {
      return undefined;
    }
    if (
      this.state.homebrewUpdatingItemIDs.includes(item.id) ||
      this.homebrewUpdateQueue.some((entry) => entry.item.id === item.id)
    ) {
      return undefined;
    }
    this.clearHomebrewBatchFailureTimer(item.id);
    this.patch({
      homebrewUpdatingItemIDs: addToArray(this.state.homebrewUpdatingItemIDs, item.id),
      homebrewQueuedItemIDs: addToArray(this.state.homebrewQueuedItemIDs, item.id),
      homebrewBatchFailedItemIDs: removeFromArray(this.state.homebrewBatchFailedItemIDs, item.id),
      homebrewBatchProgressByItemID: {
        ...this.state.homebrewBatchProgressByItemID,
        [item.id]: HomebrewMaintenanceProgressStage.queued
      }
    });
    return new Promise<void>((resolve, reject) => {
      this.homebrewUpdateQueue.push({
        item,
        profileStatsEvent: options.profileStatsEvent,
        appUpdateAppID: options.appUpdateAppID,
        requiredRemoteVersion: options.requiredRemoteVersion,
        requireOutdated: options.requireOutdated ?? false,
        resolve,
        reject
      });
      void this.processHomebrewUpdateQueue();
    });
  }

  private async runHomebrewItemUpdate(
    item: HomebrewManagedItem,
    profileStatsEvent?: ProfileStatsEvent
  ): Promise<void> {
    const itemID = item.id;
    const command =
      item.kind === "cask"
        ? ["upgrade", "--cask", "--greedy", item.token]
        : ["upgrade", item.token];
    const parser = new HomebrewMaintenanceOutputParser([item.token.toLowerCase()]);
    const result = await this.runBrewWithEvents(command, (event) => {
      this.applyHomebrewProgressEvent(
        event,
        parser,
        new Map([[item.token.toLowerCase(), [itemID]]])
      );
    });
    if (result) {
      this.patch({
        refreshErrorMessage: undefined,
        homebrewBatchFailedItemIDs: removeFromArray(this.state.homebrewBatchFailedItemIDs, itemID),
        homebrewBatchProgressByItemID: {
          ...this.state.homebrewBatchProgressByItemID,
          [itemID]: HomebrewMaintenanceProgressStage.finalizing
        }
      });
      await this.recordProfileStatsEvents([
        profileStatsEvent ??
          homebrewUpdateProfileStatsEvent({ item, occurredAt: new Date().toISOString() })
      ]);
      const cleanupNotice = await this.runPostSuccessHomebrewCleanup();
      this.patch({
        homebrewUpdatedPendingRefreshItemIDs: addToArray(
          this.state.homebrewUpdatedPendingRefreshItemIDs,
          itemID
        ),
        homebrewBatchProgressByItemID: {
          ...this.state.homebrewBatchProgressByItemID,
          [itemID]: 1
        }
      });
      await this.holdSuccessfulUpdate();
      await this.refresh(false, { allowHomebrewInventoryDuringActiveCommand: true });
      this.applyHomebrewCleanupNotice(cleanupNotice);
    } else {
      this.patch({
        refreshErrorMessage: `Homebrew update failed for ${item.name}.`,
        homebrewBatchFailedItemIDs: addToArray(this.state.homebrewBatchFailedItemIDs, itemID),
        homebrewBatchProgressByItemID: {
          ...this.state.homebrewBatchProgressByItemID,
          [itemID]: 1
        }
      });
      this.scheduleHomebrewBatchFailureClear([itemID]);
      await this.refresh(false, { allowHomebrewInventoryDuringActiveCommand: true });
    }
  }

  private async runHomebrewQueuedUpdates(entries: HomebrewUpdateQueueEntry[]): Promise<void> {
    const itemsWithEvents = entries
      .map((entry) => {
        const item = this.state.homebrewItems.find((candidate) => candidate.id === entry.item.id);
        return item ? { entry, item } : undefined;
      })
      .filter(
        (
          itemWithEvent
        ): itemWithEvent is { entry: HomebrewUpdateQueueEntry; item: HomebrewManagedItem } =>
          Boolean(
            itemWithEvent &&
            this.queuedHomebrewUpdateIsStillCurrent(itemWithEvent.entry, itemWithEvent.item) &&
            isValidHomebrewToken(itemWithEvent.item.token)
          )
      );
    if (itemsWithEvents.length === 0) {
      return;
    }
    const firstItemWithEvent = itemsWithEvents[0];
    if (itemsWithEvents.length === 1 && firstItemWithEvent) {
      await this.runHomebrewItemUpdate(
        firstItemWithEvent.item,
        firstItemWithEvent.entry.profileStatsEvent
      );
      return;
    }

    const affected = itemsWithEvents.map(({ item }) => item);
    const formulaTokens = affected
      .filter((item) => item.kind === "formula")
      .map((item) => item.token);
    const caskTokens = affected.filter((item) => item.kind === "cask").map((item) => item.token);
    const affectedIDs = affected.map((item) => item.id);
    const affectedByToken = new Map<string, string[]>();
    for (const item of affected) {
      affectedByToken.set(item.token.toLowerCase(), [
        ...(affectedByToken.get(item.token.toLowerCase()) ?? []),
        item.id
      ]);
    }
    const affectedKindByID = new Map(affected.map((item) => [item.id, item.kind]));
    const parser = new HomebrewMaintenanceOutputParser(
      affected.map((item) => item.token.toLowerCase())
    );
    const sequence = [
      ...(formulaTokens.length > 0 ? [["upgrade", ...formulaTokens]] : []),
      ...(caskTokens.length > 0 ? [["upgrade", "--cask", "--greedy", ...caskTokens]] : [])
    ];
    const completedItemIDs = new Set<string>();
    let success = true;
    for (const command of sequence) {
      const result = await this.runBrewWithEvents(command, (event) => {
        this.applyHomebrewProgressEvent(
          event,
          parser,
          affectedByToken,
          affectedKindByID,
          completedItemIDs
        );
      });
      if (result) {
        const upgradedKind = homebrewUpgradeKindForCommand(command);
        if (upgradedKind) {
          for (const item of affected.filter((candidate) => candidate.kind === upgradedKind)) {
            completedItemIDs.add(item.id);
          }
        }
      }
      if (!result) {
        success = false;
        break;
      }
    }

    const completedIDs = success
      ? affectedIDs
      : affectedIDs.filter((id) => completedItemIDs.has(id));
    const failedIDs = success ? [] : affectedIDs.filter((id) => !completedItemIDs.has(id));
    this.patch({
      refreshErrorMessage: success ? undefined : "Homebrew update failed.",
      homebrewBatchFailedItemIDs: success
        ? this.state.homebrewBatchFailedItemIDs.filter((id) => !affectedIDs.includes(id))
        : [
            ...new Set([
              ...this.state.homebrewBatchFailedItemIDs,
              ...failedIDs.filter(
                (id) => !this.state.homebrewUpdatedPendingRefreshItemIDs.includes(id)
              )
            ])
          ],
      homebrewBatchProgressByItemID: {
        ...this.state.homebrewBatchProgressByItemID,
        ...Object.fromEntries(
          completedIDs.map((id) => [id, HomebrewMaintenanceProgressStage.finalizing])
        ),
        ...Object.fromEntries(failedIDs.map((id) => [id, 1]))
      }
    });
    if (!success) {
      this.scheduleHomebrewBatchFailureClear(failedIDs);
    }
    let cleanupNotice: string | undefined;
    if (completedIDs.length > 0) {
      const occurredAt = new Date().toISOString();
      await this.recordProfileStatsEvents(
        itemsWithEvents
          .filter(({ item }) => completedIDs.includes(item.id))
          .map(
            ({ entry, item }) =>
              entry.profileStatsEvent ?? homebrewUpdateProfileStatsEvent({ item, occurredAt })
          )
      );
      cleanupNotice = await this.runPostSuccessHomebrewCleanup();
      this.patch({
        homebrewUpdatedPendingRefreshItemIDs: [
          ...new Set([...this.state.homebrewUpdatedPendingRefreshItemIDs, ...completedIDs])
        ],
        homebrewBatchProgressByItemID: {
          ...this.state.homebrewBatchProgressByItemID,
          ...Object.fromEntries(completedIDs.map((id) => [id, 1]))
        }
      });
      await this.holdSuccessfulUpdate();
    }
    await this.refresh(false, { allowHomebrewInventoryDuringActiveCommand: true });
    this.applyHomebrewCleanupNotice(cleanupNotice);
  }

  async performHomebrewUpdateAll(itemIDs?: string[]): Promise<void> {
    const affected = this.homebrewBatchUpdateItems(itemIDs);
    if (affected.length === 0) {
      return;
    }

    if (this.isHomebrewCommandActive() || this.homebrewUpdateQueue.length > 0) {
      this.queueHomebrewBatchUpdates(affected);
      return;
    }

    const releaseHomebrewCommandLock = this.reserveHomebrewCommandLock();
    if (!releaseHomebrewCommandLock) {
      this.queueHomebrewBatchUpdates(affected);
      return;
    }

    try {
      const formulaTokens = affected
        .filter((item) => item.kind === "formula")
        .map((item) => item.token);
      const caskTokens = affected.filter((item) => item.kind === "cask").map((item) => item.token);
      const affectedIDs = affected.map((item) => item.id);
      const affectedByToken = new Map<string, string[]>();
      for (const item of affected) {
        affectedByToken.set(item.token.toLowerCase(), [
          ...(affectedByToken.get(item.token.toLowerCase()) ?? []),
          item.id
        ]);
      }
      const affectedKindByID = new Map(affected.map((item) => [item.id, item.kind]));

      this.patch({
        isRunningHomebrewMaintenance: true,
        homebrewUpdatingItemIDs: [
          ...new Set([...this.state.homebrewUpdatingItemIDs, ...affectedIDs])
        ],
        homebrewBatchProgressByItemID: {
          ...this.state.homebrewBatchProgressByItemID,
          ...Object.fromEntries(
            affectedIDs.map((id) => [id, HomebrewMaintenanceProgressStage.queued])
          )
        },
        homebrewBatchFailedItemIDs: this.state.homebrewBatchFailedItemIDs.filter(
          (id) => !affectedIDs.includes(id)
        ),
        refreshErrorMessage: undefined
      });
      for (const id of affectedIDs) {
        this.clearHomebrewBatchFailureTimer(id);
      }

      const parser = new HomebrewMaintenanceOutputParser(
        affected.map((item) => item.token.toLowerCase())
      );
      const sequence = [
        ["update"],
        ...(formulaTokens.length > 0 ? [["upgrade", ...formulaTokens]] : []),
        ...(caskTokens.length > 0 ? [["upgrade", "--cask", "--greedy", ...caskTokens]] : []),
        ["autoremove"]
      ];
      const completedItemIDs = new Set<string>();
      let success = true;
      for (const command of sequence) {
        const result = await this.runBrewWithEvents(command, (event) => {
          this.applyHomebrewProgressEvent(
            event,
            parser,
            affectedByToken,
            affectedKindByID,
            completedItemIDs
          );
        });
        if (result) {
          const upgradedKind = homebrewUpgradeKindForCommand(command);
          if (upgradedKind) {
            for (const item of affected.filter((candidate) => candidate.kind === upgradedKind)) {
              completedItemIDs.add(item.id);
            }
          }
        }
        if (!result) {
          success = false;
          break;
        }
      }
      const completedIDs = success
        ? affectedIDs
        : affectedIDs.filter((id) => completedItemIDs.has(id));
      const failedIDs = affectedIDs.filter((id) => !completedItemIDs.has(id));
      let cleanupNotice: string | undefined;

      if (success) {
        this.patch({
          homebrewBatchProgressByItemID: {
            ...this.state.homebrewBatchProgressByItemID,
            ...Object.fromEntries(
              completedIDs.map((id) => [id, HomebrewMaintenanceProgressStage.finalizing])
            )
          }
        });
        cleanupNotice = await this.runPostSuccessHomebrewCleanup();
      }

      this.patch({
        isRunningHomebrewMaintenance: false,
        homebrewUpdatingItemIDs: this.state.homebrewUpdatingItemIDs.filter(
          (id) => !affectedIDs.includes(id)
        ),
        homebrewBatchFailedItemIDs: success
          ? this.state.homebrewBatchFailedItemIDs.filter((id) => !affectedIDs.includes(id))
          : [
              ...new Set([
                ...this.state.homebrewBatchFailedItemIDs,
                ...failedIDs.filter(
                  (id) => !this.state.homebrewUpdatedPendingRefreshItemIDs.includes(id)
                )
              ])
            ],
        homebrewUpdatedPendingRefreshItemIDs:
          completedIDs.length > 0
            ? [...new Set([...this.state.homebrewUpdatedPendingRefreshItemIDs, ...completedIDs])]
            : this.state.homebrewUpdatedPendingRefreshItemIDs,
        refreshErrorMessage: success ? undefined : "Homebrew maintenance cycle failed."
      });
      if (!success) {
        this.scheduleHomebrewBatchFailureClear(failedIDs);
      }
      if (completedIDs.length > 0) {
        const occurredAt = new Date().toISOString();
        await this.recordProfileStatsEvents(
          affected
            .filter((item) => completedIDs.includes(item.id))
            .map((item) => homebrewUpdateProfileStatsEvent({ item, occurredAt }))
        );
      }
      if (success) {
        await this.holdSuccessfulUpdate();
      }
      await this.refresh(false, { allowHomebrewInventoryDuringActiveCommand: true });
      this.applyHomebrewCleanupNotice(cleanupNotice);
    } finally {
      releaseHomebrewCommandLock();
    }
  }

  private homebrewBatchUpdateItems(itemIDs?: string[]): HomebrewManagedItem[] {
    const requestedItemIDs = itemIDs ? new Set(itemIDs) : undefined;
    const updatesByAppID = new Map(this.state.updates.map((update) => [update.appID, update]));
    const appsRepresentedOutsideHomebrew = this.state.apps.filter(
      (app) => updatesByAppID.has(app.id) || this.state.ignoredIDs.includes(app.id)
    );
    const ignoredApps = this.state.apps.filter((app) => this.state.ignoredIDs.includes(app.id));
    return this.state.homebrewItems.filter(
      (item) =>
        (!requestedItemIDs || requestedItemIDs.has(item.id)) &&
        item.isOutdated &&
        !this.state.ignoredHomebrewItemIDs.includes(item.id) &&
        !this.state.homebrewUpdatedPendingRefreshItemIDs.includes(item.id) &&
        isValidHomebrewToken(item.token) &&
        !homebrewItemHasAppRepresentation(
          item,
          requestedItemIDs ? ignoredApps : appsRepresentedOutsideHomebrew
        )
    );
  }

  private queueHomebrewBatchUpdates(items: HomebrewManagedItem[]): void {
    for (const item of items) {
      const queuedUpdate = this.queueHomebrewItemUpdate(item, { requireOutdated: true });
      if (queuedUpdate) {
        void queuedUpdate.catch(() => undefined);
      }
    }
  }

  async installHomebrewItem(item: HomebrewCaskDiscoveryItem): Promise<void> {
    if (!isValidHomebrewToken(item.token)) {
      this.patch({ refreshErrorMessage: `Blocked unsafe Homebrew token for ${item.displayName}.` });
      return;
    }
    await this.withHomebrewCommandLock(async () => {
      const itemID = item.id;
      this.clearHomebrewDiscoverFailureTimer(itemID);
      this.patch({
        homebrewDiscoverInstallingItemIDs: addToArray(
          this.state.homebrewDiscoverInstallingItemIDs,
          itemID
        ),
        homebrewDiscoverFailedItemIDs: removeFromArray(
          this.state.homebrewDiscoverFailedItemIDs,
          itemID
        ),
        homebrewDiscoverProgressByItemID: {
          ...this.state.homebrewDiscoverProgressByItemID,
          [itemID]: HomebrewMaintenanceProgressStage.queued
        }
      });
      if (this.hasCheckedHomebrewAvailability && !this.state.isHomebrewInstalled) {
        const brew = await this.runBrewCommand(["--version"]);
        this.hasCheckedHomebrewAvailability = true;
        if (!brew.success) {
          this.patch({
            homebrewDiscoverInstallingItemIDs: removeFromArray(
              this.state.homebrewDiscoverInstallingItemIDs,
              itemID
            ),
            homebrewDiscoverProgressByItemID: removeRecordKey(
              this.state.homebrewDiscoverProgressByItemID,
              itemID
            ),
            refreshErrorMessage:
              "Homebrew is not installed. Install Homebrew to install Discover items."
          });
          return;
        }
        this.patch({ isHomebrewInstalled: true });
      }
      const command =
        item.kind === "cask" ? ["install", "--cask", item.token] : ["install", item.token];
      const parser = new HomebrewMaintenanceOutputParser([item.token.toLowerCase()]);
      const success = await this.runBrewWithEvents(command, (event) => {
        this.applyDiscoverInstallEvent(event, parser, itemID, item.token.toLowerCase());
      });
      this.patch({
        homebrewDiscoverInstallingItemIDs: success
          ? this.state.homebrewDiscoverInstallingItemIDs
          : removeFromArray(this.state.homebrewDiscoverInstallingItemIDs, itemID),
        homebrewDiscoverInstalledPendingRefreshItemIDs:
          this.state.homebrewDiscoverInstalledPendingRefreshItemIDs,
        homebrewDiscoverFailedItemIDs: success
          ? removeFromArray(this.state.homebrewDiscoverFailedItemIDs, itemID)
          : addToArray(this.state.homebrewDiscoverFailedItemIDs, itemID),
        homebrewDiscoverProgressByItemID: success
          ? {
              ...this.state.homebrewDiscoverProgressByItemID,
              [itemID]: HomebrewMaintenanceProgressStage.finalizing
            }
          : this.state.homebrewDiscoverProgressByItemID,
        refreshErrorMessage: success
          ? undefined
          : `Homebrew install failed for ${item.displayName}.`
      });
      if (success) {
        this.hasCheckedHomebrewAvailability = true;
        this.patch({ isHomebrewInstalled: true });
        await this.recordProfileStatsEvents([homebrewInstallProfileStatsEvent(item)]);
        const cleanupNotice = await this.runPostSuccessHomebrewCleanup();
        this.patch({
          homebrewDiscoverInstallingItemIDs: removeFromArray(
            this.state.homebrewDiscoverInstallingItemIDs,
            itemID
          ),
          homebrewDiscoverInstalledPendingRefreshItemIDs: addToArray(
            this.state.homebrewDiscoverInstalledPendingRefreshItemIDs,
            itemID
          ),
          homebrewDiscoverProgressByItemID: {
            ...this.state.homebrewDiscoverProgressByItemID,
            [itemID]: 1
          }
        });
        await this.holdSuccessfulUpdate();
        await this.refresh(false, { allowHomebrewInventoryDuringActiveCommand: true });
        this.applyHomebrewCleanupNotice(cleanupNotice);
      } else {
        this.scheduleHomebrewDiscoverFailureClear(itemID);
      }
    });
  }

  async uninstallHomebrewItem(itemID: string): Promise<void> {
    const item = this.state.homebrewItems.find((candidate) => candidate.id === itemID);
    if (!item || item.kind !== "cask") {
      return;
    }
    if (!isValidHomebrewToken(item.token)) {
      this.patch({ refreshErrorMessage: `Blocked unsafe Homebrew token for ${item.name}.` });
      return;
    }
    const releaseHomebrewCommandLock = this.reserveHomebrewCommandLock();
    if (!releaseHomebrewCommandLock) {
      return;
    }
    this.patch({
      homebrewUninstallingItemIDs: addToArray(this.state.homebrewUninstallingItemIDs, itemID)
    });
    try {
      const outputLines: string[] = [];
      const result = await this.runBrewWithResultEvents(
        ["uninstall", "--cask", item.token],
        (event) => {
          if (event.type === "outputLine") {
            outputLines.push(event.line);
          }
        }
      );
      this.patch({
        homebrewUninstallingItemIDs: removeFromArray(this.state.homebrewUninstallingItemIDs, itemID)
      });
      await this.refresh(false, { allowHomebrewInventoryDuringActiveCommand: true });
      if (!result.success) {
        const output = (outputLines.join("\n") || result.output).trim();
        this.patch({
          refreshErrorMessage: homebrewUninstallFailureMessage(item, output)
        });
      }
    } finally {
      if (this.state.homebrewUninstallingItemIDs.includes(itemID)) {
        this.patch({
          homebrewUninstallingItemIDs: removeFromArray(
            this.state.homebrewUninstallingItemIDs,
            itemID
          )
        });
      }
      releaseHomebrewCommandLock();
    }
  }

  private async processHomebrewUpdateQueue(): Promise<void> {
    if (this.isProcessingHomebrewUpdateQueue) {
      return;
    }
    this.isProcessingHomebrewUpdateQueue = true;
    try {
      while (this.homebrewUpdateQueue.length > 0) {
        const releaseHomebrewCommandLock = this.reserveHomebrewCommandLock();
        if (!releaseHomebrewCommandLock) {
          return;
        }
        const entries = this.homebrewUpdateQueue.splice(0);
        if (entries.length === 0) {
          releaseHomebrewCommandLock();
          continue;
        }
        const entryIDs = entries.map((entry) => entry.item.id);
        this.patch({
          homebrewQueuedItemIDs: this.state.homebrewQueuedItemIDs.filter(
            (itemID) => !entryIDs.includes(itemID)
          )
        });
        try {
          await this.runHomebrewQueuedUpdates(entries);
          for (const entry of entries) {
            entry.resolve();
          }
        } catch (error) {
          for (const entry of entries) {
            entry.reject(error);
          }
        } finally {
          const updatingItemIDs = this.state.homebrewUpdatingItemIDs.filter(
            (itemID) => !entryIDs.includes(itemID)
          );
          const queuedItemIDs = this.state.homebrewQueuedItemIDs.filter(
            (itemID) => !entryIDs.includes(itemID)
          );
          if (
            updatingItemIDs.length !== this.state.homebrewUpdatingItemIDs.length ||
            queuedItemIDs.length !== this.state.homebrewQueuedItemIDs.length
          ) {
            this.patch({
              homebrewUpdatingItemIDs: updatingItemIDs,
              homebrewQueuedItemIDs: queuedItemIDs
            });
          }
          releaseHomebrewCommandLock();
        }
      }
    } finally {
      this.isProcessingHomebrewUpdateQueue = false;
      if (this.homebrewUpdateQueue.length > 0 && !this.isHomebrewCommandActive()) {
        void this.processHomebrewUpdateQueue();
      }
    }
  }

  private async withHomebrewCommandLock(operation: () => Promise<void>): Promise<void> {
    const releaseHomebrewCommandLock = this.reserveHomebrewCommandLock();
    if (!releaseHomebrewCommandLock) {
      return;
    }
    try {
      await operation();
    } finally {
      releaseHomebrewCommandLock();
    }
  }

  private reserveHomebrewCommandLock(): (() => void) | undefined {
    if (this.isHomebrewCommandActive()) {
      return undefined;
    }
    let released = false;
    this.activeHomebrewCommandCount += 1;
    this.updateHomebrewCommandLockState();
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeHomebrewCommandCount = Math.max(0, this.activeHomebrewCommandCount - 1);
      this.updateHomebrewCommandLockState();
      void this.processHomebrewUpdateQueue();
    };
  }

  private async computeRefresh(
    lightweight: boolean,
    sequence: number,
    options: RefreshOptions
  ): Promise<void> {
    this.patch({
      isRefreshing: true,
      refreshErrorMessage: undefined,
      lastRefreshNoticeMessage: undefined
    });
    const now = new Date().toISOString();
    let completedHomebrewInventory: HomebrewInventoryResult | undefined;
    try {
      const [apps, homebrewIndex, homebrewFormulaIndex, homebrewInventory, selfUpdate] =
        await Promise.all([
          this.scanner.scanApplications(this.scanDirectories()),
          this.homebrew.fetchIndex(),
          this.homebrewFormula.fetchIndex(),
          this.fetchHomebrewInventory(lightweight, options),
          this.lookupSelfUpdate(now)
        ]);
      completedHomebrewInventory = homebrewInventory;
      const homebrewItems = homebrewInventory.items;
      if (sequence !== this.refreshSequence) {
        return;
      }
      this.latestHomebrewIndex = homebrewIndex;
      this.latestHomebrewFormulaIndex = homebrewFormulaIndex;
      const previousUpdates = new Map(this.state.updates.map((update) => [update.appID, update]));
      const updates: UpdateRecord[] = [];

      for (const appRecord of apps) {
        if (appRecord.bundleIdentifier) {
          const outcome = await this.appStore.lookupOutcome(
            appRecord.bundleIdentifier,
            appRecord.localVersion,
            {
              includeIOSAppStoreSoftware:
                appRecord.isIOSAppOnMac === true && appRecord.hasAppStoreEvidence === true,
              includeMacCapableAppStoreSoftware:
                appRecord.isIOSAppOnMac !== true && appRecord.hasSafariWebExtension === true
            }
          );
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
              checkedAt: now
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
            appRecord.bundleVersion
          );
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
              updateURL: outcome.value.updateURL,
              releaseNotesURL: outcome.value.releaseNotesURL,
              releaseDate: outcome.value.releaseDate,
              checkedAt: now
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
          previousHomebrewItems,
          homebrewInventory.outdatedDetectionSucceededByKind
        ),
        updates,
        apps,
        homebrewIndex,
        previousHomebrewItems
      );
      const recentlyUpdated = this.mergeRecentlyUpdated(apps, updates, previousUpdates, now);
      const homebrewRecentlyUpdated = mergeHomebrewRecentlyUpdatedRecords(
        this.state.homebrewRecentlyUpdated,
        previousHomebrewItems,
        reconciledHomebrewItems,
        now
      );
      const preserveHomebrewCommandState =
        this.isHomebrewCommandActive() && !options.allowHomebrewInventoryDuringActiveCommand;
      this.patch({
        apps,
        updates,
        homebrewItems: reconciledHomebrewItems,
        recentlyUpdated,
        homebrewRecentlyUpdated,
        lastRefreshDate: now,
        isRefreshing: false,
        lastRefreshNoticeMessage: homebrewInventory.warning,
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
      await this.persist();
      void this.processHomebrewUpdateQueue();
    } catch (error) {
      if (sequence !== this.refreshSequence) {
        return;
      }
      const recoveredHomebrewInventory =
        completedHomebrewInventory ??
        (await this.activeHomebrewInventoryTask?.task.catch(() => undefined));
      if (sequence !== this.refreshSequence) {
        return;
      }
      const patch: Partial<BaselineSnapshot> = {
        isRefreshing: false,
        refreshErrorMessage: error instanceof Error ? error.message : "Refresh failed."
      };
      if (recoveredHomebrewInventory) {
        patch.homebrewItems = preservePreviousHomebrewOutdatedState(
          recoveredHomebrewInventory.items,
          this.state.homebrewItems,
          recoveredHomebrewInventory.outdatedDetectionSucceededByKind
        );
        patch.lastRefreshNoticeMessage = recoveredHomebrewInventory.warning;
      }
      this.patch(patch);
      void this.processHomebrewUpdateQueue();
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
    if (this.isHomebrewCommandActive() && !options.allowHomebrewInventoryDuringActiveCommand) {
      return {
        items: this.state.homebrewItems,
        outdatedDetectionSucceeded: false,
        outdatedDetectionSucceededByKind: { formula: false, cask: false }
      };
    }
    this.activeHomebrewInventoryCount += 1;
    this.updateHomebrewCommandLockState();
    const task = this.fetchFreshHomebrewInventory(updateMetadata);
    this.activeHomebrewInventoryTask = { updateMetadata, task };
    try {
      return await task;
    } finally {
      if (this.activeHomebrewInventoryTask?.task === task) {
        this.activeHomebrewInventoryTask = undefined;
      }
      this.activeHomebrewInventoryCount = Math.max(0, this.activeHomebrewInventoryCount - 1);
      this.updateHomebrewCommandLockState();
    }
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

  private async runBrewWithEvents(
    command: string[],
    onEvent: (event: HomebrewMaintenanceRunEvent) => void
  ): Promise<boolean> {
    return (await this.runBrewWithResultEvents(command, onEvent)).success;
  }

  private async runBrewWithResultEvents(
    command: string[],
    onEvent: (event: HomebrewMaintenanceRunEvent) => void
  ): Promise<CommandResult> {
    const started: HomebrewMaintenanceRunEvent = { type: "commandStarted", command };
    this.emit("homebrewCommand", started);
    onEvent(started);
    const result = await this.runBrewCommand(command, (line) => {
      const event: HomebrewMaintenanceRunEvent = { type: "outputLine", command, line };
      this.emit("homebrewCommand", event);
      onEvent(event);
    });
    if (result.success && !this.state.isHomebrewInstalled) {
      this.hasCheckedHomebrewAvailability = true;
      this.patch({ isHomebrewInstalled: true });
    }
    const finished: HomebrewMaintenanceRunEvent = {
      type: "commandFinished",
      command,
      success: result.success
    };
    this.emit("homebrewCommand", finished);
    onEvent(finished);
    return result;
  }

  private async runPostSuccessHomebrewCleanup(): Promise<string | undefined> {
    const result = await this.runBrewWithResultEvents(["cleanup"], () => undefined);
    return result.success
      ? undefined
      : "Homebrew cleanup did not complete after the Homebrew operation. Old downloads may still be retained.";
  }

  private applyHomebrewCleanupNotice(message: string | undefined): void {
    if (!message) {
      return;
    }
    this.patch({
      lastRefreshNoticeMessage: this.state.lastRefreshNoticeMessage
        ? `${this.state.lastRefreshNoticeMessage} ${message}`
        : message
    });
  }

  private applyHomebrewProgressEvent(
    event: HomebrewMaintenanceRunEvent,
    parser: HomebrewMaintenanceOutputParser,
    affectedByToken: Map<string, string[]>,
    affectedKindByID?: Map<string, HomebrewManagedItemKind>,
    completedItemIDs?: Set<string>
  ): void {
    if (event.type === "commandStarted") {
      return;
    }
    if (event.type === "outputLine") {
      for (const parsed of parser.parse(event.line, event.command)) {
        const ids = (affectedByToken.get(parsed.token) ?? []).filter(
          (id) =>
            !parsed.kindHint || !affectedKindByID || affectedKindByID.get(id) === parsed.kindHint
        );
        for (const id of ids) {
          if (parsed.kind.type === "progress") {
            this.patch({
              homebrewBatchProgressByItemID: {
                ...this.state.homebrewBatchProgressByItemID,
                [id]: Math.max(
                  this.state.homebrewBatchProgressByItemID[id] ?? 0,
                  parsed.kind.progress
                )
              }
            });
          } else if (parsed.kind.type === "failed") {
            this.patch({
              homebrewBatchFailedItemIDs: addToArray(this.state.homebrewBatchFailedItemIDs, id)
            });
          } else {
            completedItemIDs?.add(id);
            this.patch({
              homebrewBatchProgressByItemID: {
                ...this.state.homebrewBatchProgressByItemID,
                [id]: 1
              }
            });
          }
        }
      }
    }
  }

  private queuedHomebrewUpdateIsStillCurrent(
    entry: HomebrewUpdateQueueEntry,
    item: HomebrewManagedItem
  ): boolean {
    if (entry.requireOutdated && !item.isOutdated) {
      return false;
    }
    if (
      entry.requiredRemoteVersion &&
      !isVersionGreater(entry.requiredRemoteVersion, item.installedVersion)
    ) {
      return false;
    }
    if (!entry.appUpdateAppID) {
      return true;
    }
    return this.state.updates.some(
      (update) =>
        update.appID === entry.appUpdateAppID &&
        update.source === "homebrew" &&
        update.homebrewToken?.toLowerCase() === item.token.toLowerCase()
    );
  }

  private applyDiscoverInstallEvent(
    event: HomebrewMaintenanceRunEvent,
    parser: HomebrewMaintenanceOutputParser,
    itemID: string,
    token: string
  ): void {
    if (event.type !== "outputLine") {
      return;
    }
    for (const parsed of parser.parse(event.line, event.command)) {
      if (parsed.token !== token || parsed.kind.type !== "progress") {
        continue;
      }
      this.patch({
        homebrewDiscoverProgressByItemID: {
          ...this.state.homebrewDiscoverProgressByItemID,
          [itemID]: Math.max(
            this.state.homebrewDiscoverProgressByItemID[itemID] ?? 0,
            parsed.kind.progress
          )
        }
      });
    }
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
        homebrewCaskItemProvesAppOwnership(item, appRecord, this.latestHomebrewIndex.byToken[token])
    );
  }

  private isHomebrewCommandActive(): boolean {
    return (
      this.activeHomebrewCommandCount > 0 ||
      this.activeHomebrewInventoryCount > 0 ||
      this.state.isRunningHomebrewMaintenance ||
      this.state.homebrewUninstallingItemIDs.length > 0 ||
      this.state.homebrewDiscoverInstallingItemIDs.length > 0
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

  private scheduleHomebrewBatchFailureClear(itemIDs: string[]): void {
    for (const itemID of itemIDs) {
      this.clearHomebrewBatchFailureTimer(itemID);
      const timer = setTimeout(() => {
        this.homebrewBatchFailureClearTimers.delete(itemID);
        if (!this.state.homebrewBatchFailedItemIDs.includes(itemID)) {
          return;
        }
        this.patch({
          homebrewBatchFailedItemIDs: removeFromArray(
            this.state.homebrewBatchFailedItemIDs,
            itemID
          ),
          homebrewBatchProgressByItemID: removeRecordKey(
            this.state.homebrewBatchProgressByItemID,
            itemID
          )
        });
      }, TRANSIENT_HOMEBREW_FAILURE_MS);
      timer.unref?.();
      this.homebrewBatchFailureClearTimers.set(itemID, timer);
    }
  }

  private scheduleHomebrewDiscoverFailureClear(itemID: string): void {
    this.clearHomebrewDiscoverFailureTimer(itemID);
    const timer = setTimeout(() => {
      this.homebrewDiscoverFailureClearTimers.delete(itemID);
      if (!this.state.homebrewDiscoverFailedItemIDs.includes(itemID)) {
        return;
      }
      this.patch({
        homebrewDiscoverFailedItemIDs: removeFromArray(
          this.state.homebrewDiscoverFailedItemIDs,
          itemID
        ),
        homebrewDiscoverProgressByItemID: removeRecordKey(
          this.state.homebrewDiscoverProgressByItemID,
          itemID
        )
      });
    }, TRANSIENT_HOMEBREW_FAILURE_MS);
    timer.unref?.();
    this.homebrewDiscoverFailureClearTimers.set(itemID, timer);
  }

  private clearHomebrewBatchFailureTimer(itemID: string): void {
    const timer = this.homebrewBatchFailureClearTimers.get(itemID);
    if (timer) {
      clearTimeout(timer);
      this.homebrewBatchFailureClearTimers.delete(itemID);
    }
  }

  private clearHomebrewDiscoverFailureTimer(itemID: string): void {
    const timer = this.homebrewDiscoverFailureClearTimers.get(itemID);
    if (timer) {
      clearTimeout(timer);
      this.homebrewDiscoverFailureClearTimers.delete(itemID);
    }
  }

  private async holdSuccessfulUpdate(): Promise<void> {
    if (this.successRefreshDelayMS <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, this.successRefreshDelayMS));
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

  private patch(patch: Partial<BaselineSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.emit("snapshot", this.getSnapshot());
  }

  private updateHomebrewCommandLockState(): void {
    const isHomebrewCommandLocked =
      this.activeHomebrewCommandCount > 0 || this.activeHomebrewInventoryCount > 0;
    if (this.state.isHomebrewCommandLocked === isHomebrewCommandLocked) {
      return;
    }
    this.patch({ isHomebrewCommandLocked });
  }
}

function snapshotForPersistence(snapshot: BaselineSnapshot): PersistedSnapshot {
  return {
    apps: snapshot.apps,
    updates: snapshot.updates,
    recentlyUpdated: snapshot.recentlyUpdated,
    homebrewItems: snapshot.homebrewItems,
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
    profileStats: snapshot.profileStats,
    profileStatsResetAcknowledgedID: snapshot.profileStatsResetAcknowledgedID,
    lastRefreshDate: snapshot.lastRefreshDate
  };
}

function sanitizePersistedSnapshotForRuntime(snapshot: PersistedSnapshot): PersistedSnapshot {
  const updates = snapshot.updates.filter((update) =>
    persistedUpdateHasValidRuntimeRoute(update, snapshot)
  );

  if (updates.length === snapshot.updates.length) {
    return snapshot;
  }

  return {
    ...snapshot,
    updates
  };
}

function persistedUpdateHasValidRuntimeRoute(
  update: UpdateRecord,
  snapshot: PersistedSnapshot
): boolean {
  if (update.source !== "homebrew") {
    return true;
  }

  const token = update.homebrewToken?.toLowerCase();
  if (!token || !isValidHomebrewToken(token)) {
    return false;
  }
  if (!snapshot.apps.some((app) => app.id === update.appID)) {
    return false;
  }

  return snapshot.homebrewItems.some(
    (item) =>
      item.kind === "cask" &&
      item.appID === update.appID &&
      item.token.toLowerCase() === token &&
      isValidHomebrewToken(item.token)
  );
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

function homebrewUpdateProfileStatsEvent({
  item,
  occurredAt
}: {
  item: HomebrewManagedItem;
  occurredAt: string;
}): ProfileStatsEvent {
  return {
    id: ["homebrewUpdate", item.id, item.installedVersion.raw, occurredAt].join(":"),
    type: "homebrewUpdate",
    targetID: item.id,
    displayName: item.name,
    channel: "homebrew",
    occurredAt
  };
}

function homebrewInstallProfileStatsEvent(item: HomebrewCaskDiscoveryItem): ProfileStatsEvent {
  const occurredAt = new Date().toISOString();
  return {
    id: ["homebrewInstall", item.id, item.version.raw, occurredAt].join(":"),
    type: "homebrewInstall",
    targetID: item.id,
    displayName: item.displayName,
    channel: "homebrew",
    occurredAt
  };
}

function homebrewUpgradeKindForCommand(command: string[]): HomebrewManagedItemKind | undefined {
  const normalized = command.map((part) => part.toLowerCase());
  if (normalized[0] !== "upgrade") {
    return undefined;
  }
  return normalized.includes("--cask") || normalized.includes("--casks") ? "cask" : "formula";
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

function removeRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
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

export function preservePreviousHomebrewOutdatedState(
  currentItems: HomebrewManagedItem[],
  previousItems: HomebrewManagedItem[],
  outdatedDetectionSucceededByKind: Record<HomebrewManagedItemKind, boolean>
): HomebrewManagedItem[] {
  if (outdatedDetectionSucceededByKind.formula && outdatedDetectionSucceededByKind.cask) {
    return currentItems;
  }

  const previousByID = new Map(previousItems.map((item) => [item.id, item]));
  return currentItems.map((item) => {
    const previous = previousByID.get(item.id);
    if (outdatedDetectionSucceededByKind[item.kind]) {
      return item;
    }
    if (!previous?.isOutdated) {
      return item;
    }
    if (
      previous.latestVersion &&
      !isVersionGreater(previous.latestVersion, item.installedVersion)
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
      homebrewCaskItemProvesAppOwnership(item, appRecord, caskIndex.byToken[token])
  );
}

function homebrewItemCanRunAppUpdate(item: HomebrewManagedItem, update: UpdateRecord): boolean {
  return item.isOutdated || isVersionGreater(update.remoteVersion, item.installedVersion);
}

function homebrewCaskItemProvesAppOwnership(
  item: HomebrewManagedItem,
  appRecord: AppRecord,
  caskEntry: HomebrewCaskEntry | undefined
): boolean {
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
  previousItems: HomebrewManagedItem[] = []
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
    const caskEntry = caskIndex.byToken[item.token.toLowerCase()];
    const matchingApp = matchingHomebrewApp(updatesByToken, appsByID, apps, item, caskEntry);
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
      !caskEntry && !matchingApp && previousAppID && appsByID.has(previousAppID)
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
  options: { currentDate?: Date } = {}
): HomebrewRecentlyUpdatedRecord[] {
  const records = [...existingRecords];
  const previousByID = new Map(previousItems.map((item) => [item.id, item]));

  for (const currentItem of currentItems) {
    const previousItem = previousByID.get(currentItem.id);
    if (!previousItem) {
      continue;
    }
    if (compareVersions(currentItem.installedVersion, previousItem.installedVersion) <= 0) {
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
  caskEntry: HomebrewCaskEntry | undefined
): AppRecord | undefined {
  const update = updatesByToken.get(item.token.toLowerCase());
  const appFromUpdate = update ? appsByID.get(update.appID) : undefined;
  if (appFromUpdate && appMatchesCaskEntry(appFromUpdate, caskEntry)) {
    return appFromUpdate;
  }

  if (caskEntry) {
    const byCaskMetadata = apps.find((app) => appMatchesCaskEntry(app, caskEntry));
    if (byCaskMetadata) {
      return byCaskMetadata;
    }
  }

  return undefined;
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

function homebrewUninstallFailureMessage(item: HomebrewManagedItem, output: string): string {
  const prefix = `Homebrew uninstall failed for ${item.name}.`;
  return output ? `${prefix}\n\n${output.slice(0, 600)}` : prefix;
}
