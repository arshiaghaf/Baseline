// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { ProfileStatsAggregate, ProfileStatsEvent, ProfileStatsLifetime } from "./domain";

// Retain one counter per target/type/source, independently of bounded event details.
// Cardinality grows with distinct identities; exact unique counts cannot use a fixed entry cap.
export function profileStatsCountsAreSafe(entries: ProfileStatsAggregate[]): boolean {
  if (!Array.isArray(entries)) return false;
  let total = 0;
  const identities = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return false;
    const identity = JSON.stringify([entry.type, entry.targetID, entry.channel]);
    if (
      !Number.isSafeInteger(entry.count) ||
      entry.count <= 0 ||
      total > Number.MAX_SAFE_INTEGER - entry.count ||
      identities.has(identity)
    )
      return false;
    total += entry.count;
    identities.add(identity);
  }
  return true;
}

export function addProfileStatsEvents(
  lifetime: ProfileStatsLifetime,
  events: ProfileStatsEvent[]
): ProfileStatsLifetime {
  if (!profileStatsCountsAreSafe(lifetime.entries)) {
    throw new RangeError("Profile history counts exceed the supported numeric range.");
  }
  const total = lifetime.entries.reduce((sum, entry) => sum + entry.count, 0);
  if (events.length > Number.MAX_SAFE_INTEGER - total) {
    throw new RangeError("Profile history counts exceed the supported numeric range.");
  }
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
