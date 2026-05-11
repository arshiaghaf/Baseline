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
  UpdateRecord
} from "../shared/domain";
import {
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  homebrewDiscoverID,
  homebrewItemID
} from "../shared/domain";
import {
  HomebrewMaintenanceOutputParser,
  HomebrewMaintenanceProgressStage,
  type HomebrewMaintenanceRunEvent
} from "../shared/homebrewProgress";
import type { PreferencePatch } from "../shared/ipc";
import { isAllowedExternalURL, isValidHomebrewToken } from "../shared/security";
import { compareVersions, isVersionEmpty, isVersionGreater } from "../shared/version";
import { AppStoreLookupClient } from "./appStoreLookupClient";
import { BundleScannerClient } from "./bundleScanner";
import {
  runBrewCommand as defaultRunBrewCommand,
  runMasCommand as defaultRunMasCommand,
  type CommandResult
} from "./commandRunner";
import { HomebrewCaskClient } from "./homebrewCaskClient";
import { HomebrewFormulaClient } from "./homebrewFormulaClient";
import { HomebrewInventoryClient } from "./homebrewInventoryClient";
import { SnapshotPersistence } from "./persistence";
import { SparkleAppcastClient } from "./sparkleAppcastClient";

type StoreEvents = {
  snapshot: [BaselineSnapshot];
  homebrewCommand: [HomebrewMaintenanceRunEvent];
};

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
  private readonly runBrewCommand: typeof defaultRunBrewCommand;
  private readonly runMasCommand: typeof defaultRunMasCommand;
  private readonly openExternalURL: (url: string) => Promise<boolean>;
  private readonly openAppBundle: (bundlePath: string) => Promise<void>;
  private refreshTask?: Promise<void>;
  private autoRefreshTimer?: NodeJS.Timeout;
  private latestHomebrewIndex: HomebrewCaskIndex = emptyHomebrewCaskIndex;
  private latestHomebrewFormulaIndex: HomebrewFormulaIndex = emptyHomebrewFormulaIndex;

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
    }>;
    runBrewCommand?: typeof defaultRunBrewCommand;
    runMasCommand?: typeof defaultRunMasCommand;
  }) {
    super();
    this.persistence = options.persistence;
    this.scanner = options.clients?.scanner ?? new BundleScannerClient();
    this.appStore = options.clients?.appStore ?? new AppStoreLookupClient();
    this.sparkle = options.clients?.sparkle ?? new SparkleAppcastClient();
    this.homebrew = options.clients?.homebrew ?? new HomebrewCaskClient();
    this.homebrewFormula = options.clients?.homebrewFormula ?? new HomebrewFormulaClient();
    this.homebrewInventory = options.clients?.homebrewInventory ?? new HomebrewInventoryClient();
    this.runBrewCommand = options.runBrewCommand ?? defaultRunBrewCommand;
    this.runMasCommand = options.runMasCommand ?? defaultRunMasCommand;
    this.openExternalURL = options.openExternalURL;
    this.openAppBundle = options.openAppBundle;
    this.state = {
      ...options.persisted,
      isMasInstalled: false,
      isHomebrewInstalled: false,
      isChecking: false,
      isRefreshing: false,
      searchText: "",
      isRunningHomebrewMaintenance: false,
      appUpdatingIDs: [],
      appUpdatedPendingRefreshIDs: [],
      homebrewUpdatingItemIDs: [],
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
      laggingHomebrewCaskTokens: []
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

  async refresh(lightweight = false): Promise<void> {
    if (this.refreshTask && lightweight) {
      return this.refreshTask;
    }
    this.refreshTask = this.computeRefresh(lightweight);
    return this.refreshTask.finally(() => {
      this.refreshTask = undefined;
    });
  }

  async refreshToolStatus(): Promise<void> {
    this.patch({ isChecking: true });
    const [mas, brew] = await Promise.all([
      this.runMasCommand(["version"]),
      this.runBrewCommand(["--version"])
    ]);
    this.patch({
      isMasInstalled: mas.success,
      isHomebrewInstalled: brew.success,
      isChecking: false
    });
  }

  async testMasSetup(): Promise<void> {
    if (!this.state.isMasInstalled) {
      this.patch({
        masTestSucceeded: false,
        masTestMessage: "mas is not installed yet. Install mas to start App Store updates."
      });
      return;
    }
    const result = await this.runMasCommand(["outdated"]);
    this.patch({
      masTestSucceeded: result.success,
      masTestMessage: result.success
        ? "mas is ready, and Baseline can start App Store updates."
        : "mas is installed, but it is not connected to your App Store account yet."
    });
  }

  async installMasWithHomebrew(): Promise<void> {
    const result = await this.runBrewCommand(["install", "mas"]);
    const installed = await this.runMasCommand(["version"]);
    this.patch({
      isMasInstalled: installed.success,
      masTestSucceeded: result.success && installed.success,
      masTestMessage:
        result.success && installed.success
          ? "mas was installed successfully."
          : "We could not install mas automatically. Please use the install guide and try again."
    });
  }

  async setSearchText(searchText: string): Promise<void> {
    this.patch({ searchText });
    await this.refreshHomebrewDiscoverItems();
  }

  async setSelectedTab(selectedTab: MenuTab): Promise<void> {
    await this.updatePreferences({ selectedTab });
  }

  async updatePreferences(patch: PreferencePatch): Promise<void> {
    const refreshIntervalMinutes =
      patch.refreshIntervalMinutes === undefined
        ? this.state.refreshIntervalMinutes
        : Math.min(Math.max(Math.trunc(patch.refreshIntervalMinutes), 5), 1440);
    this.patch({ ...patch, refreshIntervalMinutes });
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

  async addDirectory(directory: string): Promise<void> {
    const resolved = path.resolve(directory);
    const directories = [...new Set([...this.state.additionalDirectories, resolved])];
    this.patch({ additionalDirectories: directories });
    await this.persist();
  }

  async removeDirectory(directory: string): Promise<void> {
    const resolved = path.resolve(directory);
    this.patch({
      additionalDirectories: this.state.additionalDirectories.filter(
        (candidate) => path.resolve(candidate) !== resolved
      )
    });
    await this.persist();
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
          await this.refresh();
        } else {
          await this.routeExternalUpdate(appRecord, update);
        }
      });
      return;
    }

    if (update.source === "homebrew" && update.homebrewToken) {
      const item = this.matchingHomebrewItemForApp(appRecord);
      if (item?.isOutdated) {
        await this.performHomebrewUpdate(item.id);
        return;
      }
      await this.runHomebrewAppFallback(appRecord, update.homebrewToken);
      return;
    }

    await this.routeExternalUpdate(appRecord, update);
  }

  async performHomebrewUpdate(itemID: string): Promise<void> {
    const item = this.state.homebrewItems.find((candidate) => candidate.id === itemID);
    if (!item?.isOutdated || !isValidHomebrewToken(item.token)) {
      return;
    }

    const command =
      item.kind === "cask" ? ["upgrade", "--cask", item.token] : ["upgrade", item.token];
    await this.withHomebrewUpdating(itemID, async () => {
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
          homebrewBatchFailedItemIDs: removeFromArray(
            this.state.homebrewBatchFailedItemIDs,
            itemID
          ),
          homebrewUpdatedPendingRefreshItemIDs: addToArray(
            this.state.homebrewUpdatedPendingRefreshItemIDs,
            itemID
          ),
          homebrewBatchProgressByItemID: {
            ...this.state.homebrewBatchProgressByItemID,
            [itemID]: 1
          }
        });
      } else {
        this.patch({
          refreshErrorMessage: `Homebrew update failed for ${item.name}.`,
          homebrewBatchFailedItemIDs: addToArray(this.state.homebrewBatchFailedItemIDs, itemID),
          homebrewBatchProgressByItemID: {
            ...this.state.homebrewBatchProgressByItemID,
            [itemID]: 1
          }
        });
      }
      await this.refresh();
    });
  }

  async performHomebrewUpdateAll(): Promise<void> {
    if (this.state.isRunningHomebrewMaintenance) {
      return;
    }

    const affected = this.state.homebrewItems.filter(
      (item) => item.isOutdated && !this.state.ignoredHomebrewItemIDs.includes(item.id)
    );
    const affectedIDs = affected.map((item) => item.id);
    const affectedByToken = new Map<string, string[]>();
    for (const item of affected) {
      affectedByToken.set(item.token.toLowerCase(), [
        ...(affectedByToken.get(item.token.toLowerCase()) ?? []),
        item.id
      ]);
    }

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
      refreshErrorMessage: undefined
    });

    const parser = new HomebrewMaintenanceOutputParser(
      affected.map((item) => item.token.toLowerCase())
    );
    const sequence = [
      ["update"],
      ["upgrade"],
      ["upgrade", "--cask", "--greedy"],
      ["autoremove"],
      ["cleanup"]
    ];
    let success = true;
    for (const command of sequence) {
      const result = await this.runBrewWithEvents(command, (event) => {
        this.applyHomebrewProgressEvent(event, parser, affectedByToken);
      });
      if (!result) {
        success = false;
        break;
      }
    }

    this.patch({
      isRunningHomebrewMaintenance: false,
      homebrewUpdatingItemIDs: this.state.homebrewUpdatingItemIDs.filter(
        (id) => !affectedIDs.includes(id)
      ),
      homebrewBatchFailedItemIDs: success
        ? this.state.homebrewBatchFailedItemIDs.filter((id) => !affectedIDs.includes(id))
        : this.state.homebrewBatchFailedItemIDs,
      homebrewUpdatedPendingRefreshItemIDs: success
        ? [...new Set([...this.state.homebrewUpdatedPendingRefreshItemIDs, ...affectedIDs])]
        : this.state.homebrewUpdatedPendingRefreshItemIDs,
      refreshErrorMessage: success ? undefined : "Homebrew maintenance cycle failed."
    });
    await this.refresh();
  }

  async installHomebrewItem(item: HomebrewCaskDiscoveryItem): Promise<void> {
    if (!isValidHomebrewToken(item.token)) {
      this.patch({ refreshErrorMessage: `Blocked unsafe Homebrew token for ${item.displayName}.` });
      return;
    }
    const itemID = item.id;
    const command =
      item.kind === "cask" ? ["install", "--cask", item.token] : ["install", item.token];
    this.patch({
      homebrewDiscoverInstallingItemIDs: addToArray(
        this.state.homebrewDiscoverInstallingItemIDs,
        itemID
      ),
      homebrewDiscoverProgressByItemID: {
        ...this.state.homebrewDiscoverProgressByItemID,
        [itemID]: HomebrewMaintenanceProgressStage.queued
      }
    });
    const parser = new HomebrewMaintenanceOutputParser([item.token.toLowerCase()]);
    const success = await this.runBrewWithEvents(command, (event) => {
      this.applyDiscoverInstallEvent(event, parser, itemID, item.token.toLowerCase());
    });
    this.patch({
      homebrewDiscoverInstallingItemIDs: removeFromArray(
        this.state.homebrewDiscoverInstallingItemIDs,
        itemID
      ),
      homebrewDiscoverInstalledPendingRefreshItemIDs: success
        ? addToArray(this.state.homebrewDiscoverInstalledPendingRefreshItemIDs, itemID)
        : this.state.homebrewDiscoverInstalledPendingRefreshItemIDs,
      homebrewDiscoverFailedItemIDs: success
        ? removeFromArray(this.state.homebrewDiscoverFailedItemIDs, itemID)
        : addToArray(this.state.homebrewDiscoverFailedItemIDs, itemID),
      refreshErrorMessage: success ? undefined : `Homebrew install failed for ${item.displayName}.`
    });
    if (success) {
      await this.refresh();
    }
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
    if (
      this.state.isRunningHomebrewMaintenance ||
      this.state.homebrewUninstallingItemIDs.includes(itemID) ||
      this.state.homebrewUpdatingItemIDs.includes(itemID)
    ) {
      return;
    }
    this.patch({
      homebrewUninstallingItemIDs: addToArray(this.state.homebrewUninstallingItemIDs, itemID)
    });
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
    await this.refresh();
    if (!result.success) {
      const output = (outputLines.join("\n") || result.output).trim();
      this.patch({
        refreshErrorMessage: homebrewUninstallFailureMessage(item, output)
      });
    }
  }

  private async computeRefresh(lightweight: boolean): Promise<void> {
    this.patch({
      isRefreshing: true,
      refreshErrorMessage: undefined,
      lastRefreshNoticeMessage: undefined
    });
    const now = new Date().toISOString();
    try {
      const [apps, homebrewIndex, homebrewFormulaIndex, homebrewInventory] = await Promise.all([
        this.scanner.scanApplications(this.scanDirectories()),
        this.homebrew.fetchIndex(),
        this.homebrewFormula.fetchIndex(),
        this.homebrewInventory.fetchInventory({ updateMetadata: !lightweight })
      ]);
      const homebrewItems = homebrewInventory.items;
      this.latestHomebrewIndex = homebrewIndex;
      this.latestHomebrewFormulaIndex = homebrewFormulaIndex;
      const updates: UpdateRecord[] = [];

      for (const appRecord of apps) {
        if (appRecord.bundleIdentifier) {
          const outcome = await this.appStore.lookupOutcome(
            appRecord.bundleIdentifier,
            appRecord.localVersion
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
        }

        if (appRecord.sparkleFeedURL) {
          const outcome = await this.sparkle.lookupOutcome(
            appRecord.sparkleFeedURL,
            appRecord.localVersion
          );
          if (outcome.type === "completed" && outcome.value) {
            updates.push({
              id: appRecord.id,
              appID: appRecord.id,
              source: "sparkle",
              supportLevel: "limited",
              localVersion: appRecord.localVersion,
              remoteVersion: outcome.value.remoteVersion,
              updateURL: outcome.value.updateURL,
              releaseNotesURL: outcome.value.releaseNotesURL,
              releaseDate: outcome.value.releaseDate,
              checkedAt: now
            });
            continue;
          }
        }

        const homebrewUpdate = this.homebrew.lookupUpdate(
          appRecord.bundleIdentifier,
          path.basename(appRecord.bundlePath),
          appRecord.localVersion,
          homebrewIndex
        );
        if (homebrewUpdate && isValidHomebrewToken(homebrewUpdate.token)) {
          updates.push({
            id: appRecord.id,
            appID: appRecord.id,
            source: "homebrew",
            supportLevel: "limited",
            localVersion: appRecord.localVersion,
            remoteVersion: homebrewUpdate.remoteVersion,
            homebrewToken: homebrewUpdate.token,
            releaseNotesSummary: `Token: ${homebrewUpdate.token}`,
            checkedAt: now
          });
        }
      }

      const previousUpdates = new Map(this.state.updates.map((update) => [update.appID, update]));
      const previousHomebrewItems = this.state.homebrewItems;
      const reconciledHomebrewItems = reconcileHomebrewInventory(
        preservePreviousHomebrewOutdatedState(
          homebrewItems,
          previousHomebrewItems,
          homebrewInventory.outdatedDetectionSucceededByKind
        ),
        updates,
        apps,
        homebrewIndex
      );
      const recentlyUpdated = this.mergeRecentlyUpdated(apps, updates, previousUpdates, now);
      const homebrewRecentlyUpdated = mergeHomebrewRecentlyUpdatedRecords(
        this.state.homebrewRecentlyUpdated,
        previousHomebrewItems,
        reconciledHomebrewItems,
        now
      );
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
        homebrewUpdatedPendingRefreshItemIDs: [],
        homebrewDiscoverInstallingItemIDs: [],
        homebrewDiscoverInstalledPendingRefreshItemIDs: [],
        homebrewDiscoverProgressByItemID: {},
        laggingHomebrewCaskTokens: detectLaggingHomebrewCaskTokens(
          homebrewItems,
          updates,
          apps,
          homebrewIndex
        )
      });
      await this.refreshHomebrewDiscoverItems();
      await this.persist();
    } catch (error) {
      this.patch({
        isRefreshing: false,
        refreshErrorMessage: error instanceof Error ? error.message : "Refresh failed."
      });
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

  private scanDirectories(): string[] {
    return [
      ...new Set([
        "/Applications",
        path.join(os.homedir(), "Applications"),
        ...this.state.additionalDirectories
      ])
    ];
  }

  private async routeExternalUpdate(appRecord: AppRecord, update: UpdateRecord): Promise<void> {
    if (update.updateURL && (await this.openExternal(update.updateURL))) {
      return;
    }
    await this.openAppBundle(appRecord.bundlePath);
  }

  private async runHomebrewAppFallback(appRecord: AppRecord, token: string): Promise<void> {
    if (!isValidHomebrewToken(token)) {
      this.patch({
        refreshErrorMessage: `Blocked unsafe Homebrew token for ${appRecord.displayName}.`
      });
      return;
    }
    await this.withAppUpdating(appRecord.id, async () => {
      const parser = new HomebrewMaintenanceOutputParser([token.toLowerCase()]);
      const success = await this.runBrewWithEvents(["upgrade", "--cask", token], (event) => {
        this.applyHomebrewFallbackEvent(event, parser, appRecord.id, token.toLowerCase());
      });
      this.patch({
        appUpdatedPendingRefreshIDs: success
          ? addToArray(this.state.appUpdatedPendingRefreshIDs, appRecord.id)
          : this.state.appUpdatedPendingRefreshIDs,
        homebrewFallbackFailedAppIDs: success
          ? removeFromArray(this.state.homebrewFallbackFailedAppIDs, appRecord.id)
          : addToArray(this.state.homebrewFallbackFailedAppIDs, appRecord.id),
        refreshErrorMessage: success
          ? undefined
          : `Homebrew update failed for ${appRecord.displayName}.`
      });
      await this.refresh();
    });
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
    const finished: HomebrewMaintenanceRunEvent = {
      type: "commandFinished",
      command,
      success: result.success
    };
    this.emit("homebrewCommand", finished);
    onEvent(finished);
    return result;
  }

  private applyHomebrewProgressEvent(
    event: HomebrewMaintenanceRunEvent,
    parser: HomebrewMaintenanceOutputParser,
    affectedByToken: Map<string, string[]>
  ): void {
    if (event.type === "commandStarted") {
      return;
    }
    if (event.type === "outputLine") {
      for (const parsed of parser.parse(event.line, event.command)) {
        const ids = affectedByToken.get(parsed.token) ?? [];
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

  private applyHomebrewFallbackEvent(
    event: HomebrewMaintenanceRunEvent,
    parser: HomebrewMaintenanceOutputParser,
    appID: string,
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
        homebrewFallbackProgressByAppID: {
          ...this.state.homebrewFallbackProgressByAppID,
          [appID]: Math.max(
            this.state.homebrewFallbackProgressByAppID[appID] ?? 0,
            parsed.kind.progress
          )
        }
      });
    }
  }

  private matchingHomebrewItemForApp(appRecord: AppRecord): HomebrewManagedItem | undefined {
    const update = this.state.updates.find((candidate) => candidate.appID === appRecord.id);
    const token = update?.homebrewToken?.toLowerCase();
    return token
      ? this.state.homebrewItems.find((item) => item.token.toLowerCase() === token)
      : undefined;
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
      records.unshift({
        id: appID,
        appID,
        displayName: appRecord.displayName,
        fromVersion: previousUpdate.localVersion,
        toVersion: appRecord.localVersion,
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

  private async withHomebrewUpdating(
    itemID: string,
    operation: () => Promise<void>
  ): Promise<void> {
    if (this.state.homebrewUpdatingItemIDs.includes(itemID)) {
      return;
    }
    this.patch({ homebrewUpdatingItemIDs: addToArray(this.state.homebrewUpdatingItemIDs, itemID) });
    try {
      await operation();
    } finally {
      this.patch({
        homebrewUpdatingItemIDs: removeFromArray(this.state.homebrewUpdatingItemIDs, itemID)
      });
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

  private patch(patch: Partial<BaselineSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.emit("snapshot", this.getSnapshot());
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
    selectedTab: snapshot.selectedTab,
    showInstalledAppsSection: snapshot.showInstalledAppsSection,
    showRecentlyUpdatedAppsSection: snapshot.showRecentlyUpdatedAppsSection,
    showIgnoredAppsSection: snapshot.showIgnoredAppsSection,
    showRecentlyUpdatedHomebrewSection: snapshot.showRecentlyUpdatedHomebrewSection,
    showInstalledHomebrewSection: snapshot.showInstalledHomebrewSection,
    showIgnoredHomebrewSection: snapshot.showIgnoredHomebrewSection,
    collapsedAppSectionIDs: snapshot.collapsedAppSectionIDs,
    collapsedHomebrewSectionIDs: snapshot.collapsedHomebrewSectionIDs,
    autoRefreshEnabled: snapshot.autoRefreshEnabled,
    refreshIntervalMinutes: snapshot.refreshIntervalMinutes,
    useMasForAppStoreUpdates: snapshot.useMasForAppStoreUpdates,
    lastRefreshDate: snapshot.lastRefreshDate
  };
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

function reconcileHomebrewInventory(
  items: HomebrewManagedItem[],
  updates: UpdateRecord[],
  apps: AppRecord[] = [],
  caskIndex: HomebrewCaskIndex = emptyHomebrewCaskIndex
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
  return items.map((item) => {
    if (item.kind !== "cask") {
      return item;
    }
    const caskEntry = caskIndex.byToken[item.token.toLowerCase()];
    const matchingApp = matchingHomebrewApp(updatesByToken, appsByID, apps, item, caskEntry);
    const iconDataURL =
      matchingApp?.iconDataURL ?? matchingHomebrewAppIcon(item, updatesByToken, appsByID, apps);
    const update = updatesByToken.get(item.token.toLowerCase());
    const installedVersion =
      matchingApp && isVersionGreater(matchingApp.localVersion, item.installedVersion)
        ? matchingApp.localVersion
        : item.installedVersion;
    const latestVersion = bestHomebrewCaskLatestVersion(item, update, caskEntry);

    if (!latestVersion || !isVersionGreater(latestVersion, installedVersion)) {
      return {
        ...item,
        iconDataURL: iconDataURL ?? item.iconDataURL,
        installedVersion,
        latestVersion: undefined,
        isOutdated: false,
        releaseDate: undefined
      };
    }
    return {
      ...item,
      iconDataURL: iconDataURL ?? item.iconDataURL,
      installedVersion,
      latestVersion,
      isOutdated: true
    };
  });
}

export function mergeHomebrewRecentlyUpdatedRecords(
  existingRecords: HomebrewRecentlyUpdatedRecord[],
  previousItems: HomebrewManagedItem[],
  currentItems: HomebrewManagedItem[],
  now: string
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
  const cutoff = Date.now() - retentionMs;
  const deduped = new Map<string, HomebrewRecentlyUpdatedRecord>();
  for (const record of records) {
    if (new Date(record.updatedAt).getTime() >= cutoff && !deduped.has(record.itemID)) {
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

function appMatchesCaskEntry(
  app: AppRecord,
  caskEntry: HomebrewCaskEntry | undefined
): boolean {
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

  return new Set(caskEntry.appBundleNames).has(normalizedAppBundleName(app.bundlePath));
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

export function derivedHomebrewItemID(kind: "formula" | "cask", token: string): string {
  return homebrewItemID(kind, token);
}

export function derivedDiscoverID(kind: "formula" | "cask", token: string): string {
  return homebrewDiscoverID(kind, token);
}

function homebrewUninstallFailureMessage(item: HomebrewManagedItem, output: string): string {
  const prefix = `Homebrew uninstall failed for ${item.name}.`;
  return output ? `${prefix}\n\n${output.slice(0, 600)}` : prefix;
}
