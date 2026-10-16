// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AdminAskpassCoordinator } from "../src/main/adminAskpassCoordinator";

describe.skipIf(process.platform !== "darwin")(
  "native helper/coordinator with a fake sudo policy",
  () => {
    let directory: string, helper: string, driver: string;
    beforeAll(async () => {
      directory = await mkdtemp("/tmp/baseline transport ");
      helper = path.join(directory, "fixture helper");
      driver = path.join(directory, "policy stand-in");
      execFileSync("/usr/bin/xcrun", [
        "clang",
        "-fobjc-arc",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-framework",
        "Foundation",
        "native/admin-askpass/main.m",
        "ElectronTests/Fixtures/adminAskpassDialog.m",
        "-o",
        helper
      ]);
      execFileSync("/usr/bin/xcrun", [
        "clang",
        "-Wall",
        "-Wextra",
        "-Werror",
        "ElectronTests/Fixtures/adminAskpassSudoFixture.c",
        "-o",
        driver
      ]);
    }, 90000);
    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it.each([
      ["correct", 0, 1, false, false],
      ["wrong-then-correct", 0, 2, false, false],
      ["exhaustion", 1, 5, false, false],
      ["cancel", 1, 1, true, false],
      ["cancel-after-rejection", 1, 2, true, false],
      ["empty", 1, 1, false, false],
      ["crash", 70, 1, false, true],
      ["cached", 0, 0, false, false],
      ["no-sudo", 0, 0, false, false]
    ] as const)(
      "handles %s without exposing a native answer to Node",
      async (scenario, status, prompts, cancelled, helperError) => {
        const waiting = vi.fn<(promptID: string | undefined) => void>();
        const stopped = vi.fn();
        const coordinator = await AdminAskpassCoordinator.create({
          operationID: "1".repeat(32),
          onWaitingChanged: waiting,
          onStopRequested: stopped
        });
        const child = spawn(driver, [helper, scenario], {
          detached: true,
          env: {
            HOMEBREW_BASELINE_ASKPASS_SOCKET: coordinator.socketPath,
            HOMEBREW_BASELINE_ASKPASS_OPERATION: "1".repeat(32)
          },
          stdio: ["ignore", "pipe", "pipe"]
        });
        const output: Buffer[] = [];
        child.stdout.on("data", (bytes: Buffer) => output.push(bytes));
        child.stderr.on("data", (bytes: Buffer) => output.push(bytes));
        const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Native policy fixture stalled.")), 5000);
          });
          expect(await Promise.race([closed, deadline])).toBe(status);
          await coordinator.prepareCleanup("command-exit", performance.now() + 1000);
          expect(await coordinator.finish(true)).toEqual({
            cancelled,
            helperError,
            cleanupConfirmed: true
          });
          expect(waiting.mock.calls.filter(([prompt]) => prompt !== undefined)).toHaveLength(
            prompts
          );
          expect(Buffer.concat(output)).toHaveLength(0);
          if (cancelled) expect(stopped).toHaveBeenCalledWith("cancelled");
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null && child.signalCode === null)
            process.kill(-child.pid!, "SIGKILL");
          await closed;
          await coordinator.finish(true);
        }
      },
      10000
    );
  }
);
