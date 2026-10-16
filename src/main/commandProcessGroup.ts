// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Commands run in their own POSIX session/group on macOS. Keep the caller's
 * reservation until the group exits or cleanup is explicitly reported uncertain.
 * Deliberately daemonized processes that create a new session are outside this
 * boundary; this runner is for foreground CLI commands, not service launchers. */
export async function terminateCommandGroup(
  child: ChildProcess,
  graceMs: number,
  cleanupTimeoutMs = 3_000
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    // Baseline is macOS-only; do not imply Windows process-tree guarantees.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return;
  }
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, value);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  const cleanupDeadline = performance.now() + cleanupTimeoutMs;
  if (!signal("SIGTERM")) return;
  const deadline = Math.min(cleanupDeadline, performance.now() + graceMs);
  while (signal(0) && performance.now() < deadline) await delay(20);
  if (!signal(0)) return;
  signal("SIGKILL");
  while (signal(0)) {
    if (performance.now() >= cleanupDeadline) {
      const error = new Error("Process group cleanup could not be confirmed within its budget.");
      throw Object.assign(error, { code: "ETIMEDOUT" });
    }
    await delay(20);
  }
}
