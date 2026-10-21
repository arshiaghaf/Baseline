// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanupApplications,
  observeApplicationCleanup,
  runWithCleanup
} from "../e2e/applicationCleanup";

import { requestElectronQuit } from "../e2e/electronLifecycleDiagnostics";

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
  const stalledApplication = {
    process: () => stalled,
    close: () => new Promise<void>(() => undefined)
  };
  const phases: string[] = [];
  const stopObserving = observeApplicationCleanup(stalledApplication, (event) => {
    phases.push(event.phase);
    if (event.phase === "cleanup-start") throw new Error("Diagnostic failure");
  });
  try {
    await expect(
      cleanupApplications([stalledApplication, gracefulApplication(healthy)], undefined, 100)
    ).rejects.toMatchObject({ message: expect.stringContaining("graceful close exceeded") });
    expect(phases).toEqual(
      expect.arrayContaining([
        "playwright-close-start",
        "close-timeout",
        "force-kill-sent",
        "process-exit-confirmed",
        "cleanup-finished"
      ])
    );
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
    stopObserving();
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
    // This case verifies error retention, not a shutdown deadline. Give the
    // healthy IPC child the helper's normal graceful-close budget under CI load.
    await expect(
      cleanupApplications([
        {
          process: () => failed,
          close: async () => {
            throw closeError;
          }
        },
        gracefulApplication(healthy)
      ])
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

test("retains the original body failure alongside cleanup failure, including thrown undefined", async () => {
  const bodyError = new Error("Original assertion failed");
  const cleanupError = new Error("Shutdown failed");
  for (const original of [bodyError, undefined]) {
    await expect(
      runWithCleanup(
        async () => {
          throw original;
        },
        async () => {
          throw cleanupError;
        }
      )
    ).rejects.toMatchObject({ errors: [original, cleanupError] });
  }
  await expect(
    runWithCleanup(
      async () => {
        throw bodyError;
      },
      async () => {}
    )
  ).rejects.toBe(bodyError);
  await expect(
    runWithCleanup(
      async () => 42,
      async () => {
        throw cleanupError;
      }
    )
  ).rejects.toBe(cleanupError);
});

test.each([
  { message: "Protocol quit invocation failed", expectedDisconnect: false },
  { message: "Execution context was destroyed", expectedDisconnect: true }
])(
  "explicit quit preserves failure and drains the owned process: $message",
  async ({ message, expectedDisconnect }) => {
    const { child } = await startChild();
    const quitError = new Error(message);
    const application = {
      process: () => child,
      close: () => new Promise<void>(() => undefined),
      evaluate: async () => {
        throw quitError;
      },
      waitForEvent: () => new Promise<void>((resolve) => child.once("close", resolve))
    };
    const cleanup = cleanupApplications([application], requestElectronQuit, 100);
    if (expectedDisconnect) {
      // A disconnection alone must not turn a still-running child into success.
      await expect(cleanup).rejects.toMatchObject({
        message: expect.stringContaining("graceful close exceeded")
      });
    } else {
      await expect(cleanup).rejects.toMatchObject({ errors: [quitError] });
    }
    expect(child.signalCode).toBe("SIGKILL");
  }
);
