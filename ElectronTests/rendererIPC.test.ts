// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaselineSnapshot } from "../src/shared/domain";
import type { BaselineAPI } from "../src/shared/ipc";

describe("renderer IPC forwarding", () => {
  let original: PropertyDescriptor | undefined;
  let current: BaselineAPI;
  let reads: number;

  beforeEach(() => {
    vi.resetModules();
    original = Object.getOwnPropertyDescriptor(window, "baseline");
    reads = 0;
    Object.defineProperty(window, "baseline", {
      configurable: true,
      get() {
        reads += 1;
        return current;
      }
    });
  });

  afterEach(() => {
    if (original) Object.defineProperty(window, "baseline", original);
    else Reflect.deleteProperty(window, "baseline");
  });

  it("resolves the bridge at invocation and preserves receiver and promise identity", async () => {
    const { baseline } = await import("../src/renderer/ipc");
    expect(reads).toBe(0);

    const firstResult = Promise.resolve({} as BaselineSnapshot);
    const first = {
      getSnapshot: vi.fn(function (this: BaselineAPI) {
        expect(this).toBe(first);
        return firstResult;
      })
    } as unknown as BaselineAPI;
    current = first;
    expect(baseline.getSnapshot()).toBe(firstResult);

    const secondResult = Promise.resolve({} as BaselineSnapshot);
    const second = {
      getSnapshot: vi.fn(function (this: BaselineAPI) {
        expect(this).toBe(second);
        return secondResult;
      })
    } as unknown as BaselineAPI;
    current = second;
    expect(baseline.getSnapshot()).toBe(secondResult);
    expect(reads).toBe(2);
    expect(first.getSnapshot).toHaveBeenCalledOnce();
    expect(second.getSnapshot).toHaveBeenCalledOnce();
  });

  it("preserves omitted optional arguments and original argument objects", async () => {
    const { baseline } = await import("../src/renderer/ipc");
    current = {
      refresh: vi.fn(async () => {}),
      performHomebrewUpdateAll: vi.fn(async () => {}),
      updatePreferences: vi.fn(async () => {})
    } as unknown as BaselineAPI;
    const ids = ["cask:example"];
    const patch = { showDockIcon: false };
    await baseline.refresh();
    await baseline.refresh(false);
    await baseline.performHomebrewUpdateAll(ids);
    await baseline.updatePreferences(patch);

    expect(current.refresh).toHaveBeenNthCalledWith(1);
    expect(current.refresh).toHaveBeenNthCalledWith(2, false);
    expect(vi.mocked(current.performHomebrewUpdateAll).mock.calls[0]?.[0]).toBe(ids);
    expect(vi.mocked(current.updatePreferences).mock.calls[0]?.[0]).toBe(patch);
  });

  it("returns the original unsubscribe functions and forwards callbacks unchanged", async () => {
    const { baseline } = await import("../src/renderer/ipc");
    const snapshotCallback = vi.fn();
    const progressCallback = vi.fn();
    const unsubscribeSnapshot = vi.fn();
    const unsubscribeProgress = vi.fn();
    current = {
      onSnapshotChanged: vi.fn(() => unsubscribeSnapshot),
      onSnapshotProgress: vi.fn(() => unsubscribeProgress)
    } as unknown as BaselineAPI;

    expect(baseline.onSnapshotChanged(snapshotCallback)).toBe(unsubscribeSnapshot);
    expect(baseline.onSnapshotProgress(progressCallback)).toBe(unsubscribeProgress);
    expect(current.onSnapshotChanged).toHaveBeenCalledWith(snapshotCallback);
    expect(current.onSnapshotProgress).toHaveBeenCalledWith(progressCallback);
    expect(unsubscribeSnapshot).not.toHaveBeenCalled();
    expect(unsubscribeProgress).not.toHaveBeenCalled();
  });

  it("preserves rejections and synchronous errors without retrying", async () => {
    const { baseline } = await import("../src/renderer/ipc");
    const error = new Error("Bridge unavailable");
    const rejected = Promise.reject(error);
    void rejected.catch(() => undefined);
    current = {
      openExternal: vi.fn(() => rejected),
      performAppUpdate: vi.fn(() => {
        throw error;
      })
    } as unknown as BaselineAPI;

    expect(baseline.openExternal("https://example.com")).toBe(rejected);
    await expect(rejected).rejects.toBe(error);
    expect(() => baseline.performAppUpdate("app:example")).toThrow(error);
    expect(current.openExternal).toHaveBeenCalledOnce();
    expect(current.performAppUpdate).toHaveBeenCalledOnce();
  });
});
