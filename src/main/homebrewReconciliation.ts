// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { isMacOSManagedApp } from "./macOSManagedApps";
import path from "node:path";
import type {
  AppRecord,
  HomebrewCaskEntry,
  HomebrewCaskIndex,
  HomebrewManagedItem,
  HomebrewManagedItemKind,
  HomebrewRecentlyUpdatedRecord,
  PersistedSnapshot,
  UpdateRecord
} from "../shared/domain";
import { emptyHomebrewCaskIndex } from "../shared/domain";
import {
  homebrewCommandToken,
  homebrewItemIdentity,
  installedCaskEntry
} from "../shared/homebrewIdentity";
import { isValidHomebrewToken } from "../shared/security";
import {
  compareVersions,
  isVersionEmpty,
  isVersionGreater,
  type VersionValue
} from "../shared/version";
import type { HomebrewInventoryResult } from "./homebrewInventoryClient";

export function emptyHomebrewInventoryResult(): HomebrewInventoryResult {
  return {
    items: [],
    outdatedDetectionSucceeded: true,
    outdatedDetectionSucceededByKind: { formula: true, cask: true }
  };
}

export function homebrewIdentityReconciliationItems(
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

export function preserveFormulaIdentityContinuity(
  items: HomebrewManagedItem[],
  snapshot: Pick<PersistedSnapshot, "homebrewItems" | "homebrewFormulaIdentityContinuity">,
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

export function preservePreviousHomebrewInventoryMembership(
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
    const preserveReportedCaskUpdate =
      previous.latestVersion !== undefined &&
      preserveHomebrewReportedCaskUpdate(previous, item.installedVersion, previous.latestVersion);
    if (
      previous.latestVersion &&
      !isVersionGreater(previous.latestVersion, item.installedVersion) &&
      !preserveReportedCaskUpdate
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

export function canUseHomebrewAppUpdate(
  appRecord: AppRecord,
  homebrewToken: string,
  homebrewItems: HomebrewManagedItem[],
  caskIndex: HomebrewCaskIndex,
  apps: AppRecord[] = [appRecord]
): boolean {
  if (isMacOSManagedApp(appRecord)) return false;
  const token = homebrewToken.toLowerCase();
  return homebrewItems.some(
    (item) =>
      item.kind === "cask" &&
      item.token.toLowerCase() === token &&
      homebrewCaskItemProvesAppOwnership(item, appRecord, installedCaskEntry(item, caskIndex), apps)
  );
}

export function homebrewItemCanRunAppUpdate(
  item: HomebrewManagedItem,
  update: UpdateRecord
): boolean {
  return (
    !item.pinned &&
    (item.isOutdated || isVersionGreater(update.remoteVersion, item.installedVersion))
  );
}

export function homebrewCaskItemProvesAppOwnership(
  item: HomebrewManagedItem,
  appRecord: AppRecord,
  caskEntry: HomebrewCaskEntry | undefined,
  apps: AppRecord[] = [appRecord]
): boolean {
  if (isMacOSManagedApp(appRecord) || item.kind !== "cask") return false;
  if (!homebrewCommandToken(item)) return false;
  if (caskEntry) {
    return appHasUniqueCaskMatch(appRecord, caskEntry, apps);
  }
  if (item.appID === appRecord.id) {
    return true;
  }
  return false;
}

export function withoutMacOSManagedAppLinks(
  items: HomebrewManagedItem[],
  apps: AppRecord[]
): HomebrewManagedItem[] {
  const managedIDs = new Set(apps.filter(isMacOSManagedApp).map((app) => app.id));
  return items.map((item) =>
    item.kind === "cask" && item.appID && managedIDs.has(item.appID)
      ? { ...item, appID: undefined, iconDataURL: undefined }
      : item
  );
}

export function reconcileHomebrewInventory(
  items: HomebrewManagedItem[],
  updates: UpdateRecord[],
  apps: AppRecord[] = [],
  caskIndex: HomebrewCaskIndex = emptyHomebrewCaskIndex,
  previousItems: HomebrewManagedItem[] = [],
  isSelfApp?: (app: AppRecord) => boolean
): HomebrewManagedItem[] {
  const managedIDs = new Set(apps.filter(isMacOSManagedApp).map((app) => app.id));
  items = withoutMacOSManagedAppLinks(items, apps);
  previousItems = withoutMacOSManagedAppLinks(previousItems, apps);
  apps = apps.filter((app) => !isMacOSManagedApp(app));
  const updatesByToken = new Map<string, UpdateRecord>();
  for (const update of updates) {
    if (update.source === "homebrew" && update.homebrewToken && !managedIDs.has(update.appID)) {
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
      apps,
      caskEntry,
      isSelfApp,
      updatesByToken.get(item.token.toLowerCase())?.appID
    );
    const iconDataURL =
      matchingApp?.iconDataURL ??
      (caskEntry ? undefined : matchingHomebrewAppIcon(item, updatesByToken, appsByID, apps));
    const preservedIconDataURL = caskEntry && !matchingApp ? undefined : item.iconDataURL;
    const candidateUpdate = updatesByToken.get(item.token.toLowerCase());
    const update = candidateUpdate?.appID === matchingApp?.id ? candidateUpdate : undefined;
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
    const keepHomebrewReportedUpdate =
      latestVersion !== undefined &&
      preserveHomebrewReportedCaskUpdate(item, installedVersion, latestVersion);

    if (!latestVersion || ((latestVersionComparison ?? 0) <= 0 && !keepHomebrewReportedUpdate)) {
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
  // The greedy provider result is authoritative for version :latest. It is not
  // comparable with the numeric marketing version displayed for an app.
  if (item.isOutdated && item.latestVersion && isLatestCaskVersion(item.latestVersion))
    return item.latestVersion;
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

function isLatestCaskVersion(value: VersionValue): boolean {
  return value.raw.trim().toLowerCase() === "latest";
}

function preserveHomebrewReportedCaskUpdate(
  item: HomebrewManagedItem,
  installedVersion: VersionValue,
  latestVersion: VersionValue
): boolean {
  return (
    item.kind === "cask" &&
    item.isOutdated &&
    (isLatestCaskVersion(latestVersion) ||
      (compareVersions(latestVersion, installedVersion) === 0 &&
        compareVersions(installedVersion, item.installedVersion) === 0))
  );
}

function matchingHomebrewApp(
  apps: AppRecord[],
  caskEntry: HomebrewCaskEntry | undefined,
  isSelfApp?: (app: AppRecord) => boolean,
  preferredAppID?: string
): AppRecord | undefined {
  const matches = (app: AppRecord) =>
    (!isSelfApp?.(app) || Boolean(caskEntry && installedCaskIdentifiesSelf(app, caskEntry))) &&
    Boolean(caskEntry && appHasUniqueCaskMatch(app, caskEntry, apps));
  // A previous app link or update is not stronger than current installed evidence.
  // Ambiguous copies retain an independent package row. Distinct apps shipped
  // by one cask can each retain their proven update route.
  const candidates = apps.filter(matches);
  return candidates.find((app) => app.id === preferredAppID) ?? candidates[0];
}

export function installedCaskIdentifiesSelf(app: AppRecord, entry: HomebrewCaskEntry): boolean {
  const identifier = app.bundleIdentifier?.toLowerCase();
  if (
    identifier &&
    entry.bundleIdentifiers.some((candidate) => candidate.toLowerCase() === identifier)
  )
    return true;
  // appID and artifact basenames may come from generic name matching; they cannot prove self ownership.
  return (entry.installedAppPaths ?? []).some(
    (target) => path.resolve(target) === path.resolve(app.canonicalBundlePath ?? app.bundlePath)
  );
}

function appHasUniqueCaskMatch(
  app: AppRecord,
  entry: HomebrewCaskEntry,
  apps: AppRecord[]
): boolean {
  if (!appMatchesCaskEntry(app, entry)) return false;
  if (entry.installedAppPaths?.length) return true;
  return !apps.some((other) => {
    if (other.id === app.id || isMacOSManagedApp(other) || !appMatchesCaskEntry(other, entry))
      return false;
    // Multiple distinct artifacts are valid; two copies of the same app are not
    // distinguishable by bundle metadata alone.
    return app.bundleIdentifier && other.bundleIdentifier
      ? app.bundleIdentifier.toLowerCase() === other.bundleIdentifier.toLowerCase()
      : normalizedAppBundleName(app.bundlePath) === normalizedAppBundleName(other.bundlePath);
  });
}

function appMatchesCaskEntry(app: AppRecord, caskEntry: HomebrewCaskEntry | undefined): boolean {
  if (!caskEntry) {
    return true;
  }

  if (caskEntry.installedAppPaths?.length) {
    return caskEntry.installedAppPaths.some(
      (target) => path.resolve(target) === path.resolve(app.canonicalBundlePath ?? app.bundlePath)
    );
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

export function detectLaggingHomebrewCaskTokens(
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

function formulaHasContinuityIdentity(item: HomebrewManagedItem): boolean {
  // Validate saved structural identity independently of its current verification.
  // This helper is for ID reconciliation only; execution uses homebrewCommandToken.
  return (
    item.kind === "formula" &&
    Boolean(homebrewCommandToken({ ...item, formulaIdentityVerified: undefined }))
  );
}
