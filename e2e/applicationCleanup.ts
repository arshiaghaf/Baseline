// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { ChildProcess } from "node:child_process";

type OwnedApplication = {
  process(): ChildProcess;
  close(): Promise<void>;
};

export type CleanupObservation = {
  phase: string;
  pid: number | undefined;
  executable: string;
  elapsedMs: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

const observers = new WeakMap<OwnedApplication, (event: CleanupObservation) => void>();

export function observeApplicationCleanup(
  application: OwnedApplication,
  observer: (event: CleanupObservation) => void
): () => void {
  observers.set(application, observer);
  return () => observers.delete(application);
}

// A throwing finally must not replace the original test failure.
export async function runWithCleanup<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<void>
): Promise<T> {
  let bodyFailed = false;
  let bodyError: unknown;
  let value: T;
  try {
    value = await body();
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (bodyFailed) {
      throw new AggregateError([bodyError, cleanupError], "Test body and cleanup both failed.", {
        cause: cleanupError
      });
    }
    throw cleanupError;
  }
  if (bodyFailed) throw bodyError;
  return value!;
}

async function settledWithin(promise: Promise<unknown>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason })
      ),
      new Promise<{ status: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" }), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Callers must own the child and its detached process group, as Playwright's
// Electron launcher does. Never pass an attached or externally owned process.
// Always attempt every application, even when one close rejects or stalls.
export async function cleanupApplications<Application extends OwnedApplication>(
  applications: Iterable<Application>,
  release?: (application: Application) => Promise<void>,
  timeoutMilliseconds = 5000
): Promise<void> {
  const results = await Promise.allSettled(
    [...applications].map(async (application) => {
      const child = application.process();
      const started = performance.now();
      const observe = (phase: string) => {
        try {
          observers.get(application)?.({
            phase,
            pid: child.pid,
            executable: child.spawnfile,
            elapsedMs: Math.round(performance.now() - started),
            exitCode: child.exitCode,
            signalCode: child.signalCode
          });
        } catch {
          // Diagnostics must never prevent ownership-checked process cleanup.
        }
      };
      const hasExited = () => child.exitCode !== null || child.signalCode !== null;
      let onClose: (() => void) | undefined;
      const exited = new Promise<void>((resolve) => {
        if (hasExited()) resolve();
        else {
          onClose = resolve;
          child.once("close", onClose);
        }
      });
      try {
        observe("cleanup-start");
        const closing = (async () => {
          observe("release-start");
          await release?.(application);
          observe("release-complete");
          observe("playwright-close-start");
          await application.close();
          observe("playwright-close-complete");
        })();
        const result = await settledWithin(closing, timeoutMilliseconds);
        observe(`close-${result.status}`);
        if (result.status !== "fulfilled" && !hasExited()) {
          try {
            observe("force-kill-start");
            if (process.platform === "win32") child.kill("SIGKILL");
            else if (child.pid) process.kill(-child.pid, "SIGKILL");
            observe("force-kill-sent");
          } catch (error) {
            // The process group can finish between the exit check and kill.
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        if ((await settledWithin(exited, timeoutMilliseconds)).status === "timeout") {
          observe("process-exit-timeout");
          throw new Error(`Test-owned application ${child.pid} did not exit; retain its fixtures.`);
        }
        observe("process-exit-confirmed");
        if (result.status === "rejected") throw result.reason;
        if (result.status === "timeout") {
          throw new Error(
            `Test-owned ${child.spawnfile.split("/").at(-1)} (${child.pid}) graceful close exceeded ${timeoutMilliseconds}ms.`
          );
        }
      } finally {
        observe("cleanup-finished");
        if (onClose) child.removeListener("close", onClose);
      }
    })
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length) {
    const detail = failures.map((reason) =>
      reason instanceof Error ? reason.message : String(reason)
    );
    throw new AggregateError(failures, `Test application cleanup failed. ${detail.join("; ")}`);
  }
}
