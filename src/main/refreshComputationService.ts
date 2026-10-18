// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type {
  AppRecord,
  AppUpdateComparison,
  BaselineSnapshot,
  HomebrewCaskIndex,
  HomebrewFormulaIndex,
  SelfUpdateRecord
} from "../shared/domain";
import { emptyHomebrewCaskIndex, emptyHomebrewFormulaIndex } from "../shared/domain";
import { caskIndexForInstalledItems } from "../shared/homebrewIdentity";
import type { BundleScannerClient } from "./bundleScanner";
import type { AppStoreLookupClient } from "./appStoreLookupClient";
import type { SparkleAppcastClient } from "./sparkleAppcastClient";
import type { HomebrewCaskClient } from "./homebrewCaskClient";
import type { HomebrewFormulaClient } from "./homebrewFormulaClient";
import type { HomebrewInventoryResult } from "./homebrewInventoryClient";
import type { CatalogueStatus } from "./catalogueCache";
import { mergeCatalogueSearchResults } from "./catalogueSearch";
import { lookupAppUpdates, mergeRecentlyUpdated } from "./appUpdateLookupService";
import {
  canUseHomebrewAppUpdate,
  detectLaggingHomebrewCaskTokens,
  homebrewIdentityReconciliationItems,
  mergeHomebrewRecentlyUpdatedRecords,
  preserveFormulaIdentityContinuity,
  preservePreviousHomebrewInventoryMembership,
  preservePreviousHomebrewOutdatedState,
  reconcileHomebrewInventory
} from "./homebrewReconciliation";

export type RefreshOptions = {
  allowHomebrewInventoryDuringActiveCommand?: boolean;
  forceMetadata?: boolean;
  forceAppDiscovery?: boolean;
  onHomebrewInventoryReconciled?: (inventory: HomebrewInventoryResult) => void;
};

export type RefreshReadState = Pick<
  BaselineSnapshot,
  | "appProviderChecks"
  | "appUpdateComparisonBaseline"
  | "homebrewItems"
  | "homebrewFormulaIdentityContinuity"
  | "updates"
  | "recentlyUpdated"
  | "homebrewRecentlyUpdated"
  | "homebrewUpdatedPendingRefreshItemIDs"
  | "homebrewDiscoverInstallingItemIDs"
  | "homebrewDiscoverInstalledPendingRefreshItemIDs"
  | "homebrewDiscoverProgressByItemID"
  | "searchText"
>;

export type RefreshPatch = Partial<
  Pick<
    BaselineSnapshot,
    | "appProviderChecks"
    | "appUpdateComparisonBaseline"
    | "isRefreshing"
    | "refreshErrorMessage"
    | "lastRefreshNoticeMessage"
    | "apps"
    | "updates"
    | "homebrewItems"
    | "homebrewFormulaIdentityContinuity"
    | "recentlyUpdated"
    | "homebrewRecentlyUpdated"
    | "lastRefreshDate"
    | "appUpdatedPendingRefreshIDs"
    | "homebrewUpdatedPendingRefreshItemIDs"
    | "homebrewDiscoverInstallingItemIDs"
    | "homebrewDiscoverInstalledPendingRefreshItemIDs"
    | "homebrewDiscoverProgressByItemID"
    | "selfUpdate"
    | "laggingHomebrewCaskTokens"
    | "homebrewDiscoverItems"
  >
>;

type RefreshClients = {
  scanner: Pick<BundleScannerClient, "scanApplications">;
  appStore: Pick<AppStoreLookupClient, "lookupOutcome"> &
    Partial<Pick<AppStoreLookupClient, "lookupOutcomes" | "storefront">>;
  sparkle: Pick<SparkleAppcastClient, "lookupOutcome">;
  homebrew: Pick<HomebrewCaskClient, "fetchIndex" | "lookupUpdate" | "searchCasks"> &
    Partial<Pick<HomebrewCaskClient, "cacheStatus">>;
  homebrewFormula: Pick<HomebrewFormulaClient, "fetchIndex" | "searchFormulae"> &
    Partial<Pick<HomebrewFormulaClient, "cacheStatus">>;
};

