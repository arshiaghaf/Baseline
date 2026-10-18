// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import path from "node:path";
import type {
  AppRecord,
  AppProviderCheck,
  HomebrewCaskIndex,
  HomebrewManagedItem,
  RecentlyUpdatedRecord,
  UpdateRecord
} from "../shared/domain";
import { isValidHomebrewToken } from "../shared/security";
import { compareVersions, isVersionGreater, version } from "../shared/version";
import { isSparkleVersionNewer, sparkleMarketingVersion } from "../shared/sparkleVersion";
import type { AppStoreLookupClient } from "./appStoreLookupClient";
import type { SparkleAppcastClient } from "./sparkleAppcastClient";
import type { HomebrewCaskClient } from "./homebrewCaskClient";

type LookupClients = {
  appStore: Pick<AppStoreLookupClient, "lookupOutcome"> &
    Partial<Pick<AppStoreLookupClient, "lookupOutcomes" | "storefront">>;
  sparkle: Pick<SparkleAppcastClient, "lookupOutcome">;
  homebrew: Pick<HomebrewCaskClient, "lookupUpdate">;
};

type LookupInput = {
  apps: AppRecord[];
  previousUpdates: Map<string, UpdateRecord>;
  homebrewItems: HomebrewManagedItem[];
  homebrewIndex: HomebrewCaskIndex;
  now: string;
  force: boolean;
  forceAppDiscovery?: boolean;
  previousChecks?: Record<string, AppProviderCheck>;
  homebrewVersionCheckSucceeded?: boolean;
  onProgress?: (checks: Record<string, AppProviderCheck>, updates: UpdateRecord[]) => void;
  signal: AbortSignal;
  isCurrent: () => boolean;
  isSelfApp: (app: AppRecord) => boolean;
  canUseHomebrewAppUpdate: (
    app: AppRecord,
    token: string,
    items: HomebrewManagedItem[],
    index: HomebrewCaskIndex
  ) => boolean;
};

