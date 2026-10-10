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

async function startChild() {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('message', () => process.exit(0)); process.send('ready'); setInterval(() => {}, 1000);"
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }
  );
  children.add(child);
  await once(child, "message");
  return child;
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
      child.kill("SIGKILL");
      await exited;
    })
  );
  children.clear();
});

test("reports a stalled close after draining owned processes and leaves unrelated processes alive", async () => {
  const stalled = await startChild();
  const healthy = await startChild();
  const unrelated = await startChild();
  await expect(
    cleanupApplications(
      [
        { process: () => stalled, close: () => new Promise<void>(() => undefined) },
        gracefulApplication(healthy)
      ],
      undefined,
      100
    )
  ).rejects.toMatchObject({
    message: expect.stringContaining("graceful close exceeded"),
    errors: [
      expect.objectContaining({ message: expect.stringContaining("graceful close exceeded") })
    ]
  });
  expect(stalled.signalCode).toBe("SIGKILL");
  expect(healthy.exitCode).toBe(0);
  expect(unrelated.exitCode).toBeNull();
  expect(unrelated.signalCode).toBeNull();
});

test("reports a close failure after every owned process has exited", async () => {
  const failed = await startChild();
  const healthy = await startChild();
  await expect(
    cleanupApplications(
      [
        {
          process: () => failed,
          close: async () => {
            throw new Error("Fixture close failed");
          }
        },
        gracefulApplication(healthy)
      ],
      undefined,
      100
    )
  ).rejects.toThrow("Test application cleanup failed.");
  expect(failed.signalCode).toBe("SIGKILL");
  expect(healthy.exitCode).toBe(0);
});

test("a stalled detached application also releases its child processes", async () => {
  const parent = spawn(
    process.execPath,
    [
      "-e",
      "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.send(child.pid); setInterval(() => {}, 1000);"
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }
  );
  children.add(parent);
  const [descendantPID] = await once(parent, "message");
  try {
    await expect(
      cleanupApplications(
        [{ process: () => parent, close: () => new Promise<void>(() => undefined) }],
        undefined,
        100
      )
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: expect.stringContaining("graceful close exceeded") })
      ]
    });
    await expect
      .poll(() => {
        try {
          process.kill(descendantPID, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw error;
        }
      })
      .toBe(false);
  } finally {
    // Retain cleanup even if a regression kills only the parent.
    killDetachedGroup(parent);
  }
});

test("an exit during fallback termination preserves the original graceful-close failure", async () => {
  const child = await startChild();
  const healthy = await startChild();
  const originalKill = process.kill.bind(process);
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -child.pid! && signal === "SIGKILL") {
      child.kill("SIGKILL");
      throw Object.assign(new Error("Process group already exited"), { code: "ESRCH" });
    }
    return originalKill(pid, signal);
  });
  try {
    await expect(
      cleanupApplications(
        [
          { process: () => child, close: () => new Promise<void>(() => undefined) },
          gracefulApplication(healthy)
        ],
        undefined,
        100
      )
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: expect.stringContaining("graceful close exceeded") })
      ]
    });
    expect(child.signalCode).toBe("SIGKILL");
    expect(healthy.exitCode).toBe(0);
  } finally {
    kill.mockRestore();
  }
});