export type RefreshPorts = {
  readState: () => RefreshReadState;
  patch: (patch: RefreshPatch) => void;
  persist: () => Promise<void>;
  scanDirectories: () => string[];
  fetchHomebrewInventory: (
    lightweight: boolean,
    options: RefreshOptions
  ) => Promise<HomebrewInventoryResult>;
  lookupSelfUpdate: (now: string) => Promise<SelfUpdateRecord | undefined>;
  isCurrent: (sequence: number) => boolean;
  isSelfApp: (app: AppRecord) => boolean;
  beginRefresh: (sequence: number) => void;
  endRefresh: (sequence: number) => boolean;
  isHomebrewMutationActive: () => boolean;
  isCleanupInventoryRequired: () => boolean;
  setCleanupInventoryRequired: (required: boolean, fullRefresh: boolean) => void;
  invalidateHomebrewUpdateTargets: () => void;
  processHomebrewUpdateQueue: () => void;
};

export class RefreshComputationService {
  private latestCaskIndex: HomebrewCaskIndex = emptyHomebrewCaskIndex;
  private latestFormulaIndex: HomebrewFormulaIndex = emptyHomebrewFormulaIndex;

  constructor(
    private readonly clients: RefreshClients,
    private readonly ports: RefreshPorts
  ) {}

  get caskIndex(): HomebrewCaskIndex {
    return this.latestCaskIndex;
  }