/** Returns undefined when a superseded generation must not commit its partial results. */
export async function lookupAppUpdates(
  clients: LookupClients,
  input: LookupInput
): Promise<UpdateRecord[] | undefined> {
  const updates = new Map<string, UpdateRecord>();
  const checks: Record<string, AppProviderCheck> = {};
  const apps = input.apps.filter((app) => !input.isSelfApp(app));
  const active = () => !input.signal.aborted && input.isCurrent();
  const publish = () => {
    if (active()) input.onProgress?.({ ...checks }, [...updates.values()]);
  };
  const storefront = clients.appStore.storefront ?? "us";
  const previousFor = (app: AppRecord) => {
    const previous = input.previousChecks?.[app.id];
    return previous?.fingerprint === appProviderFingerprint(app) &&
      previous.storefront === storefront
      ? previous
      : undefined;
  };
  for (const app of apps) {
    const previous = input.previousUpdates.get(app.id);
    if (
      previous &&
      (!input.previousChecks?.[app.id] || previousFor(app)) &&
      compareVersions(previous.localVersion, app.localVersion) === 0 &&
      (!previous.localBuildVersion ||
        (app.bundleVersion &&
          compareVersions(previous.localBuildVersion, app.bundleVersion) === 0)) &&
      isAppUpdateNewerThanInstalledApp(previous, app) &&
      (previous.source !== "homebrew" ||
        (previous.homebrewToken &&
          isValidHomebrewToken(previous.homebrewToken) &&
          input.canUseHomebrewAppUpdate(
            app,
            previous.homebrewToken,
            input.homebrewItems,
            input.homebrewIndex
          )))
    ) {
      updates.set(app.id, previous);
    }
    checks[app.id] = {
      ...previousFor(app),
      fingerprint: appProviderFingerprint(app),
      storefront,
      status: "pending"
    };
  }
  publish();

  const discoveryDue = (app: AppRecord) => {
    const previous = previousFor(app);
    if (
      input.forceAppDiscovery ||
      !previous ||
      previous.status === "failed" ||
      previous.status === "pending"
    )
      return true;
    const searched = Date.parse(previous.discoveryCheckedAt ?? "");
    const age = Date.parse(input.now) - searched;
    return !Number.isFinite(age) || age < 0 || age >= 6 * 60 * 60 * 1000;
  };
  const eligibleForApple = (app: AppRecord) =>
    Boolean(app.bundleIdentifier && (!app.isIOSAppOnMac || app.hasAppStoreEvidence === true));
  const known = apps.filter((app) => eligibleForApple(app) && previousFor(app)?.appStoreIdentity);
  const hasKnownAlternative = (app: AppRecord) => {
    const previous = previousFor(app);
    if (!previous) return false;
    if (previous.sparkleFeedURL && previous.sparkleFeedURL === app.sparkleFeedURL) return true;
    return (
      previous.source === "homebrew" &&
      input.homebrewVersionCheckSucceeded !== false &&
      input.homebrewItems.some(
        (item) =>
          item.kind === "cask" &&
          input.canUseHomebrewAppUpdate(app, item.token, input.homebrewItems, input.homebrewIndex)
      )
    );
  };
  const discovery = apps.filter(
    (app) =>
      eligibleForApple(app) &&
      !previousFor(app)?.appStoreIdentity &&
      // An actionable Apple record can omit its product ID. Keep checking by
      // bundle until it has a durable identity instead of deferring that source.
      (previousFor(app)?.source === "appStore" ||
        (input.force && !hasKnownAlternative(app)) ||
        discoveryDue(app))
  );
  const requests = (group: AppRecord[]) =>
    group.map((app) => ({
      bundleIdentifier: app.bundleIdentifier!,
      localVersion: app.localVersion,
      platform: app.isIOSAppOnMac ? ("ios" as const) : ("mac" as const),
      identity: discoveryDue(app) ? undefined : previousFor(app)?.appStoreIdentity
    }));
  // Start known identities first so deeper searches do not delay their request slots.
  const lookups = new Map<
    string,
    () => Promise<Awaited<ReturnType<AppStoreLookupClient["lookupOutcome"]>>>
  >();
  const requestedIdentity = new Map<string, boolean>();
  const readyLookups = new Map<string, Promise<void>>();
  const bulkTasks: Promise<void>[] = [];
  for (const group of [known, discovery]) {
    if (!group.length) continue;
    const groupRequests = requests(group);
    group.forEach((app, index) =>
      requestedIdentity.set(app.id, Boolean(groupRequests[index]?.identity))
    );
    if (clients.appStore.lookupOutcomes) {
      type Outcome = Awaited<ReturnType<AppStoreLookupClient["lookupOutcome"]>>;
      const deferred = group.map((app) => {
        let resolve!: (outcome: Outcome) => void;
        const task = new Promise<Outcome>((done) => {
          resolve = done;
        });
        lookups.set(app.id, () => task);
        readyLookups.set(
          app.id,
          task.then(() => undefined)
        );
        return { resolve };
      });
      const task = clients.appStore
        .lookupOutcomes(groupRequests, {
          signal: input.signal,
          force: Boolean(input.force || input.forceAppDiscovery),
          onOutcome: (index, outcome) => deferred[index]?.resolve(outcome)
        })
        .catch(() => group.map(() => ({ type: "transientFailure" as const })))
        .then((outcomes) => {
          // Injected clients need not stream. Settle every waiter on final return.
          deferred.forEach((entry, index) =>
            entry.resolve(outcomes[index] ?? { type: "transientFailure" })
          );
        });
      bulkTasks.push(task);
    } else {
      for (const app of group) {
        lookups.set(app.id, () =>
          clients.appStore.lookupOutcome(app.bundleIdentifier!, app.localVersion, {
            signal: input.signal,
            force: Boolean(input.force || input.forceAppDiscovery),
            identity: groupRequests[group.indexOf(app)]?.identity,
            includeIOSAppStoreSoftware: app.isIOSAppOnMac === true,
            includeMacCapableAppStoreSoftware: app.isIOSAppOnMac !== true
          })
        );
      }
    }
  }

  async function lookupOne(app: AppRecord): Promise<void> {
    if (!active()) return;
    const check = { ...checks[app.id]! };
    let result: UpdateRecord | undefined;
    let failed = false;
    let checkedSource: AppProviderCheck["source"];
    let checkedAt: string | undefined;
    const finish = (
      status: AppProviderCheck["status"],
      source?: AppProviderCheck["source"],
      checkedAt?: string
    ) => {
      if (result) updates.set(app.id, result);
      else updates.delete(app.id);
      checks[app.id] = {
        ...check,
        status,
        source: source ?? (status === "failed" ? check.source : undefined),
        checkedAt: checkedAt ?? (status === "failed" ? check.checkedAt : undefined)
      };
      publish();
    };
    const apple = lookups.get(app.id);
    if (apple) {
      let outcome = await apple();
      let usedIdentity = requestedIdentity.get(app.id) ?? false;
      if (!active()) return;
      if (
        outcome.type === "completed" &&
        !outcome.identity &&
        !outcome.value &&
        !usedIdentity &&
        check.appStoreIdentity
      ) {
        // A bundle search cannot invalidate an independently verified product.
        // Confirm it freshly before replacing its identity or actionable result.
        check.discoveryCheckedAt = outcome.checkedAt ?? input.now;
        outcome = await clients.appStore.lookupOutcome(app.bundleIdentifier!, app.localVersion, {
          signal: input.signal,
          force: Boolean(input.force || input.forceAppDiscovery),
          identity: check.appStoreIdentity,
          includeIOSAppStoreSoftware: app.isIOSAppOnMac === true,
          includeMacCapableAppStoreSoftware: app.isIOSAppOnMac !== true
        });
        usedIdentity = true;
        if (!active()) return;
      }
      if (outcome.type === "completed") {
        if (outcome.discovered ?? !usedIdentity)
          check.discoveryCheckedAt = outcome.checkedAt ?? input.now;
        check.appStoreIdentity = outcome.identity;
        if (outcome.value) {
          result = {
            id: app.id,
            appID: app.id,
            source: "appStore",
            supportLevel: "supported",
            localVersion: app.localVersion,
            remoteVersion: outcome.value.remoteVersion,
            updateURL: outcome.value.updateURL,
            appStoreItemID: outcome.value.appStoreItemID,
            releaseNotesSummary: outcome.value.releaseNotesSummary,
            releaseDate: outcome.value.releaseDate,
            checkedAt: outcome.checkedAt ?? input.now
          };
        }
        if (outcome.identity || outcome.value) {
          checkedSource = "appStore";
          checkedAt = outcome.checkedAt ?? input.now;
          if (outcome.value) {
            finish("checked", checkedSource, checkedAt);
            return;
          }
        }
      } else {
        failed = true;
        const previous =
          !input.previousChecks?.[app.id] || previousFor(app)
            ? previousAppUpdateForTransientLookup(input.previousUpdates, app, "appStore")
            : undefined;
        if (previous) result = previous;
        if (previous) {
          finish("failed", "appStore", previous?.checkedAt ?? check.checkedAt);
          return;
        }
      }
    }

    if (app.sparkleFeedURL) {
      const outcome = await clients.sparkle.lookupOutcome(
        app.sparkleFeedURL,
        app.localVersion,
        app.bundleVersion,
        { signal: input.signal, force: input.force }
      );
      if (!active()) return;
      if (outcome.type === "completed" && outcome.providerFound !== false) {
        check.sparkleFeedURL = app.sparkleFeedURL;
        if (outcome.value) {
          result = {
            id: app.id,
            appID: app.id,
            source: "sparkle",
            supportLevel: "limited",
            localVersion: app.localVersion,
            remoteVersion: outcome.value.remoteVersion,
            localBuildVersion: app.bundleVersion,
            remoteBuildVersion: outcome.value.remoteBuildVersion,
            sparkleVersionComparison: outcome.value.versionComparison,
            updateURL: outcome.value.updateURL,
            releaseNotesURL: outcome.value.releaseNotesURL,
            releaseDate: outcome.value.releaseDate,
            checkedAt: outcome.checkedAt ?? input.now
          };
        }
        checkedSource ??= "sparkle";
        checkedAt ??= outcome.checkedAt ?? input.now;
        if (outcome.value) {
          finish(failed ? "failed" : "checked", "sparkle", outcome.checkedAt ?? input.now);
          return;
        }
      }
      if (outcome.type === "completed" && outcome.providerFound === false)
        check.sparkleFeedURL = undefined;
      failed ||= outcome.type === "transientFailure";
      const previous =
        outcome.type === "transientFailure" && (!input.previousChecks?.[app.id] || previousFor(app))
          ? previousAppUpdateForTransientLookup(input.previousUpdates, app, "sparkle")
          : undefined;
      if (previous) result = previous;
      if (previous) {
        finish("failed", "sparkle", previous.checkedAt);
        return;
      }
    }

    const homebrewUpdate = clients.homebrew.lookupUpdate(
      app.bundleIdentifier,
      path.basename(app.bundlePath),
      app.localVersion,
      input.homebrewIndex
    );
    if (
      homebrewUpdate &&
      isValidHomebrewToken(homebrewUpdate.token) &&
      input.canUseHomebrewAppUpdate(
        app,
        homebrewUpdate.token,
        input.homebrewItems,
        input.homebrewIndex
      )
    ) {
      if (input.homebrewVersionCheckSucceeded === false) {
        result =
          !input.previousChecks?.[app.id] || previousFor(app)
            ? previousAppUpdateForTransientLookup(input.previousUpdates, app, "homebrew")
            : undefined;
        finish("failed", "homebrew", result?.checkedAt);
        return;
      }
      result = {
        id: app.id,
        appID: app.id,
        source: "homebrew",
        supportLevel: "limited",
        localVersion: app.localVersion,
        remoteVersion: homebrewUpdate.remoteVersion,
        homebrewToken: homebrewUpdate.token,
        updateURL: homebrewUpdate.homepageURL,
        releaseNotesSummary: `Token: ${homebrewUpdate.token}`,
        checkedAt: input.now
      };
      finish(failed ? "failed" : "checked", "homebrew", input.now);
      return;
    }
    const owned = input.homebrewItems.some(
      (item) =>
        item.kind === "cask" &&
        input.canUseHomebrewAppUpdate(app, item.token, input.homebrewItems, input.homebrewIndex)
    );
    finish(
      failed || (owned && input.homebrewVersionCheckSucceeded === false)
        ? "failed"
        : owned || checkedSource
          ? "checked"
          : "unresolved",
      checkedSource ?? (owned ? "homebrew" : undefined),
      checkedAt ?? (owned && input.homebrewVersionCheckSucceeded !== false ? input.now : undefined)
    );
  }

  const workApps = [...apps].sort(
    (a, b) =>
      Number(Boolean(previousFor(b)?.appStoreIdentity || previousFor(b)?.sparkleFeedURL)) -
      Number(Boolean(previousFor(a)?.appStoreIdentity || previousFor(a)?.sparkleFeedURL))
  );
  const readyApps: AppRecord[] = [];
  const waiters = new Set<() => void>();
  const wakeWorkers = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  let remaining = workApps.length;
  let workerFailed = false;
  for (const app of workApps) {
    const ready = readyLookups.get(app.id);
    if (ready)
      void ready.then(() => {
        readyApps.push(app);
        wakeWorkers();
      });
    else readyApps.push(app);
  }
  const takeReadyApp = async () => {
    while (remaining && active() && !workerFailed) {
      // Omitted Apple records do not hold a worker ahead of verified products
      // or independent installed updaters. Each app enters the ready queue once.
      const app = readyApps.shift();
      if (app) {
        if (--remaining === 0) wakeWorkers();
        return app;
      }
      await new Promise<void>((resolve) => {
        waiters.add(resolve);
      });
    }
    return undefined;
  };
  const work = async () => {
    for (;;) {
      const app = await takeReadyApp();
      if (!app || !active() || workerFailed) return;
      try {
        await lookupOne(app);
      } catch (error) {
        workerFailed = true;
        wakeWorkers();
        throw error;
      }
    }
  };
  // Drain both app workers and provider batches before releasing refresh locks.
  const settled = await Promise.allSettled([
    ...Array.from({ length: Math.min(4, apps.length) }, work),
    ...bulkTasks
  ]);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return active()
    ? apps.flatMap((app) => (updates.has(app.id) ? [updates.get(app.id)!] : []))
    : undefined;
}

