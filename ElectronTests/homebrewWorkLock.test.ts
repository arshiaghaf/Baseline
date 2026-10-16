// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { HomebrewWorkLock } from "../src/main/homebrewWorkLock";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createLock() {
  let otherMutation = false;
  const changes = vi.fn();
  const releases = vi.fn();
  const lock = new HomebrewWorkLock<string>({
    hasOtherMutation: () => otherMutation,
    onLockStateChange: changes,
    onCommandReleased: releases
  });
  return { lock, changes, releases, setOtherMutation: (value: boolean) => (otherMutation = value) };
}

describe("HomebrewWorkLock", () => {
  it("keeps the command reservation through a refresh, and releases it only once", () => {
    const { lock, releases } = createLock();
    const release = lock.reserveCommand();
    expect(release).toBeDefined();
    expect(lock.activeCommandCount).toBe(1);
    expect(lock.isCommandLocked).toBe(true);
    expect(lock.isCleanupLocked).toBe(true);

    lock.beginRefresh(1);
    expect(lock.reserveCommand()).toBeUndefined();
    expect(lock.endRefresh(1)).toBe(true);
    expect(lock.isCommandLocked).toBe(true);
    release?.();
    release?.();
    expect(lock.activeCommandCount).toBe(0);
    expect(releases).toHaveBeenCalledTimes(1);
    expect(lock.isCommandLocked).toBe(false);
  });

  it("allows cleanup to supersede a refresh, but not an inventory read or mutation", async () => {
    const { lock, setOtherMutation } = createLock();
    lock.beginRefresh(4);
    const gate = deferred<string>();
    let releaseCleanup: (() => void) | undefined;
    let pending: Promise<string> | undefined;
    try {
      expect(lock.reserveCommand()).toBeUndefined();
      expect(lock.isCleanupLocked).toBe(false);
      releaseCleanup = lock.reserveCommand({ allowRefreshSupersession: true });
      expect(releaseCleanup).toBeDefined();
      releaseCleanup?.();

      pending = lock.readInventory({
        updateMetadata: false,
        allowDuringMutation: false,
        blocked: () => "blocked",
        start: () => gate.promise,
        reconcileBeforeRelease: () => undefined,
        invalidateBeforeRelease: () => undefined
      });
      expect(lock.reserveCommand({ allowRefreshSupersession: true })).toBeUndefined();
      gate.resolve("fresh");
      expect(await pending).toBe("fresh");

      setOtherMutation(true);
      expect(lock.reserveCommand({ allowRefreshSupersession: true })).toBeUndefined();
      setOtherMutation(false);
      expect(lock.endRefresh(3)).toBe(false);
      expect(lock.isCommandLocked).toBe(true);
      expect(lock.endRefresh(4)).toBe(true);
      expect(lock.isCommandLocked).toBe(false);
    } finally {
      gate.resolve("fresh");
      if (pending) await pending;
      releaseCleanup?.();
      setOtherMutation(false);
      lock.endRefresh(4);
    }
  });

  it("shares an inventory task and escalates to a metadata read when needed", async () => {
    const { lock } = createLock();
    const basic = deferred<string>();
    const metadata = deferred<string>();
    const starts: boolean[] = [];
    const reconciled: string[] = [];
    const read = (updateMetadata: boolean) =>
      lock.readInventory({
        updateMetadata,
        allowDuringMutation: false,
        blocked: () => "blocked",
        start: (metadataRequested) => {
          starts.push(metadataRequested);
          return metadataRequested ? metadata.promise : basic.promise;
        },
        reconcileBeforeRelease: (result) => reconciled.push(result),
        invalidateBeforeRelease: () => undefined
      });

    const first = read(false);
    const shared = read(false);
    const escalated = read(true);
    try {
      expect(starts).toEqual([false]);
      expect(lock.isCleanupLocked).toBe(true);
      basic.resolve("basic");
      expect(await first).toBe("basic");
      expect(await shared).toBe("basic");
      expect(starts).toEqual([false, true]);
      expect(lock.isCleanupLocked).toBe(true);
      metadata.resolve("metadata");
      expect(await escalated).toBe("metadata");
      expect(reconciled).toEqual(["basic", "metadata"]);
      expect(lock.isCleanupLocked).toBe(false);
    } finally {
      basic.resolve("basic");
      metadata.resolve("metadata");
      await Promise.allSettled([first, shared, escalated]);
    }
  });

  it("reconciles a failed read before freeing its inventory reservation", async () => {
    const { lock, setOtherMutation } = createLock();
    const gate = deferred<string>();
    let lockedDuringInvalidation = false;
    const pending = lock.readInventory({
      updateMetadata: true,
      allowDuringMutation: false,
      blocked: () => "blocked",
      start: () => gate.promise,
      reconcileBeforeRelease: () => undefined,
      invalidateBeforeRelease: () => {
        lockedDuringInvalidation = lock.isCleanupLocked;
      }
    });
    try {
      gate.reject(new Error("inventory failed"));
      await expect(pending).rejects.toThrow("inventory failed");
      expect(lockedDuringInvalidation).toBe(true);
      expect(lock.isCleanupLocked).toBe(false);

      setOtherMutation(true);
      expect(
        await lock.readInventory({
          updateMetadata: false,
          allowDuringMutation: false,
          blocked: () => "saved state",
          start: () => Promise.resolve("fresh"),
          reconcileBeforeRelease: () => undefined,
          invalidateBeforeRelease: () => undefined
        })
      ).toBe("saved state");
    } finally {
      gate.reject(new Error("inventory failed"));
      await Promise.allSettled([pending]);
      setOtherMutation(false);
    }
  });
});
