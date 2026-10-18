// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { realpath } from "node:fs/promises";
import type { AppRecord } from "../shared/domain";
import { cancellableRead, readSignal } from "./readCancellation";

const identityRuntime = { realpath };

// Resolve only uncertain prior paths. One shared budget bounds the whole extra
// reconciliation pass; unavailable identity evidence must never remove a record.
export async function reconcileScannedApps(
  scanned: AppRecord[],
  retained: AppRecord[],
  previous: AppRecord[],
  canonicalPaths: ReadonlyMap<string, string>,
  ignoredIDs: readonly string[],
  signal: AbortSignal
): Promise<{ scannedApps: AppRecord[]; retainedApps: AppRecord[] }> {
  const byCanonical = new Map<string, AppRecord[]>();
  const addIdentity = (app: AppRecord, canonical: string) => {
    const group = byCanonical.get(canonical) ?? [];
    group.push(app);
    byCanonical.set(canonical, group);
  };
  // The scanner also reports proven aliases skipped by its own deduplication.
  // Their roots may be healthy, so they need not appear among retained records.
  for (const app of previous) {
    const canonical = canonicalPaths.get(app.bundlePath);
    if (canonical) addIdentity(app, canonical);
  }
  const deadline = retained.length && canonicalPaths.size ? readSignal(signal) : undefined;
  for (const app of retained) {
    signal.throwIfAborted();
    if (canonicalPaths.has(app.bundlePath)) continue;
    if (!deadline || deadline.aborted) break;
    try {
      const canonical = await cancellableRead(identityRuntime.realpath(app.bundlePath), deadline);
      addIdentity(app, canonical);
    } catch {
      signal.throwIfAborted();
    }
  }
  const replaced = new Set<AppRecord>();
  const ignored = new Set(ignoredIDs);
  const scannedApps = scanned.map((app) => {
    const canonical = canonicalPaths.get(app.bundlePath);
    const aliases = canonical ? (byCanonical.get(canonical) ?? []) : [];
    const samePath = previous.find((item) => item.bundlePath === app.bundlePath);
    const candidates = samePath ? [samePath, ...aliases] : aliases;
    // Preserve any proven alias's ignore preference, including already duplicated
    // snapshots. Reuse identity only; fresh metadata controls source invalidation.
    const prior = candidates.find((item) => ignored.has(item.id)) ?? candidates[0];
    for (const alias of aliases) replaced.add(alias);
    return prior ? { ...app, id: prior.id } : app;
  });
  signal.throwIfAborted();
  return { scannedApps, retainedApps: retained.filter((app) => !replaced.has(app)) };
}

export const testingExports = { identityRuntime };
