// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { ChildProcess } from "node:child_process";

type OwnedApplication = {
  process(): ChildProcess;
  close(): Promise<void>;
};

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

// Only applications launched by this test are eligible for the bounded fallback.
// Always attempt every application, even when one close rejects or stalls.
export async function cleanupApplications<Application extends OwnedApplication>(
  applications: Iterable<Application>,
  release?: (application: Application) => Promise<void>,
  timeoutMilliseconds = 5000
): Promise<void> {
  const results = await Promise.allSettled(
    [...applications].map(async (application) => {
      const child = application.process();
      const hasExited = () => child.exitCode !== null || child.signalCode !== null;
      let onExit: (() => void) | undefined;
      const exited = new Promise<void>((resolve) => {
        if (hasExited()) resolve();
        else {
          onExit = resolve;
          child.once("exit", onExit);
        }
      });
      try {
        const closing = (async () => {
          await release?.(application);
          await application.close();
        })();
        const result = await settledWithin(closing, timeoutMilliseconds);
        if (result.status !== "fulfilled" && !hasExited()) child.kill("SIGKILL");
        if ((await settledWithin(exited, timeoutMilliseconds)).status === "timeout") {
          throw new Error(`Test-owned application ${child.pid} did not exit; retain its fixtures.`);
        }
        if (result.status === "rejected") throw result.reason;
      } finally {
        if (onExit) child.removeListener("exit", onExit);
      }
    })
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length) throw new AggregateError(failures, "Test application cleanup failed.");
}
