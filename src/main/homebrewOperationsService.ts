// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type {
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  HomebrewManagedItemKind,
  ProfileStatsEvent
} from "../shared/domain";
import { homebrewItemID, type HomebrewRuntimeOperation } from "../shared/domain";
import { randomBytes } from "node:crypto";
import {
  HomebrewMaintenanceOutputParser,
  HomebrewMaintenanceProgressStage,
  type HomebrewMaintenanceRunEvent
} from "../shared/homebrewProgress";
import { homebrewItemHasAppRepresentation } from "../shared/homebrewAppLinking";
import { homebrewCommandToken, homebrewItemIdentity } from "../shared/homebrewIdentity";
import { isValidHomebrewToken } from "../shared/security";
import { isVersionGreater, type VersionValue } from "../shared/version";
import {
  runBrewCommand as defaultRunBrewCommand,
  commandWasCancelled,
  type CommandResult
} from "./commandRunner";
import type { OperationFailure } from "../shared/operationFailures";
import {
  homebrewUpdateProfileStatsEvent,
  homebrewInstallProfileStatsEvent
} from "./profileStatsService";

export type HomebrewOperationsState = Pick<
  BaselineSnapshot,
  | "homebrewItems"
  | "homebrewOperation"
  | "updates"
  | "apps"
  | "ignoredIDs"
  | "ignoredHomebrewItemIDs"
  | "homebrewUpdatingItemIDs"
  | "homebrewQueuedItemIDs"
  | "homebrewBatchFailedItemIDs"
  | "homebrewBatchProgressByItemID"
  | "homebrewUpdatedPendingRefreshItemIDs"
  | "homebrewDiscoverInstallingItemIDs"
  | "homebrewDiscoverFailedItemIDs"
  | "homebrewDiscoverProgressByItemID"
  | "homebrewDiscoverInstalledPendingRefreshItemIDs"
  | "homebrewUninstallingItemIDs"
  | "isRunningHomebrewMaintenance"
  | "isHomebrewInstalled"
  | "refreshErrorMessage"
  | "lastRefreshNoticeMessage"
>;

export type HomebrewOperationsPatch = Partial<
  Pick<
    HomebrewOperationsState,
    | "homebrewUpdatingItemIDs"
    | "homebrewOperation"
    | "homebrewQueuedItemIDs"
    | "homebrewBatchFailedItemIDs"
    | "homebrewBatchProgressByItemID"
    | "homebrewUpdatedPendingRefreshItemIDs"
    | "homebrewDiscoverInstallingItemIDs"
    | "homebrewDiscoverFailedItemIDs"
    | "homebrewDiscoverProgressByItemID"
    | "homebrewDiscoverInstalledPendingRefreshItemIDs"
    | "homebrewUninstallingItemIDs"
    | "isRunningHomebrewMaintenance"
    | "isHomebrewInstalled"
    | "refreshErrorMessage"
    | "lastRefreshNoticeMessage"
  >
>;

export type HomebrewOperationsLock = Pick<
  import("./homebrewWorkLock").HomebrewWorkLock<unknown>,
  "isCommandActive" | "reserveCommand"
>;

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

export class HomebrewOperationsService {
  private activeOperation?: HomebrewRuntimeOperation;
  private readonly homebrewBatchFailureClearTimers = new Map<string, NodeJS.Timeout>();
  private readonly homebrewDiscoverFailureClearTimers = new Map<string, NodeJS.Timeout>();
  private disposed = false;
  private readonly homebrewUpdateQueue: HomebrewUpdateQueueEntry[] = [];
  private isProcessingHomebrewUpdateQueue = false;
  private readonly getState: () => HomebrewOperationsState;
  private readonly patch: (patch: HomebrewOperationsPatch) => void;
  private readonly lock: HomebrewOperationsLock;
  private readonly runBrewCommand: typeof defaultRunBrewCommand;
  private readonly emitHomebrewCommand: (event: HomebrewMaintenanceRunEvent) => void;
  private readonly refresh: (allowHomebrewInventoryDuringActiveCommand: boolean) => Promise<void>;
  private readonly recordProfileStatsEvents: (events: ProfileStatsEvent[]) => Promise<void>;
  private readonly clearOperationFailure: (
    entityID: string,
    operation: OperationFailure["operation"]
  ) => void;
  private readonly recordOperationFailure: (
    entityID: string,
    operation: OperationFailure["operation"],
    result: CommandResult
  ) => Promise<string | void>;
  private readonly recordOperationFailures: (
    failures: Array<{
      entityID: string;
      operation: OperationFailure["operation"];
      result: CommandResult;
      reason?: OperationFailure["reason"];
    }>
  ) => Promise<string | void>;
  private readonly hasCheckedHomebrewAvailability: () => boolean;
  private readonly markHomebrewAvailabilityChecked: () => void;
  private readonly requiresInventory: () => boolean;
  private readonly successRefreshDelayMS: number;

