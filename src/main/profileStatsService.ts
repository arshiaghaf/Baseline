// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type {
  AppRecord,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  ProfileStats,
  ProfileStatsEvent,
  UpdateRecord
} from "../shared/domain";
import { defaultProfileStatsAfterTamper } from "../shared/domain";
import type { ProfileStatsIntegrity } from "./profileStatsIntegrityService";

type ProfileStatsServiceOptions = {
  integrity: ProfileStatsIntegrity;
  getStats: () => ProfileStats;
  publishStats: (stats: ProfileStats) => void;
  persist: () => Promise<void>;
};

export class ProfileStatsService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ProfileStatsServiceOptions) {}

  async verifyIntegrity(): Promise<void> {
    await this.runMutation(async () => {
      const statsBeforeVerification = this.options.getStats();
      const verifiedStats =
        await this.options.integrity.verifyOrInitialize(statsBeforeVerification);
      const stats = await this.reconcileVerifiedStats(statsBeforeVerification, verifiedStats);
      this.options.publishStats(stats);
      await this.options.persist();
    });
  }

  async recordEvents(events: ProfileStatsEvent[]): Promise<void> {
    await this.runMutation(async () => {
      const stats = await this.statsWithEvents(events);
      this.options.publishStats(stats);
      await this.options.persist();
    });
  }

  async drain(): Promise<void> {
    await this.mutationQueue;
  }

  private async runMutation(operation: () => Promise<void>): Promise<void> {
    const mutation = this.mutationQueue.then(operation, operation);
    this.mutationQueue = mutation.catch(() => undefined);
    await mutation;
  }

  private async statsWithEvents(events: ProfileStatsEvent[]): Promise<ProfileStats> {
    const stats = this.options.getStats();
    const currentStats =
      stats.signature || stats.events.length === 0
        ? stats
        : { ...defaultProfileStatsAfterTamper(), events: [], signature: undefined };
    const eventIDs = new Set(currentStats.events.map((event) => event.id));
    const newEvents = events.filter((event) => !eventIDs.has(event.id));
    if (newEvents.length === 0) return currentStats;

    const sealed = await this.options.integrity.seal({
      ...currentStats,
      events: [...newEvents, ...currentStats.events].slice(0, 1000),
      integrityStatus:
        currentStats.integrityStatus === "resetAfterTamper" ? "resetAfterTamper" : "verified"
    });
    if (sealed.integrityStatus === "unavailable") {
      return { ...currentStats, integrityStatus: "unavailable" };
    }
    return sealed;
  }

  private async reconcileVerifiedStats(
    statsBeforeVerification: ProfileStats,
    verifiedStats: ProfileStats
  ): Promise<ProfileStats> {
    const previousEventIDs = new Set(statsBeforeVerification.events.map((event) => event.id));
    const currentStats = this.options.getStats();
    const concurrentEvents = currentStats.events.filter((event) => !previousEventIDs.has(event.id));
    if (concurrentEvents.length === 0) return verifiedStats;

    const concurrentEventIDs = new Set(concurrentEvents.map((event) => event.id));
    const stats = {
      ...verifiedStats,
      events: [
        ...concurrentEvents,
        ...verifiedStats.events.filter((event) => !concurrentEventIDs.has(event.id))
      ].slice(0, 1000)
    };
    const sealed = await this.options.integrity.seal(stats);
    if (sealed.integrityStatus === "unavailable") {
      return { ...currentStats, integrityStatus: "unavailable" };
    }
    return sealed;
  }
}

export function appUpdateProfileStatsEvent({
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

export function homebrewUpdateProfileStatsEvent({
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

export function homebrewInstallProfileStatsEvent(
  item: HomebrewCaskDiscoveryItem
): ProfileStatsEvent {
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
