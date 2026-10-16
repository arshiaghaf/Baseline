// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { RefreshLifecycle } from "../src/main/refreshLifecycle";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("RefreshLifecycle", () => {
  it("makes a superseded caller await the winning full refresh", async () => {
    const first = deferred();
    const second = deferred();
    const generations: number[] = [];
    const lifecycle = new RefreshLifecycle(
      async (_lightweight, generation) => {
        generations.push(generation);
        await (generation === 1 ? first.promise : second.promise);
      },
      () => undefined
    );
    const firstCaller = lifecycle.refresh(false, {});
    const secondCaller = lifecycle.refresh(false, {});
    expect(lifecycle.isCurrent(generations[0]!)).toBe(false);
    expect(lifecycle.isCurrent(generations[1]!)).toBe(true);
    let firstFinished = false;
    void firstCaller.then(() => {
      firstFinished = true;
    });
    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(firstFinished).toBe(false);
    second.resolve();
    await Promise.all([firstCaller, secondCaller]);
    expect(firstFinished).toBe(true);
  });

  it("replays full refresh after cleanup but coalesces lightweight refresh", async () => {
    const calls: boolean[] = [];
    const lifecycle = new RefreshLifecycle(
      async (lightweight) => {
        calls.push(lightweight);
      },
      () => undefined
    );
    const reservation = lifecycle.beginCleanup();
    const full = lifecycle.refresh(false, {});
    const light = lifecycle.refresh(true, {});
    expect(lifecycle.wasRefreshRequestedDuringCleanup).toBe(true);
    expect(calls).toEqual([]);
    reservation.finish();
    await Promise.all([full, light]);
    expect(calls).toEqual([false]);
  });

  it("lets cleanup supersede a generation and invalidates work on quit", async () => {
    const active = deferred();
    let firstSignal!: AbortSignal;
    const lifecycle = new RefreshLifecycle(
      async (_lightweight, _generation, _options, signal) => {
        firstSignal = signal;
        await active.promise;
      },
      () => undefined
    );
    const refresh = lifecycle.refresh(false, {});
    const reservation = lifecycle.beginCleanup();
    expect(reservation.refreshWasActive).toBe(true);
    await lifecycle.runCleanupGeneration(async (generation, signal) => {
      expect(firstSignal.aborted).toBe(true);
      expect(lifecycle.isCurrent(generation)).toBe(true);
      lifecycle.stop();
      expect(signal.aborted).toBe(true);
      expect(lifecycle.isCurrent(generation)).toBe(false);
    });
    reservation.finish();
    active.resolve();
    await refresh;
  });

  it("uses a lightweight timer and replaces it when preferences change", async () => {
    vi.useFakeTimers();
    const autoRefresh = vi.fn();
    const lifecycle = new RefreshLifecycle(async () => undefined, autoRefresh);
    lifecycle.restartAutoRefreshLoop(true, 5);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(autoRefresh).toHaveBeenCalledTimes(1);
    lifecycle.restartAutoRefreshLoop(true, 10);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(autoRefresh).toHaveBeenCalledTimes(1);
    lifecycle.stop();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(autoRefresh).toHaveBeenCalledTimes(1);
  });
});
