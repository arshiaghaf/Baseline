// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type {
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  HomebrewManagedItemKind,
  ProfileStatsEvent
} from "../shared/domain";
import { homebrewItemHasAppRepresentation } from "../shared/homebrewAppLinking";
import {
  HomebrewMaintenanceOutputParser,
  HomebrewMaintenanceProgressStage,
  type HomebrewMaintenanceRunEvent
} from "../shared/homebrewProgress";
import { homebrewCommandToken, homebrewItemIdentity } from "../shared/homebrewIdentity";
import type { OperationFailure } from "../shared/operationFailures";
import { isValidHomebrewToken } from "../shared/security";
import { isVersionGreater, type VersionValue } from "../shared/version";
import { runBrewCommand as defaultRunBrewCommand, type CommandResult } from "./commandRunner";

type HomebrewUpdateQueueEntry = {
  item: HomebrewManagedItem;
  profileStatsEvent?: ProfileStatsEvent;
  appUpdateAppID?: string;
  requiredRemoteVersion?: VersionValue;
  requireOutdated: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export const TRANSIENT_HOMEBREW_FAILURE_MS = 4000;

export type HomebrewCommandHost = {
  readonly state: BaselineSnapshot;
  patch(patch: Partial<BaselineSnapshot>): void;
  readonly runBrewCommand: typeof defaultRunBrewCommand;
  emitHomebrewCommand(event: HomebrewMaintenanceRunEvent): void;
  recordProfileStatsEvents(events: ProfileStatsEvent[]): Promise<void>;
  recordOperationFailure(
    entityID: string,
    operation: OperationFailure["operation"],
    result: CommandResult,
    reason?: OperationFailure["reason"]
  ): Promise<void>;
  recordOperationFailures(
    failures: Array<{
      entityID: string;
      operation: OperationFailure["operation"];
      result: CommandResult;
      reason?: OperationFailure["reason"];
    }>
  ): Promise<void>;
  clearOperationFailure(entityID: string, operation: OperationFailure["operation"]): void;
  refresh(
    lightweight?: boolean,
    options?: {
      allowHomebrewInventoryDuringActiveCommand?: boolean;
      forceMetadata?: boolean;
    }
  ): Promise<void>;
  applyOperationNotice(message: string | undefined): void;
  readonly activeHomebrewInventoryCount: number;
  readonly homebrewRefreshLockSequence: number | undefined;
  readonly homebrewCleanupRequiresInventory: boolean;
  hasCheckedHomebrewAvailability: boolean;
  readonly refreshTask: Promise<void> | undefined;
  cleanupRefreshTask: Promise<void> | undefined;
  cleanupRefreshRequested: boolean;
  refreshHomebrewCleanupInventory(): Promise<boolean>;
};

// Homebrew upgrade, install, uninstall, and cleanup commands.
// Owns the upgrade queue, the command lock, and the success hold that is
// awaited before that command's follow-up refresh.
export class HomebrewCommandService {
  private readonly homebrewBatchFailureClearTimers = new Map<string, NodeJS.Timeout>();
  private readonly homebrewDiscoverFailureClearTimers = new Map<string, NodeJS.Timeout>();
  private activeHomebrewCommandCount = 0;
  private readonly homebrewUpdateQueue: HomebrewUpdateQueueEntry[] = [];
  private isProcessingHomebrewUpdateQueue = false;

  constructor(
    private readonly host: HomebrewCommandHost,
    private readonly successRefreshDelayMS: number
  ) {}

  get activeCommandCount(): number {
    return this.activeHomebrewCommandCount;
  }

  private get state(): BaselineSnapshot {
    return this.host.state;
  }

  private patch(patch: Partial<BaselineSnapshot>): void {
    this.host.patch(patch);
  }

  private get runBrewCommand(): HomebrewCommandHost["runBrewCommand"] {
    return this.host.runBrewCommand;
  }

  private emitHomebrewCommand(event: HomebrewMaintenanceRunEvent): void {
    this.host.emitHomebrewCommand(event);
  }

  private recordProfileStatsEvents(events: ProfileStatsEvent[]): Promise<void> {
    return this.host.recordProfileStatsEvents(events);
  }

  private recordOperationFailure(
    entityID: string,
    operation: OperationFailure["operation"],
    result: CommandResult,
    reason?: OperationFailure["reason"]
  ): Promise<void> {
    return this.host.recordOperationFailure(entityID, operation, result, reason);
  }

  private recordOperationFailures(
    failures: Array<{
      entityID: string;
      operation: OperationFailure["operation"];
      result: CommandResult;
      reason?: OperationFailure["reason"];
    }>
  ): Promise<void> {
    return this.host.recordOperationFailures(failures);
  }

  private clearOperationFailure(entityID: string, operation: OperationFailure["operation"]): void {
    this.host.clearOperationFailure(entityID, operation);
  }

  private refresh(
    lightweight?: boolean,
    options?: {
      allowHomebrewInventoryDuringActiveCommand?: boolean;
      forceMetadata?: boolean;
    }
  ): Promise<void> {
    return this.host.refresh(lightweight, options);
  }

  private applyOperationNotice(message: string | undefined): void {
    this.host.applyOperationNotice(message);
  }

  private get activeHomebrewInventoryCount(): number {
    return this.host.activeHomebrewInventoryCount;
  }

  private get homebrewRefreshLockSequence(): number | undefined {
    return this.host.homebrewRefreshLockSequence;
  }

  private get homebrewCleanupRequiresInventory(): boolean {
    return this.host.homebrewCleanupRequiresInventory;
  }

  private get hasCheckedHomebrewAvailability(): boolean {
    return this.host.hasCheckedHomebrewAvailability;
  }

  private set hasCheckedHomebrewAvailability(value: boolean) {
    this.host.hasCheckedHomebrewAvailability = value;
  }

  private get refreshTask(): Promise<void> | undefined {
    return this.host.refreshTask;
  }

  private get cleanupRefreshTask(): Promise<void> | undefined {
    return this.host.cleanupRefreshTask;
  }

  private set cleanupRefreshTask(task: Promise<void> | undefined) {
    this.host.cleanupRefreshTask = task;
  }

  private get cleanupRefreshRequested(): boolean {
    return this.host.cleanupRefreshRequested;
  }

  private set cleanupRefreshRequested(value: boolean) {
    this.host.cleanupRefreshRequested = value;
  }

  private refreshHomebrewCleanupInventory(): Promise<boolean> {
    return this.host.refreshHomebrewCleanupInventory();
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
    if (
      this.homebrewCleanupRequiresInventory ||
      item.pinned ||
      item.isSelf ||
      !homebrewCommandToken(item)
    ) {
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
      await this.refresh(false, { allowHomebrewInventoryDuringActiveCommand: true });
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
    await this.refresh(false, { allowHomebrewInventoryDuringActiveCommand: true });
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
      await this.refresh(false, { allowHomebrewInventoryDuringActiveCommand: true });
    } finally {
      releaseHomebrewCommandLock();
    }
  }

  private homebrewBatchUpdateItems(itemIDs?: string[]): HomebrewManagedItem[] {
    if (this.homebrewCleanupRequiresInventory) return [];
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
        const commandResult = await this.runBrewWithResultEvents(command, (event) => {
          this.applyDiscoverInstallEvent(event, parser, itemID, item.token.toLowerCase());
        });
        const success = commandResult.success;
        if (!success) await this.recordOperationFailure(itemID, "install", commandResult);
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
          await this.refresh(false, { allowHomebrewInventoryDuringActiveCommand: true });
          this.applyOperationNotice(statsNotice);
        } else {
          this.scheduleHomebrewDiscoverFailureClear(itemID);
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
    const releaseHomebrewCommandLock = this.reserveHomebrewCommandLock();
    if (!releaseHomebrewCommandLock) {
      return;
    }
    this.clearOperationFailure(itemID, "uninstall");
    this.patch({
      homebrewUninstallingItemIDs: addToArray(this.state.homebrewUninstallingItemIDs, itemID)
    });
    try {
      const outputLines: string[] = [];
      const result = await this.runBrewWithResultEvents(
        ["uninstall", "--cask", homebrewCommandToken(item)!],
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
        await this.recordOperationFailure(itemID, "uninstall", result);
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

  async processHomebrewUpdateQueue(): Promise<void> {
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

  reserveHomebrewCommandLock(
    options: { allowRefreshSupersession?: boolean } = {}
  ): (() => void) | undefined {
    // Cleanup owns a fresh inventory generation and can supersede app-provider
    // waits. It must still exclude every Homebrew mutation and inventory read.
    const busy = options.allowRefreshSupersession
      ? this.isHomebrewMutationActive() || this.activeHomebrewInventoryCount > 0
      : this.isHomebrewCommandActive();
    if (busy) {
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

  private async runBrewWithResultEvents(
    command: string[],
    onEvent: (event: HomebrewMaintenanceRunEvent) => void
  ): Promise<CommandResult> {
    const started: HomebrewMaintenanceRunEvent = { type: "commandStarted", command };
    this.emitHomebrewCommand(started);
    onEvent(started);
    const result = await this.runBrewCommand(command, (line) => {
      const event: HomebrewMaintenanceRunEvent = { type: "outputLine", command, line };
      this.emitHomebrewCommand(event);
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
    this.emitHomebrewCommand(finished);
    onEvent(finished);
    return result;
  }

  async cleanUpHomebrew(confirm: () => Promise<boolean>): Promise<string> {
    if (!this.state.isHomebrewInstalled) return "Homebrew is not available.";
    const release = this.reserveHomebrewCommandLock({ allowRefreshSupersession: true });
    if (!release) return "Homebrew is busy. Try again when the current operation finishes.";
    const refreshWasActive = Boolean(this.refreshTask);
    this.cleanupRefreshRequested = false;
    let finish!: () => void;
    this.cleanupRefreshTask = new Promise<void>((resolve) => {
      finish = resolve;
    });
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
          !(refreshWasActive || this.cleanupRefreshRequested) ||
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
        const result = await this.runBrewWithResultEvents(["cleanup"], () => undefined);
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
      this.cleanupRefreshTask = undefined;
      finish();
      release();
    }
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
      this.homebrewCleanupRequiresInventory ||
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

  private isHomebrewCommandActive(): boolean {
    return (
      this.isHomebrewMutationActive() ||
      this.activeHomebrewInventoryCount > 0 ||
      this.homebrewRefreshLockSequence !== undefined
    );
  }

  isHomebrewMutationActive(): boolean {
    return (
      this.activeHomebrewCommandCount > 0 ||
      this.state.isRunningHomebrewMaintenance ||
      this.state.homebrewUninstallingItemIDs.length > 0 ||
      this.state.homebrewDiscoverInstallingItemIDs.length > 0
    );
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

  async holdSuccessfulUpdate(): Promise<void> {
    if (this.successRefreshDelayMS <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, this.successRefreshDelayMS));
  }

  updateHomebrewCommandLockState(): void {
    const isHomebrewCommandLocked =
      this.activeHomebrewCommandCount > 0 ||
      this.activeHomebrewInventoryCount > 0 ||
      this.homebrewRefreshLockSequence !== undefined;
    const isHomebrewCleanupLocked =
      this.isHomebrewMutationActive() || this.activeHomebrewInventoryCount > 0;
    if (
      this.state.isHomebrewCommandLocked === isHomebrewCommandLocked &&
      this.state.isHomebrewCleanupLocked === isHomebrewCleanupLocked
    ) {
      return;
    }
    this.patch({ isHomebrewCommandLocked, isHomebrewCleanupLocked });
  }
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
