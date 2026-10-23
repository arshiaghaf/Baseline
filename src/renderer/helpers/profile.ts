// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewManagedItem,
  ProfileStatsChannel,
  ProfileStatsEvent
} from "../../shared/domain";
import { homebrewPresentationLabel, sourceDisplayName } from "../../shared/domain";
import { profileStatsLifetimeFromEvents } from "../../shared/profileStats";
import { homebrewItemHasAppRepresentation } from "../../shared/homebrewAppLinking";
import { localCalendarDay } from "./calendar";

type SummaryEvent = Pick<ProfileStatsEvent, "type" | "targetID" | "displayName" | "channel"> & {
  count?: number;
};

export type ProfileSummary = {
  incompleteHistory: boolean;
  differentApps: number;
  discoverInstalls: number;
  totalUpdates: number;
  startedUsing: {
    relativeLabel: string;
    dateLabel: string;
  };
  favoriteChannelLabel: string;
  sourceMix: Array<{
    channel: ProfileStatsChannel;
    label: string;
    count: number;
  }>;
  topApps: Array<{
    targetID: string;
    displayName: string;
    count: number;
    iconDataURL?: string;
    rank: number;
  }>;
  topHomebrewItems: Array<{
    targetID: string;
    displayName: string;
    count: number;
    kindLabel: string;
    rank: number;
  }>;
};

export function buildProfileSummary(snapshot: BaselineSnapshot): ProfileSummary {
  const lifetime =
    snapshot.profileStats.lifetime ??
    profileStatsLifetimeFromEvents(
      snapshot.profileStats.events,
      snapshot.profileStats.events.length === 0 ? "complete" : "lowerBound"
    );
  const events = lifetime.entries;
  const updateEvents = events.filter(isProfileUpdateEvent);
  const sourceMix = buildProfileSourceMix(updateEvents);
  const favorite = sourceMix.reduce((best, item) => (item.count > best.count ? item : best));
  const topApps = buildTopUpdatedApps(events, snapshot.apps);
  const topHomebrewItems = buildTopUpdatedHomebrewItems(
    events,
    snapshot.homebrewItems,
    snapshot.apps
  );
  const totalUpdates = updateEvents.reduce((total, event) => total + event.count, 0);
  const differentApps = new Set(
    events.filter((event) => event.type === "appUpdate").map((event) => event.targetID)
  ).size;
  const discoverInstalls = events
    .filter((event) => event.type === "homebrewInstall")
    .reduce((total, event) => total + event.count, 0);
  const favoriteChannelLabel = favorite.count > 0 ? favorite.label : "No history";
  return {
    incompleteHistory: lifetime.coverage === "lowerBound",
    differentApps,
    discoverInstalls,
    totalUpdates,
    startedUsing: startedUsingSummary(snapshot.profileStats.startedUsingAt),
    favoriteChannelLabel,
    sourceMix,
    topApps,
    topHomebrewItems
  };
}

export function profileSourceClass(channel: ProfileStatsChannel): string {
  if (channel === "appStore") return "source-app-store";
  if (channel === "sparkle") return "source-sparkle";
  if (channel === "homebrew") return "source-homebrew";
  if (channel === "web") return "source-web";
  return "source-unknown";
}

export function profileSourceShareLabel(
  source: ProfileSummary["sourceMix"][number],
  total: number
): string {
  if (total <= 0) {
    return `${source.label}: no recorded updates`;
  }
  const percent = Math.round((source.count / total) * 100);
  return `${source.label}: ${source.count} update${source.count === 1 ? "" : "s"} (${percent}%)`;
}

export function profileSourcePercentLabel(
  source: ProfileSummary["sourceMix"][number],
  total: number
): string {
  if (total <= 0) {
    return "0%";
  }
  return `${Math.round((source.count / total) * 100)}%`;
}

export function profileSourceCountLabel(source: ProfileSummary["sourceMix"][number]): string {
  return `${source.count} update${source.count === 1 ? "" : "s"} via ${source.label}`;
}

export function isProfileUpdateEvent(event: SummaryEvent): boolean {
  return event.type === "appUpdate" || event.type === "homebrewUpdate";
}