  constructor(options: {
    getState: () => HomebrewOperationsState;
    patch: (patch: HomebrewOperationsPatch) => void;
    lock: HomebrewOperationsLock;
    runBrewCommand: typeof defaultRunBrewCommand;
    emitHomebrewCommand: (event: HomebrewMaintenanceRunEvent) => void;
    refresh: (allowHomebrewInventoryDuringActiveCommand: boolean) => Promise<void>;
    recordProfileStatsEvents: (events: ProfileStatsEvent[]) => Promise<void>;
    clearOperationFailure: (entityID: string, operation: OperationFailure["operation"]) => void;
    recordOperationFailure: (
      entityID: string,
      operation: OperationFailure["operation"],
      result: CommandResult
    ) => Promise<string | void>;
    recordOperationFailures: (
      failures: Array<{
        entityID: string;
        operation: OperationFailure["operation"];
        result: CommandResult;
        reason?: OperationFailure["reason"];
      }>
    ) => Promise<string | void>;
    hasCheckedHomebrewAvailability: () => boolean;
    markHomebrewAvailabilityChecked: () => void;
    requiresInventory: () => boolean;
    successRefreshDelayMS?: number;
  }) {
    this.getState = options.getState;
    this.patch = options.patch;
    this.lock = options.lock;
    this.runBrewCommand = options.runBrewCommand;
    this.emitHomebrewCommand = options.emitHomebrewCommand;
    this.refresh = options.refresh;
    this.recordProfileStatsEvents = options.recordProfileStatsEvents;
    this.clearOperationFailure = options.clearOperationFailure;
    this.recordOperationFailure = options.recordOperationFailure;
    this.recordOperationFailures = options.recordOperationFailures;
    this.hasCheckedHomebrewAvailability = options.hasCheckedHomebrewAvailability;
    this.markHomebrewAvailabilityChecked = options.markHomebrewAvailabilityChecked;
    this.requiresInventory = options.requiresInventory;
    this.successRefreshDelayMS = options.successRefreshDelayMS ?? successfulUpdateHoldMs;
  }

