// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { cleanupApplications } from "../e2e/applicationCleanup";

const children = new Set<ChildProcess>();

function killDetachedGroup(child: ChildProcess) {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function startChild(withDescendant = false) {
  const script = withDescendant
    ? "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.send(child.pid); setInterval(() => {}, 1000);"
    : "process.on('message', () => process.exit(0)); process.send('ready'); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  children.add(child);
  const [message] = await once(child, "message");
  return { child, descendantPID: withDescendant ? Number(message) : undefined };
}

function gracefulApplication(child: ChildProcess) {
  return {
    process: () => child,
    close: async () => {
      const exited = once(child, "exit");
      child.send("quit");
      await exited;
    }
  };
}

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      killDetachedGroup(child);
      await exited;
    })
  );
  children.clear();
});

test("reports a hung shutdown after draining its tree and other owned apps without killing unrelated processes", async () => {
  const { child: stalled, descendantPID } = await startChild(true);
  const { child: healthy } = await startChild();
  const { child: unrelated } = await startChild();
  try {
    await expect(
      cleanupApplications(
        [
          { process: () => stalled, close: () => new Promise<void>(() => undefined) },
          gracefulApplication(healthy)
        ],
        undefined,
        100
      )
    ).rejects.toMatchObject({ message: expect.stringContaining("graceful close exceeded") });
    expect(stalled.signalCode).toBe("SIGKILL");
    expect(healthy.exitCode).toBe(0);
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
    await expect
      .poll(() => {
        try {
          process.kill(descendantPID!, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw error;
        }
      })
      .toBe(false);
  } finally {
    // Retain cleanup even if a regression kills only the parent.
    killDetachedGroup(stalled);
  }
});

test("an exit race retains a close error after all owned applications have been drained", async () => {
  const { child: failed } = await startChild();
  const { child: healthy } = await startChild();
  const closeError = new Error("Fixture close failed");
  const originalKill = process.kill.bind(process);
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -failed.pid! && signal === "SIGKILL") {
      failed.kill("SIGKILL");
      throw Object.assign(new Error("Process group already exited"), { code: "ESRCH" });
    }
    return originalKill(pid, signal);
  });
  try {
    await expect(
      cleanupApplications(
        [
          {
            process: () => failed,
            close: async () => {
              throw closeError;
            }
          },
          gracefulApplication(healthy)
        ],
        undefined,
        100
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining(closeError.message),
      errors: [closeError]
    });
    expect(failed.signalCode).toBe("SIGKILL");
    expect(healthy.exitCode).toBe(0);
  } finally {
    kill.mockRestore();
  }
});
