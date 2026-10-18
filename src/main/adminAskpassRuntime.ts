// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import path from "node:path";
import { isValidHomebrewToken } from "../shared/security";
import { AdminAskpassCoordinator } from "./adminAskpassCoordinator";

let helperPath: string | undefined;
let configured = false;
let active: AdminAskpassSession | undefined;
let starting = false;

/** Main-process-only setup. Nothing currently calls this in app startup. Neither
 * renderer IPC nor inherited environment can provide or enable a helper path. */
export async function configureAdminAskpass(resourcePath: string): Promise<void> {
  if (active || starting) throw new Error("The administrator password helper is busy.");
  configured = true;
  helperPath = undefined;
  try {
    if (
      !path.isAbsolute(resourcePath) ||
      resourcePath.split(path.sep).some((part) => part.endsWith(".asar"))
    )
      return;
    const entry = await lstat(resourcePath);
    if (!entry.isFile()) return;
    await access(resourcePath, constants.X_OK);
    helperPath = resourcePath;
  } catch {
    /* A missing packaged helper is a command capability failure. */
  }
}

export function adminAskpassEligibleCommand(args: string[]): boolean {
  const verb = args[0];
  if (!["install", "upgrade", "uninstall"].includes(verb ?? "") || args[1] !== "--cask")
    return false;
  const start = verb === "upgrade" && args[2] === "--greedy" ? 3 : 2;
  return args.length > start && args.slice(start).every(isValidHomebrewToken);
}

export type AdminAskpassSession = {
  coordinator: AdminAskpassCoordinator;
  stop: AbortSignal;
  stopReason(): "cancelled" | "error" | undefined;
  environment: NodeJS.ProcessEnv;
};

export async function createAdminAskpassSession(
  args: string[],
  operation?: { operationID: string; onWaitingChanged(promptID: string | undefined): void }
): Promise<AdminAskpassSession | undefined> {
  if (!configured || !adminAskpassEligibleCommand(args)) return undefined;
  if (!operation || !helperPath || active || starting)
    throw new Error("The administrator password helper is unavailable.");
  const controller = new AbortController();
  let reason: "cancelled" | "error" | undefined;
  starting = true;
  let coordinator: AdminAskpassCoordinator;
  try {
    coordinator = await AdminAskpassCoordinator.create({
      ...operation,
      onStopRequested: (next) => {
        reason = next;
        controller.abort();
      }
    });
  } finally {
    starting = false;
  }
  const session: AdminAskpassSession = {
    coordinator,
    stop: controller.signal,
    stopReason: () => reason,
    environment: {
      SUDO_ASKPASS: helperPath,
      HOMEBREW_BASELINE_ASKPASS_SOCKET: coordinator.socketPath,
      HOMEBREW_BASELINE_ASKPASS_OPERATION: operation.operationID
    }
  };
  active = session;
  return session;
}

export function releaseAdminAskpassSession(session: AdminAskpassSession): void {
  if (active === session) active = undefined;
}

export function focusAdminAskpass(operationID: string, promptID: string): boolean {
  return active?.coordinator.focus(operationID, promptID) ?? false;
}
