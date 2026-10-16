// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Commands run in their own POSIX session/group on macOS. Keep the caller's
 * reservation until the entire group has exited, including inherited pipes.
 * Deliberately daemonized processes that create a new session are outside this
 * boundary; this runner is for foreground CLI commands, not service launchers. */
export async function terminateCommandGroup(child: ChildProcess, graceMs: number): Promise<void> {
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
  if (!signal("SIGTERM")) return;
  const deadline = performance.now() + graceMs;
  while (signal(0) && performance.now() < deadline) await delay(20);
  if (!signal(0)) return;
  signal("SIGKILL");
  // Do not report settlement (and permit lock release) while descendants remain.
  while (signal(0)) await delay(20);
}
