// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, expect, it, vi } from "vitest";
import { reconcileScannedApps, testingExports } from "../src/main/scanReconciliation";
import type { AppRecord } from "../src/shared/domain";
import { version } from "../src/shared/version";

afterEach(() => vi.restoreAllMocks());
const app = (bundlePath: string): AppRecord => ({
  id: bundlePath,
  bundlePath,
  displayName: "Utility",
  localVersion: version("1"),
  sourceHint: "unknown"
});

it.each(["caller", "deadline"] as const)(
  "bounds prior identity resolution on %s cancellation and observes late rejection",
  async (cause) => {
    const caller = new AbortController();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let reject!: (error: Error) => void;
    const blocked = new Promise<string>((_, fail) => {
      reject = fail;
    });
    const resolve = vi.spyOn(testingExports.identityRuntime, "realpath").mockReturnValue(blocked);
    const old = [app("/old/Utility.app"), app("/another/Utility.app")];
    const fresh = app("/alias/Utility.app");
    const task = reconcileScannedApps(
      [fresh],
      old,
      old,
      new Map([[fresh.bundlePath, "/canonical/Utility.app"]]),
      [old[0]!.id],
      caller.signal
    );
    let result: Awaited<typeof task> | undefined;
    let failure: unknown;
    const observed = task.then(
      (value) => {
        result = value;
      },
      (error: unknown) => {
        failure = error;
      }
    );
    const reason = new Error("cancelled");
    try {
      (cause === "caller" ? caller : deadline).abort(reason);
      await vi.waitFor(() => expect(result !== undefined || failure !== undefined).toBe(true), {
        timeout: 200
      });
      if (cause === "caller") expect(failure).toBe(reason);
      else expect(result).toEqual({ scannedApps: [fresh], retainedApps: old });
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      reject(new Error("late IO failure"));
      await blocked.catch(() => {});
      await observed;
    }
  }
);
