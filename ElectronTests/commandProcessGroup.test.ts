// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { terminateCommandGroup } from "../src/main/commandProcessGroup";

afterEach(() => vi.restoreAllMocks());

it("bounds verification of a process group that persists after SIGKILL", async () => {
  // Every signal is intercepted; this fixture PID is never sent to the OS.
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const started = performance.now();
  await expect(terminateCommandGroup({ pid: 123456 } as ChildProcess, 5, 50)).rejects.toMatchObject(
    { code: "ETIMEDOUT" }
  );
  expect(performance.now() - started).toBeLessThan(500);
  expect(kill).toHaveBeenCalledWith(-123456, "SIGTERM");
  expect(kill).toHaveBeenCalledWith(-123456, "SIGKILL");
});

it("reports permission failures instead of confirming process-group cleanup", async () => {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("fixture permission failure"), { code: "EPERM" });
  });
  await expect(terminateCommandGroup({ pid: 123456 } as ChildProcess, 5, 50)).rejects.toMatchObject(
    { code: "EPERM" }
  );
});

it("waits through zombie-only EPERM after KILL and succeeds only on ESRCH", async () => {
  let killed = false;
  let deniedProbes = 0;
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === "SIGKILL") {
      killed = true;
      return true;
    }
    if (signal === 0 && killed) {
      if (deniedProbes++ < 2)
        throw Object.assign(new Error("fixture zombie group"), { code: "EPERM" });
      throw Object.assign(new Error("fixture reaped"), { code: "ESRCH" });
    }
    return true;
  });
  await expect(
    terminateCommandGroup({ pid: 123456 } as ChildProcess, 0, 200)
  ).resolves.toBeUndefined();
  expect(deniedProbes).toBe(3);
  expect(kill.mock.calls.map(([, signal]) => signal)).toEqual(["SIGTERM", 0, "SIGKILL", 0, 0, 0]);
  const count = kill.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(kill).toHaveBeenCalledTimes(count);
});

it("re-probes an initially zombie-only group without treating EPERM as absence", async () => {
  let probes = 0;
  const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0 && ++probes === 3)
      throw Object.assign(new Error("fixture reaped"), { code: "ESRCH" });
    throw Object.assign(new Error("fixture zombie group"), { code: "EPERM" });
  });
  await expect(
    terminateCommandGroup({ pid: 123456 } as ChildProcess, 100, 200)
  ).resolves.toBeUndefined();
  expect(probes).toBe(3);
  expect(kill).not.toHaveBeenCalledWith(-123456, "SIGKILL");
});

it.each(["SIGTERM", "probe", "SIGKILL"])(
  "stops signalling permanently after ESRCH at %s",
  async (stage) => {
    let absent = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (absent) throw new Error("Stale group signal after confirmed absence");
      if (
        (stage === "SIGTERM" && signal === "SIGTERM") ||
        (stage === "probe" && signal === 0) ||
        (stage === "SIGKILL" && signal === "SIGKILL")
      ) {
        absent = true;
        throw Object.assign(new Error("fixture absent"), { code: "ESRCH" });
      }
      return true;
    });
    await expect(
      terminateCommandGroup({ pid: 123456 } as ChildProcess, 0, 100)
    ).resolves.toBeUndefined();
    expect(absent).toBe(true);
    const count = kill.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(kill).toHaveBeenCalledTimes(count);
  }
);

it("does not signal an unlaunched process", async () => {
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  await terminateCommandGroup({ pid: undefined } as ChildProcess, 0, 50);
  expect(kill).not.toHaveBeenCalled();
});