/** Fallback for injected scanners and legacy snapshots without scanner stat evidence. */
export function appProviderFingerprint(app: AppRecord): string {
  return (
    app.providerFingerprint ??
    JSON.stringify([
      app.bundlePath,
      app.bundleIdentifier?.toLowerCase(),
      app.isIOSAppOnMac === true,
      app.hasAppStoreEvidence === true,
      app.hasSafariWebExtension === true,
      app.sparkleFeedURL,
      app.localVersion.raw,
      app.bundleVersion?.raw
    ])
  );
}

type AppLookupSource = Extract<UpdateRecord["source"], "appStore" | "sparkle" | "homebrew">;

function previousAppUpdateForTransientLookup(
  previousUpdates: Map<string, UpdateRecord>,
  appRecord: AppRecord,
  source: AppLookupSource
): UpdateRecord | undefined {
  const previousUpdate = previousUpdates.get(appRecord.id);
  if (!previousUpdate || previousUpdate.source !== source) return undefined;
  if (previousUpdate.appID !== appRecord.id) return undefined;
  if (compareVersions(previousUpdate.localVersion, appRecord.localVersion) !== 0) return undefined;
  if (
    previousUpdate.localBuildVersion &&
    (!appRecord.bundleVersion ||
      compareVersions(previousUpdate.localBuildVersion, appRecord.bundleVersion) !== 0)
  )
    return undefined;
  return isAppUpdateNewerThanInstalledApp(previousUpdate, appRecord) ? previousUpdate : undefined;
}

