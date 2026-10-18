// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { ProfileStatsAggregate, ProfileStatsEvent, ProfileStatsLifetime } from "./domain";

// Retain one counter per target/type/source, independently of bounded event details.
export function addProfileStatsEvents(
  lifetime: ProfileStatsLifetime,
  events: ProfileStatsEvent[]
): ProfileStatsLifetime {
  const key = (entry: ProfileStatsAggregate) =>
    JSON.stringify([entry.type, entry.targetID, entry.channel]);
  const entries = new Map(lifetime.entries.map((entry) => [key(entry), { ...entry }]));
  for (const event of events) {
    const identity = key({ ...event, count: 1 });
    const previous = entries.get(identity);
    entries.set(identity, {
      type: event.type,
      targetID: event.targetID,
      displayName: event.displayName,
      channel: event.channel,
      count: (previous?.count ?? 0) + 1
    });
  }
  return { coverage: lifetime.coverage, entries: [...entries.values()] };
}

export function profileStatsLifetimeFromEvents(
  events: ProfileStatsEvent[],
  coverage: ProfileStatsLifetime["coverage"] = "lowerBound"
): ProfileStatsLifetime {
  return addProfileStatsEvents({ coverage, entries: [] }, events);
}