  private get state(): HomebrewOperationsState {
    return this.getState();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.homebrewBatchFailureClearTimers.values()) clearTimeout(timer);
    for (const timer of this.homebrewDiscoverFailureClearTimers.values()) clearTimeout(timer);
    this.homebrewBatchFailureClearTimers.clear();
    this.homebrewDiscoverFailureClearTimers.clear();
  }

  async performHomebrewUpdate(itemID: string): Promise<void> {
    const item = this.state.homebrewItems.find((candidate) => candidate.id === itemID);
    if (!item?.isOutdated || item.pinned || item.isSelf || !homebrewCommandToken(item)) {
      return;
    }
    await this.performHomebrewItemUpdate(item, { requireOutdated: true });
  }

  async performHomebrewItemUpdate(
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
    if (this.requiresInventory() || item.pinned || item.isSelf || !homebrewCommandToken(item)) {
      return undefined;
    }
    if (
      this.state.homebrewUpdatingItemIDs.includes(item.id) ||
      this.homebrewUpdateQueue.some((entry) => entry.item.id === item.id)
    ) {
      return undefined;
    }
    this.clearHomebrewBatchFailureTimer(item.id);
    this.clearOperationFailure(item.id, "update");
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
        ? ["upgrade", "--cask", "--greedy", homebrewCommandToken(item)!]
        : ["upgrade", homebrewCommandToken(item)!];
    const progressTokens = homebrewItemProgressTokens(item);
    const parser = new HomebrewMaintenanceOutputParser(progressTokens);
    const commandResult = await this.runBrewWithResultEvents(command, (event) => {
      this.applyHomebrewProgressEvent(
        event,
        parser,
        new Map(progressTokens.map((token) => [token, [itemID]]))
      );
    });
    if (await this.reconcileCancellation(commandResult, [itemID])) return;
    if (commandResult.success) {
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
      await this.refresh(true);
    } else {
      await this.recordOperationFailure(itemID, "update", commandResult);
      this.patch({
        refreshErrorMessage: `Homebrew update failed for ${item.name}.`,
        homebrewBatchFailedItemIDs: addToArray(this.state.homebrewBatchFailedItemIDs, itemID),
        homebrewBatchProgressByItemID: {
          ...this.state.homebrewBatchProgressByItemID,
          [itemID]: 1
        }
      });
      this.scheduleHomebrewBatchFailureClear([itemID]);
      await this.refresh(true);
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
            !itemWithEvent.item.isSelf &&
            homebrewCommandToken(itemWithEvent.item)
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
      .map((item) => homebrewCommandToken(item)!);
    const caskTokens = affected
      .filter((item) => item.kind === "cask")
      .map((item) => homebrewCommandToken(item)!);
    const affectedIDs = affected.map((item) => item.id);
    const affectedByToken = new Map<string, string[]>();
    for (const item of affected) {
      for (const token of homebrewItemProgressTokens(item)) {
        affectedByToken.set(token, [...(affectedByToken.get(token) ?? []), item.id]);
      }
    }
    const affectedKindByID = new Map(affected.map((item) => [item.id, item.kind]));
    const parser = new HomebrewMaintenanceOutputParser(
      affected.flatMap(homebrewItemProgressTokens)
    );
    const sequence = [
      ...(formulaTokens.length > 0 ? [["upgrade", ...formulaTokens]] : []),
      ...(caskTokens.length > 0 ? [["upgrade", "--cask", "--greedy", ...caskTokens]] : [])
    ];
    const completedItemIDs = new Set<string>();
    let success = true;
    let failedResult: CommandResult | undefined;
    let failedCommand: string[] = [];
    for (const command of sequence) {
      const commandResult = await this.runBrewWithResultEvents(command, (event) => {
        this.applyHomebrewProgressEvent(
          event,
          parser,
          affectedByToken,
          affectedKindByID,
          completedItemIDs
        );
      });
      if (
        await this.reconcileCancellation(
          commandResult,
          affectedIDs,
          itemsWithEvents
            .filter(({ item }) => completedItemIDs.has(item.id))
            .map(({ item, entry }) => ({ item, profileStatsEvent: entry.profileStatsEvent }))
        )
      )
        return;
      const result = commandResult.success;
      if (result) {
        const upgradedKind = homebrewUpgradeKindForCommand(command);
        if (upgradedKind) {
          for (const item of affected.filter((candidate) => candidate.kind === upgradedKind)) {
            completedItemIDs.add(item.id);
          }
        }
      }
      if (!result) {
        failedResult = commandResult;
        failedCommand = command;
        success = false;
        break;
      }
    }

    const completedIDs = success
      ? affectedIDs
      : affectedIDs.filter((id) => completedItemIDs.has(id));
    const failedIDs = success ? [] : affectedIDs.filter((id) => !completedItemIDs.has(id));
    if (failedResult) {
      const result = failedResult;
      await this.recordOperationFailures(
        failedIDs.map((id) => {
          const item = affected.find((candidate) => candidate.id === id)!;
          const attempted =
            failedCommand.includes(homebrewCommandToken(item)!) &&
            homebrewUpgradeKindForCommand(failedCommand) === item.kind;
          return {
            entityID: id,
            operation: "update" as const,
            result: attempted ? result : { success: false, status: null, output: "" },
            reason: attempted ? undefined : ("interrupted" as const)
          };
        })
      );
    }

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
    await this.refresh(true);
  }

  async performHomebrewUpdateAll(itemIDs?: string[]): Promise<void> {
    const affected = this.homebrewBatchUpdateItems(itemIDs);
    if (affected.length === 0) {
      return;
    }

    if (this.lock.isCommandActive || this.homebrewUpdateQueue.length > 0) {
      this.queueHomebrewBatchUpdates(affected);
      return;
    }

    const releaseHomebrewCommandLock = this.lock.reserveCommand();
    if (!releaseHomebrewCommandLock) {
      this.queueHomebrewBatchUpdates(affected);
      return;
    }

    try {
      const formulaTokens = affected
        .filter((item) => item.kind === "formula")
        .map((item) => homebrewCommandToken(item)!);
      const caskTokens = affected
        .filter((item) => item.kind === "cask")
        .map((item) => homebrewCommandToken(item)!);
      const affectedIDs = affected.map((item) => item.id);
      const affectedByToken = new Map<string, string[]>();
      for (const item of affected) {
        for (const token of homebrewItemProgressTokens(item)) {
          affectedByToken.set(token, [...(affectedByToken.get(token) ?? []), item.id]);
        }
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
        this.clearOperationFailure(id, "update");
      }
      this.clearOperationFailure("homebrew:maintenance", "update");

      const parser = new HomebrewMaintenanceOutputParser(
        affected.flatMap(homebrewItemProgressTokens)
      );
      const sequence = [
        ["update"],
        ...(formulaTokens.length > 0 ? [["upgrade", ...formulaTokens]] : []),
        ...(caskTokens.length > 0 ? [["upgrade", "--cask", "--greedy", ...caskTokens]] : [])
      ];
      const completedItemIDs = new Set<string>();
      let success = true;
      let failedResult: CommandResult | undefined;
      let failedCommand: string[] = [];
      for (const command of sequence) {
        const commandResult = await this.runBrewWithResultEvents(command, (event) => {
          this.applyHomebrewProgressEvent(
            event,
            parser,
            affectedByToken,
            affectedKindByID,
            completedItemIDs
          );
        });
        if (
          await this.reconcileCancellation(
            commandResult,
            affectedIDs,
            affected.filter((item) => completedItemIDs.has(item.id)).map((item) => ({ item }))
          )
        )
          return;
        const result = commandResult.success;
        if (result) {
          const upgradedKind = homebrewUpgradeKindForCommand(command);
          if (upgradedKind) {
            for (const item of affected.filter((candidate) => candidate.kind === upgradedKind)) {
              completedItemIDs.add(item.id);
            }
          }
        }
        if (!result) {
          failedResult = commandResult;
          failedCommand = command;
          success = false;
          break;
        }
      }
      const completedIDs = success
        ? affectedIDs
        : affectedIDs.filter((id) => completedItemIDs.has(id));
      const failedIDs = affectedIDs.filter((id) => !completedItemIDs.has(id));
      if (failedResult) {
        const result = failedResult;
        await this.recordOperationFailures([
          { entityID: "homebrew:maintenance", operation: "update", result },
          ...failedIDs.map((id) => {
            const item = affected.find((candidate) => candidate.id === id)!;
            const attempted =
              failedCommand.includes(homebrewCommandToken(item)!) &&
              homebrewUpgradeKindForCommand(failedCommand) === item.kind;
            return {
              entityID: id,
              operation: "update" as const,
              result: attempted ? result : { success: false, status: null, output: "" },
              reason: attempted ? undefined : ("interrupted" as const)
            };
          })
        ]);
      }

      if (success) {
        this.patch({
          homebrewBatchProgressByItemID: {
            ...this.state.homebrewBatchProgressByItemID,
            ...Object.fromEntries(
              completedIDs.map((id) => [id, HomebrewMaintenanceProgressStage.finalizing])
            )
          }
        });
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
      await this.refresh(true);
    } finally {
      this.releaseOperation(releaseHomebrewCommandLock);
    }
  }

  private homebrewBatchUpdateItems(itemIDs?: string[]): HomebrewManagedItem[] {
    if (this.requiresInventory()) return [];
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
        !item.pinned &&
        !this.state.ignoredHomebrewItemIDs.includes(item.id) &&
        !this.state.homebrewUpdatedPendingRefreshItemIDs.includes(item.id) &&
        !item.isSelf &&
        Boolean(homebrewCommandToken(item)) &&
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
      try {
        this.clearOperationFailure(itemID, "install");
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
        if (this.hasCheckedHomebrewAvailability() && !this.state.isHomebrewInstalled) {
          const brew = await this.runBrewCommand(["--version"]);
          this.markHomebrewAvailabilityChecked();
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
        const commandResult = await this.runBrewWithResultEvents(command, (event) => {
          this.applyDiscoverInstallEvent(event, parser, itemID, item.token.toLowerCase());
        });
        if (await this.reconcileCancellation(commandResult, [itemID])) return;
        const success = commandResult.success;
        // Carry only this operation's persistence notice, not unrelated old state.
        const failureNotice = success
          ? undefined
          : await this.recordOperationFailure(itemID, "install", commandResult);
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
          this.markHomebrewAvailabilityChecked();
          this.patch({ isHomebrewInstalled: true });
          let statsNotice: string | undefined;
          try {
            await this.recordProfileStatsEvents([homebrewInstallProfileStatsEvent(item)]);
          } catch {
            statsNotice =
              "Homebrew install completed, but local update history could not be saved.";
          }
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
          await this.refresh(true);
          this.applyOperationNotice(statsNotice);
        } else {
          this.scheduleHomebrewDiscoverFailureClear(itemID);
          // A failed or interrupted installation can still have installed
          // dependencies or the target. Reconcile while holding the reservation.
          const installError = `Homebrew install failed for ${item.displayName}.`;
          try {
            await this.refresh(true);
          } finally {
            // Reconciliation owns fresh inventory/cleanup warnings and refresh
            // errors. Retain them alongside the install outcome even if it throws.
            this.patch({
              refreshErrorMessage: [...new Set([installError, this.state.refreshErrorMessage])]
                .filter(Boolean)
                .join(" ")
            });
            if (typeof failureNotice === "string") this.applyOperationNotice(failureNotice);
          }
        }
      } finally {
        if (this.state.homebrewDiscoverInstallingItemIDs.includes(itemID)) {
          this.patch({
            homebrewDiscoverInstallingItemIDs: removeFromArray(
              this.state.homebrewDiscoverInstallingItemIDs,
              itemID
            ),
            homebrewDiscoverProgressByItemID: removeRecordKey(
              this.state.homebrewDiscoverProgressByItemID,
              itemID
            )
          });
        }
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
    if (!homebrewCommandToken(item)) {
      this.patch({
        refreshErrorMessage: `Homebrew identity could not be verified for ${item.name}.`
      });
      return;
    }
    const releaseHomebrewCommandLock = this.lock.reserveCommand();
    if (!releaseHomebrewCommandLock) {
      return;
    }
    this.clearOperationFailure(itemID, "uninstall");
    this.patch({
      homebrewUninstallingItemIDs: addToArray(this.state.homebrewUninstallingItemIDs, itemID)
    });
    try {
      let outputTail = "";
      const result = await this.runBrewWithResultEvents(
        ["uninstall", "--cask", homebrewCommandToken(item)!],
        (event) => {
          if (event.type === "outputLine") {
            outputTail = `${outputTail}\n${event.line}`.slice(-4096);
          }
        }
      );
      if (await this.reconcileCancellation(result, [itemID])) return;
      this.patch({
        homebrewUninstallingItemIDs: removeFromArray(this.state.homebrewUninstallingItemIDs, itemID)
      });
      await this.refresh(true);
      if (!result.success) {
        await this.recordOperationFailure(itemID, "uninstall", result);
        const output = (outputTail || result.output).trim();
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
      this.releaseOperation(releaseHomebrewCommandLock);
    }
  }

  async processHomebrewUpdateQueue(): Promise<void> {
    if (this.isProcessingHomebrewUpdateQueue) {
      return;
    }
    this.isProcessingHomebrewUpdateQueue = true;
    try {
      while (this.homebrewUpdateQueue.length > 0) {
        const releaseHomebrewCommandLock = this.lock.reserveCommand();
        if (!releaseHomebrewCommandLock) {
          return;
        }
        const entries = this.homebrewUpdateQueue.splice(0);
        if (entries.length === 0) {
          this.releaseOperation(releaseHomebrewCommandLock);
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
          this.releaseOperation(releaseHomebrewCommandLock);
        }
      }
    } finally {
      this.isProcessingHomebrewUpdateQueue = false;
      if (this.homebrewUpdateQueue.length > 0 && !this.lock.isCommandActive) {
        void this.processHomebrewUpdateQueue();
      }
    }
  }

  private async withHomebrewCommandLock(operation: () => Promise<void>): Promise<void> {
    const releaseHomebrewCommandLock = this.lock.reserveCommand();
    if (!releaseHomebrewCommandLock) {
      return;
    }
    try {
      await operation();
    } finally {
      this.releaseOperation(releaseHomebrewCommandLock);
    }
  }

  async runBrewWithResultEvents(
    command: string[],
    onEvent: (event: HomebrewMaintenanceRunEvent) => void
  ): Promise<CommandResult> {
    const started: HomebrewMaintenanceRunEvent = { type: "commandStarted", command };
    this.emitHomebrewCommand(started);
    onEvent(started);
    const tracked = ["upgrade", "install", "uninstall"].includes(command[0] ?? "");
    const tokens = new Set(command.slice(1).filter((arg) => !arg.startsWith("-")));
    const kind = command.includes("--cask") ? "cask" : "formula";
    const items = this.state.homebrewItems.filter(
      (item) => item.kind === kind && tokens.has(homebrewCommandToken(item) ?? "")
    );
    const operation: HomebrewRuntimeOperation | undefined = tracked
      ? {
          id: randomBytes(16).toString("hex"),
          itemIDs:
            command[0] === "install"
              ? [...tokens].map((token) => homebrewItemID(kind, token))
              : items.map((item) => item.id),
          appIDs: [...new Set(items.flatMap((item) => (item.appID ? [item.appID] : [])))],
          phase: "running"
        }
      : undefined;
    if (operation) {
      this.activeOperation = operation;
      this.patch({ homebrewOperation: operation });
    }
    const onLine = (line: string) => {
      const event: HomebrewMaintenanceRunEvent = { type: "outputLine", command, line };
      this.emitHomebrewCommand(event);
      onEvent(event);
    };
    let result: CommandResult;
    let acceptingStatus = true;
    try {
      result = operation
        ? await this.runBrewCommand(command, onLine, {
            adminOperation: {
              operationID: operation.id,
              onWaitingChanged: (waitingPromptID) => {
                if (!acceptingStatus || this.activeOperation?.id !== operation.id) return;
                if (waitingPromptID !== undefined && !/^[a-f0-9]{32}$/u.test(waitingPromptID))
                  throw new Error("Invalid admin helper prompt identity.");
                this.patch({
                  homebrewOperation: {
                    ...operation,
                    waitingPromptID,
                    phase: waitingPromptID ? "waiting" : "running"
                  }
                });
              }
            }
          })
        : await this.runBrewCommand(command, onLine);
    } finally {
      acceptingStatus = false;
      if (operation && this.activeOperation?.id === operation.id)
        this.patch({ homebrewOperation: { ...operation, phase: "reconciling" } });
    }
    if (result.success && !this.state.isHomebrewInstalled) {
      this.markHomebrewAvailabilityChecked();
      this.patch({ isHomebrewInstalled: true });
    }
    const finished: HomebrewMaintenanceRunEvent = {
      type: "commandFinished",
      command,
      success: result.success
    };
    this.emitHomebrewCommand(finished);
    onEvent(finished);
    return result;
  }

  private releaseOperation(release: () => void): void {
    try {
      this.finishOperation();
    } finally {
      release();
    }
  }

  private finishOperation(): void {
    if (!this.activeOperation) return;
    this.activeOperation = undefined;
    this.patch({ homebrewOperation: undefined });
  }

  private async reconcileCancellation(
    result: CommandResult,
    itemIDs: string[],
    completedUpdates: { item: HomebrewManagedItem; profileStatsEvent?: ProfileStatsEvent }[] = []
  ): Promise<boolean> {
    if (!commandWasCancelled(result)) return false;
    if (completedUpdates.length > 0) {
      this.patch({
        homebrewUpdatedPendingRefreshItemIDs: [
          ...new Set([
            ...this.state.homebrewUpdatedPendingRefreshItemIDs,
            ...completedUpdates.map(({ item }) => item.id)
          ])
        ]
      });
    }
    const affected = new Set(itemIDs);
    const retain = (ids: string[]) => ids.filter((id) => !affected.has(id));
    const progress = (values: Record<string, number>) =>
      Object.fromEntries(Object.entries(values).filter(([id]) => !affected.has(id)));
    for (const id of itemIDs) {
      this.clearHomebrewBatchFailureTimer(id);
      this.clearHomebrewDiscoverFailureTimer(id);
    }
    this.patch({
      isRunningHomebrewMaintenance: false,
      homebrewUpdatingItemIDs: retain(this.state.homebrewUpdatingItemIDs),
      homebrewQueuedItemIDs: retain(this.state.homebrewQueuedItemIDs),
      homebrewUninstallingItemIDs: retain(this.state.homebrewUninstallingItemIDs),
      homebrewDiscoverInstallingItemIDs: retain(this.state.homebrewDiscoverInstallingItemIDs),
      homebrewBatchFailedItemIDs: retain(this.state.homebrewBatchFailedItemIDs),
      homebrewDiscoverFailedItemIDs: retain(this.state.homebrewDiscoverFailedItemIDs),
      homebrewBatchProgressByItemID: progress(this.state.homebrewBatchProgressByItemID),
      homebrewDiscoverProgressByItemID: progress(this.state.homebrewDiscoverProgressByItemID)
    });
    let completionHistoryFailed = false;
    if (completedUpdates.length > 0) {
      const occurredAt = new Date().toISOString();
      try {
        await this.recordProfileStatsEvents(
          completedUpdates.map(
            ({ item, profileStatsEvent }) =>
              profileStatsEvent ?? homebrewUpdateProfileStatsEvent({ item, occurredAt })
          )
        );
      } catch {
        // History persistence cannot prevent cancellation reconciliation or leave
        // mutation state active after the reservation is released.
        completionHistoryFailed = true;
      }
    }
    // A cancelled command may have made changes. Never imply rollback or emit
    // failure history or infer success for unconfirmed targets. Preserve already
    // confirmed completions; fresh inventory is authoritative for remaining state.
    try {
      await this.refresh(true);
    } finally {
      if (completionHistoryFailed) {
        this.applyOperationNotice("Some completed Homebrew updates could not be saved to history.");
      }
      if (result.failure?.kind === "admin-helper") {
        this.patch({
          refreshErrorMessage: [
            ...new Set(
              [
                this.state.refreshErrorMessage,
                "The administrator password helper failed. Refresh before retrying."
              ].filter(Boolean)
            )
          ].join(" ")
        });
      }
    }
    return true;
  }

  cancelQueuedHomebrewUpdates(): void {
    const entries = this.homebrewUpdateQueue.splice(0);
    const ids = new Set(entries.map((entry) => entry.item.id));
    this.patch({
      homebrewQueuedItemIDs: this.state.homebrewQueuedItemIDs.filter((id) => !ids.has(id)),
      homebrewUpdatingItemIDs: this.state.homebrewUpdatingItemIDs.filter((id) => !ids.has(id)),
      homebrewBatchProgressByItemID: Object.fromEntries(
        Object.entries(this.state.homebrewBatchProgressByItemID).filter(([id]) => !ids.has(id))
      )
    });
    for (const entry of entries) entry.resolve();
  }

  private applyOperationNotice(message: string | undefined): void {
    if (!message || this.state.lastRefreshNoticeMessage === message) {
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
    if (
      this.requiresInventory() ||
      item.pinned ||
      item.isSelf ||
      !homebrewCommandToken(item) ||
      homebrewItemIdentity(item) !== homebrewItemIdentity(entry.item)
    )
      return false;
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

  private scheduleHomebrewBatchFailureClear(itemIDs: string[]): void {
    if (this.disposed) return;
    for (const itemID of itemIDs) {
      this.clearHomebrewBatchFailureTimer(itemID);
      const timer = setTimeout(() => {
        this.homebrewBatchFailureClearTimers.delete(itemID);
        if (this.disposed) return;
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
    if (this.disposed) return;
    this.clearHomebrewDiscoverFailureTimer(itemID);
    const timer = setTimeout(() => {
      this.homebrewDiscoverFailureClearTimers.delete(itemID);
      if (this.disposed) return;
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
}

function homebrewUpgradeKindForCommand(command: string[]): HomebrewManagedItemKind | undefined {
  const normalized = command.map((part) => part.toLowerCase());
  if (normalized[0] !== "upgrade") {
    return undefined;
  }
  return normalized.includes("--cask") || normalized.includes("--casks") ? "cask" : "formula";
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
function homebrewUninstallFailureMessage(item: HomebrewManagedItem, output: string): string {
  const prefix = `Homebrew uninstall failed for ${item.name}.`;
  return output ? `${prefix}\n\n${output.slice(0, 600)}` : prefix;
}
function homebrewItemProgressTokens(item: HomebrewManagedItem): string[] {
  return [
    ...new Set([
      item.token,
      ...(item.kind === "formula" && item.formulaIdentity ? [item.formulaIdentity.name] : [])
    ])
  ].map((token) => token.toLowerCase());
}
