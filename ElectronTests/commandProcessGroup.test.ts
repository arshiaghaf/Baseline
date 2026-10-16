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