  async compute(
    lightweight: boolean,
    sequence: number,
    options: RefreshOptions,
    signal: AbortSignal
  ): Promise<void> {
    this.ports.beginRefresh(sequence);
    const comparisonBaseline =
      this.ports.readState().appUpdateComparisonBaseline ??
      appUpdateComparisons(this.ports.readState().updates);
    this.ports.patch({
      // Seed older snapshots before any preview can remove comparison evidence.
      // Failed or superseded generations leave this baseline intact for retries
      // and unrelated preference saves, including a later relaunch.
      appUpdateComparisonBaseline: comparisonBaseline,
      isRefreshing: true,
      refreshErrorMessage: undefined,
      lastRefreshNoticeMessage: undefined
    });
    const now = new Date().toISOString();
    const force =
      options.forceMetadata ?? (!lightweight && !options.allowHomebrewInventoryDuringActiveCommand);
    let homebrewInventoryTask: Promise<HomebrewInventoryResult> | undefined;
    try {
      homebrewInventoryTask = this.ports.fetchHomebrewInventory(lightweight, options);
      const [apps, catalogueIndex, homebrewFormulaIndex, homebrewInventory, selfUpdate] =
        await Promise.all([
          this.clients.scanner.scanApplications(this.ports.scanDirectories()),
          this.clients.homebrew.fetchIndex({ force }),
          this.clients.homebrewFormula.fetchIndex({ force }),
          homebrewInventoryTask,
          this.ports.lookupSelfUpdate(now)
        ]);
      if (!this.ports.isCurrent(sequence)) {
        return;
      }
      const homebrewItems = preservePreviousHomebrewInventoryMembership(
        homebrewInventory.items,
        this.ports.readState().homebrewItems,
        homebrewInventory.inventoryReadSucceededByKind,
        this.ports.readState().homebrewFormulaIdentityContinuity
      );
      const homebrewIndex = caskIndexForInstalledItems(catalogueIndex, homebrewItems);
      this.latestCaskIndex = homebrewIndex;
      this.latestFormulaIndex = homebrewFormulaIndex;
      const previousUpdates = new Map(
        this.ports.readState().updates.map((update) => [update.appID, update])
      );
      const previousChecks = this.ports.readState().appProviderChecks;
      this.ports.patch({ apps });
      const updates = await lookupAppUpdates(
        {
          appStore: this.clients.appStore,
          sparkle: this.clients.sparkle,
          homebrew: this.clients.homebrew
        },
        {
          apps,
          previousUpdates,
          previousChecks,
          homebrewVersionCheckSucceeded:
            (homebrewInventory.outdatedDetectionSucceededByKind?.cask ??
              homebrewInventory.outdatedDetectionSucceeded) &&
            homebrewInventory.inventoryReadSucceededByKind?.cask !== false &&
            !this.clients.homebrew.cacheStatus?.stale &&
            !this.clients.homebrew.cacheStatus?.unavailable,
          forceAppDiscovery: options.forceAppDiscovery,
          onProgress: (appProviderChecks, updates) => {
            if (this.ports.isCurrent(sequence)) this.ports.patch({ appProviderChecks, updates });
          },
          homebrewItems,
          homebrewIndex,
          now,
          force,
          signal,
          isCurrent: () => this.ports.isCurrent(sequence),
          isSelfApp: (app) => this.ports.isSelfApp(app),
          canUseHomebrewAppUpdate
        }
      );
      if (!updates) return;

      if (!this.ports.isCurrent(sequence)) {
        return;
      }
      const previousHomebrewItems = this.ports.readState().homebrewItems;
      const reconciledHomebrewItems = reconcileHomebrewInventory(
        preservePreviousHomebrewOutdatedState(
          homebrewItems,
          homebrewIdentityReconciliationItems(this.ports.readState()),
          homebrewInventory.outdatedDetectionSucceededByKind
        ),
        updates,
        apps,
        homebrewIndex,
        previousHomebrewItems,
        (app) => this.ports.isSelfApp(app)
      );
      const homebrewFormulaIdentityContinuity = preserveFormulaIdentityContinuity(
        reconciledHomebrewItems,
        this.ports.readState(),
        homebrewInventory.inventoryReadSucceededByKind
      );
      const recentlyUpdated = mergeRecentlyUpdated(
        this.ports.readState().recentlyUpdated,
        apps,
        updates,
        new Map(comparisonBaseline.map((update) => [update.appID, update])),
        now
      );
      const homebrewRecentlyUpdated = mergeHomebrewRecentlyUpdatedRecords(
        this.ports.readState().homebrewRecentlyUpdated,
        homebrewIdentityReconciliationItems(this.ports.readState()),
        homebrewIdentityReconciliationItems({
          homebrewItems: reconciledHomebrewItems,
          homebrewFormulaIdentityContinuity
        }),
        now,
        { completedItemIDs: this.ports.readState().homebrewUpdatedPendingRefreshItemIDs }
      );
      const preserveHomebrewCommandState =
        this.ports.isHomebrewMutationActive() && !options.allowHomebrewInventoryDuringActiveCommand;
      this.ports.patch({
        apps,
        updates,
        appUpdateComparisonBaseline: appUpdateComparisons(updates),
        homebrewItems: reconciledHomebrewItems,
        homebrewFormulaIdentityContinuity,
        recentlyUpdated,
        homebrewRecentlyUpdated,
        lastRefreshDate: new Date().toISOString(),
        lastRefreshNoticeMessage:
          [
            homebrewInventory.warning,
            catalogueCacheNotice(
              this.clients.homebrew.cacheStatus,
              this.clients.homebrewFormula.cacheStatus
            )
          ]
            .filter(Boolean)
            .join(" ") || undefined,
        appUpdatedPendingRefreshIDs: [],
        homebrewUpdatedPendingRefreshItemIDs: preserveHomebrewCommandState
          ? this.ports.readState().homebrewUpdatedPendingRefreshItemIDs
          : [],
        homebrewDiscoverInstallingItemIDs: preserveHomebrewCommandState
          ? this.ports.readState().homebrewDiscoverInstallingItemIDs
          : [],
        homebrewDiscoverInstalledPendingRefreshItemIDs: preserveHomebrewCommandState
          ? this.ports.readState().homebrewDiscoverInstalledPendingRefreshItemIDs
          : [],
        homebrewDiscoverProgressByItemID: preserveHomebrewCommandState
          ? this.ports.readState().homebrewDiscoverProgressByItemID
          : {},
        selfUpdate,
        laggingHomebrewCaskTokens: detectLaggingHomebrewCaskTokens(
          homebrewItems,
          updates,
          apps,
          homebrewIndex
        )
      });
      await this.refreshDiscoverItems();
      if (homebrewInventoryIsComplete(homebrewInventory)) {
        this.ports.setCleanupInventoryRequired(false, !lightweight);
      } else if (this.ports.isCleanupInventoryRequired() || options.onHomebrewInventoryReconciled) {
        this.ports.setCleanupInventoryRequired(true, !lightweight);
        this.ports.invalidateHomebrewUpdateTargets();
      }
      await this.ports.persist();
      if (!this.ports.isCurrent(sequence)) return;
      options.onHomebrewInventoryReconciled?.(homebrewInventory);
      void this.ports.processHomebrewUpdateQueue();
    } catch (error) {
      if (!this.ports.isCurrent(sequence)) {
        return;
      }
      // Keep this refresh's task even after the shared inventory lock is released.
      // An unrelated provider failure must not discard fresh membership evidence.
      const recoveredHomebrewInventory = await homebrewInventoryTask?.catch(() => undefined);
      if (!this.ports.isCurrent(sequence)) {
        return;
      }
      const patch: RefreshPatch = {
        appProviderChecks: Object.fromEntries(
          Object.entries(this.ports.readState().appProviderChecks ?? {}).map(([id, check]) => [
            id,
            check.status === "pending" ? { ...check, status: "failed" as const } : check
          ])
        ),
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
          this.ports.readState().homebrewItems,
          inventory.inventoryReadSucceededByKind,
          this.ports.readState().homebrewFormulaIdentityContinuity
        ),
        homebrewIdentityReconciliationItems(this.ports.readState()),
        inventory.outdatedDetectionSucceededByKind
      );
      patch.homebrewFormulaIdentityContinuity = preserveFormulaIdentityContinuity(
        patch.homebrewItems,
        this.ports.readState(),
        inventory.inventoryReadSucceededByKind
      );
      patch.homebrewRecentlyUpdated = mergeHomebrewRecentlyUpdatedRecords(
        this.ports.readState().homebrewRecentlyUpdated,
        homebrewIdentityReconciliationItems(this.ports.readState()),
        homebrewIdentityReconciliationItems({
          homebrewItems: patch.homebrewItems,
          homebrewFormulaIdentityContinuity: patch.homebrewFormulaIdentityContinuity
        }),
        now,
        { completedItemIDs: this.ports.readState().homebrewUpdatedPendingRefreshItemIDs }
      );
      patch.lastRefreshNoticeMessage = recoveredHomebrewInventory?.warning;
      this.ports.patch(patch);
      if (this.ports.isCleanupInventoryRequired() || options.onHomebrewInventoryReconciled) {
        this.ports.setCleanupInventoryRequired(true, !lightweight);
        this.ports.invalidateHomebrewUpdateTargets();
        await this.ports.persist().catch(() => undefined);
      } else {
        await this.ports.persist();
      }
      void this.ports.processHomebrewUpdateQueue();
    } finally {
      if (this.ports.isCurrent(sequence)) this.ports.patch({ isRefreshing: false });
      // Fresh identity, membership and pins must reach state before any queued
      // command can resume. A superseded refresh cannot release its successor.
      if (this.ports.endRefresh(sequence)) {
        void this.ports.processHomebrewUpdateQueue();
      }
    }
  }

  refreshDiscoverItems(): void {
    const state = this.ports.readState();
    const term = state.searchText.trim();
    if (!term) {
      this.ports.patch({ homebrewDiscoverItems: [] });
      return;
    }
    const installedCasks = new Set(
      state.homebrewItems
        .filter((item) => item.kind === "cask")
        .map((item) => item.token.toLowerCase())
    );
    const installedFormulae = new Set(
      state.homebrewItems
        .filter((item) => item.kind === "formula")
        .map((item) => item.token.toLowerCase())
    );
    const casks = this.clients.homebrew.searchCasks(term, this.latestCaskIndex, installedCasks);
    const formulae = this.clients.homebrewFormula.searchFormulae(
      term,
      this.latestFormulaIndex,
      installedFormulae
    );
    this.ports.patch({ homebrewDiscoverItems: mergeCatalogueSearchResults(term, casks, formulae) });
  }
}

function appUpdateComparisons(updates: AppUpdateComparison[]): AppUpdateComparison[] {
  return updates.map(({ appID, source, localVersion, localBuildVersion }) => ({
    appID,
    source,
    localVersion,
    localBuildVersion
  }));
}

export function homebrewInventoryIsComplete(inventory: HomebrewInventoryResult): boolean {
  return (
    inventory.inventoryReadSucceededByKind?.formula !== false &&
    inventory.inventoryReadSucceededByKind?.cask !== false &&
    inventory.outdatedDetectionSucceeded &&
    inventory.outdatedDetectionSucceededByKind?.formula !== false &&
    inventory.outdatedDetectionSucceededByKind?.cask !== false
  );
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