export function buildProfileSourceMix(events: SummaryEvent[]): ProfileSummary["sourceMix"] {
  const channels: ProfileStatsChannel[] = ["appStore", "sparkle", "homebrew", "web", "unknown"];
  const counts = new Map<ProfileStatsChannel, number>(channels.map((channel) => [channel, 0]));
  for (const event of events) {
    counts.set(event.channel, (counts.get(event.channel) ?? 0) + (event.count ?? 1));
  }
  return channels
    .map((channel) => ({
      channel,
      label: sourceDisplayName(channel),
      count: counts.get(channel) ?? 0
    }))
    .sort((first, second) => second.count - first.count || first.label.localeCompare(second.label));
}

export function buildTopUpdatedApps(
  events: SummaryEvent[],
  apps: AppRecord[]
): ProfileSummary["topApps"] {
  const appByID = new Map(apps.map((app) => [app.id, app]));
  const counts = new Map<
    string,
    { targetID: string; displayName: string; count: number; iconDataURL?: string; rank: number }
  >();
  for (const event of events) {
    if (event.type !== "appUpdate") {
      continue;
    }
    const current = counts.get(event.targetID);
    const app = appByID.get(event.targetID);
    counts.set(event.targetID, {
      targetID: event.targetID,
      displayName: app?.displayName ?? event.displayName,
      count: (current?.count ?? 0) + (event.count ?? 1),
      iconDataURL: app?.iconDataURL,
      rank: 0
    });
  }
  return [...counts.values()]
    .sort(
      (first, second) =>
        second.count - first.count || first.displayName.localeCompare(second.displayName)
    )
    .slice(0, 3)
    .map((app, index) => ({ ...app, rank: index + 1 }));
}

export function buildTopUpdatedHomebrewItems(
  events: SummaryEvent[],
  homebrewItems: HomebrewManagedItem[],
  apps: AppRecord[]
): ProfileSummary["topHomebrewItems"] {
  const itemsByID = new Map(homebrewItems.map((item) => [item.id, item]));
  const counts = new Map<
    string,
    {
      targetID: string;
      displayName: string;
      count: number;
      kindLabel: string;
      rank: number;
    }
  >();
  for (const event of events) {
    if (event.type !== "homebrewUpdate") {
      continue;
    }
    const item = itemsByID.get(event.targetID);
    if (!isProfileHomebrewToolEvent(event, item, apps)) {
      continue;
    }
    const current = counts.get(event.targetID);
    counts.set(event.targetID, {
      targetID: event.targetID,
      displayName: item?.name ?? event.displayName,
      count: (current?.count ?? 0) + (event.count ?? 1),
      kindLabel: profileHomebrewKindLabel(event, item),
      rank: 0
    });
  }
  return [...counts.values()]
    .sort(
      (first, second) =>
        second.count - first.count || first.displayName.localeCompare(second.displayName)
    )
    .slice(0, 3)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

export function isProfileHomebrewToolEvent(
  event: SummaryEvent,
  item: HomebrewManagedItem | undefined,
  apps: AppRecord[]
): boolean {
  if (item?.kind === "formula" || event.targetID.startsWith("formula:")) {
    return true;
  }
  if (!item) {
    return false;
  }
  if (homebrewItemHasAppRepresentation(item, apps)) {
    return false;
  }
  if (item.presentation === "app") {
    return false;
  }
  return Boolean(item.presentation);
}

export function profileHomebrewKindLabel(
  event: SummaryEvent,
  item: HomebrewManagedItem | undefined
): string {
  if (item?.presentation) {
    return homebrewPresentationLabel(item.kind, item.presentation);
  }
  if (item?.kind === "formula" || event.targetID.startsWith("formula:")) {
    return "Formula";
  }
  return "Tool";
}

export function startedUsingSummary(createdAt: string): ProfileSummary["startedUsing"] {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) {
    return {
      relativeLabel: "Today",
      dateLabel: "Since today"
    };
  }
  const createdDate = new Date(created);
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  const exactDate = dateFormatter.format(createdDate);
  const elapsedDays = Math.max(0, localCalendarDay(new Date()) - localCalendarDay(createdDate));
  const relativeLabel =
    elapsedDays === 0 ? "Today" : `${elapsedDays} day${elapsedDays === 1 ? "" : "s"}`;
  return {
    relativeLabel,
    dateLabel: `Since ${exactDate}`
  };
}
