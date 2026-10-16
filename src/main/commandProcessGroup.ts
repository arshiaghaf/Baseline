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
  let permissionError: NodeJS.ErrnoException | undefined;
  const signal = (value: NodeJS.Signals | 0): boolean | undefined => {
    try {
      process.kill(-pid, value);
      return true;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (failure.code === "ESRCH") return false;
      // Darwin killpg can return EPERM for a group containing only unreaped
      // zombies. This is uncertainty, never absence: re-probe within the same
      // budget and require ESRCH before reporting confirmed cleanup.
      if (failure.code === "EPERM") {
        permissionError = failure;
        return undefined;
      }
      throw error;
    }
  };
  const cleanupDeadline = performance.now() + cleanupTimeoutMs;
  const graceDeadline = Math.min(cleanupDeadline, performance.now() + graceMs);
  if (signal("SIGTERM") === false) return;
  let forced = false;
  while (true) {
    if (signal(0) === false) return;
    const now = performance.now();
    if (!forced && now >= graceDeadline) {
      forced = true;
      if (signal("SIGKILL") === false) return;
    }
    if (now >= cleanupDeadline) {
      throw (
        permissionError ??
        Object.assign(
          new Error("Process group cleanup could not be confirmed within its budget."),
          { code: "ETIMEDOUT" }
        )
      );
    }
    await delay(Math.min(20, Math.max(1, cleanupDeadline - performance.now())));
  }
}
