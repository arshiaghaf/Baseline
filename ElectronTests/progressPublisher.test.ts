// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressPublisher } from "../src/main/progressPublisher";
import { applySnapshotProgress, type BaselineSnapshot } from "../src/shared/domain";

afterEach(() => vi.useRealTimers());
describe("progress propagation", () => {
  it("coalesces progress over 100ms and immediately delivers final progress", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const publisher = new ProgressPublisher(emit);
    publisher.publish({ homebrewBatchProgressByItemID: { "formula:example": 0.1 } }, 1, false);
    publisher.publish({ homebrewBatchProgressByItemID: { "formula:example": 0.2 } }, 2, false);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenLastCalledWith({
      fromRevision: 0,
      revision: 2,
      patch: { homebrewBatchProgressByItemID: { "formula:example": 0.2 } }
    });
    publisher.publish({ homebrewBatchProgressByItemID: { "formula:example": 0.9 } }, 3, false);
    publisher.publish({ homebrewBatchProgressByItemID: { "formula:example": 1 } }, 4, true);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith({
      fromRevision: 2,
      revision: 4,
      patch: { homebrewBatchProgressByItemID: { "formula:example": 1 } }
    });
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("a full snapshot cancels queued progress and resets the next delta's base", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const publisher = new ProgressPublisher(emit);
    publisher.publish({ homebrewDiscoverProgressByItemID: { "formula:example": 0.2 } }, 1, false);
    publisher.reset(2);
    vi.advanceTimersByTime(100);
    expect(emit).not.toHaveBeenCalled();
    publisher.publish({ homebrewDiscoverProgressByItemID: {} }, 3, false);
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenLastCalledWith({
      fromRevision: 2,
      revision: 3,
      patch: { homebrewDiscoverProgressByItemID: {} }
    });
  });

  it("preserves inventory references and rejects stale or missing-generation messages", () => {
    const snapshot = {
      snapshotRevision: 1,
      apps: [],
      homebrewItems: [],
      homebrewBatchProgressByItemID: {}
    } as unknown as BaselineSnapshot;
    const event = {
      fromRevision: 1,
      revision: 3,
      patch: { homebrewBatchProgressByItemID: { "formula:example": 0.6 } }
    };
    const applied = applySnapshotProgress(snapshot, event);
    expect(applied.needsResync).toBe(false);
    expect(applied.snapshot.apps).toBe(snapshot.apps);
    expect(applied.snapshot.homebrewItems).toBe(snapshot.homebrewItems);
    expect(applied.snapshot.homebrewBatchProgressByItemID).toEqual({ "formula:example": 0.6 });
    expect(applySnapshotProgress(applied.snapshot, event).snapshot).toBe(applied.snapshot);
    expect(applySnapshotProgress(snapshot, { ...event, fromRevision: 2 }).needsResync).toBe(true);
  });
});