export function isAppUpdateNewerThanInstalledApp(
  update: UpdateRecord,
  appRecord: AppRecord
): boolean {
  if (update.source === "sparkle") {
    const candidate = {
      parsedVersion: sparkleMarketingVersion(update.remoteVersion, update.remoteBuildVersion),
      buildVersion: update.remoteBuildVersion ?? version(),
      hasMarketingVersion: update.sparkleVersionComparison !== "build"
    };
    const localVersion = sparkleMarketingVersion(appRecord.localVersion, appRecord.bundleVersion);
    if (isSparkleVersionNewer(candidate, localVersion, appRecord.bundleVersion)) return true;
    // Legacy records did not preserve the feed's comparison domain.
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
  if (versionComparison > 0) return true;
  if (versionComparison < 0) return false;
  if (!update.remoteBuildVersion || !update.localBuildVersion || !appRecord.bundleVersion)
    return false;
  return (
    compareVersions(update.localBuildVersion, appRecord.bundleVersion) === 0 &&
    isVersionGreater(update.remoteBuildVersion, appRecord.bundleVersion)
  );
}

export function mergeRecentlyUpdated(
  previousRecords: RecentlyUpdatedRecord[],
  apps: AppRecord[],
  updates: UpdateRecord[],
  previousUpdates: Map<string, UpdateRecord>,
  now: string
) {
  const currentUpdateIDs = new Set(updates.map((update) => update.appID));
  const appByID = new Map(apps.map((app) => [app.id, app]));
  const records = [...previousRecords];
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

function hasInstalledAppAdvanced(appRecord: AppRecord, previousUpdate: UpdateRecord): boolean {
  if (isVersionGreater(appRecord.localVersion, previousUpdate.localVersion)) {
    return true;
  }
  if (!previousUpdate.localBuildVersion || !appRecord.bundleVersion) {
    return false;
  }
  return isVersionGreater(appRecord.bundleVersion, previousUpdate.localBuildVersion);
}
