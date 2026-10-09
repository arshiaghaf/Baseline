// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { randomBytes } from "node:crypto";
import os from "node:os";
import { runCommand, type CommandResult } from "./commandRunner";
import { ProfileStatsIntegrityService } from "./profileStatsIntegrityService";

export type { ProfileStatsIntegrity } from "./profileStatsIntegrityService";

const securityExecutablePath = "/usr/bin/security";
const serviceName = "Baseline Profile Stats";
const accountName = os.userInfo().username || "local";

// Production always obtains its integrity secret from the macOS Keychain.
export class KeychainProfileStatsIntegrity extends ProfileStatsIntegrityService {
  constructor() {
    super(keychainSecret);
  }
}

async function keychainSecret(): Promise<string> {
  const existing = await runCommand(securityExecutablePath, [
    "find-generic-password",
    "-s",
    serviceName,
    "-a",
    accountName,
    "-w"
  ]);
  const secret = existing.stdout?.trim();
  if (existing.success && secret) {
    return secret;
  }
  if (!isMissingKeychainSecret(existing)) {
    throw new Error("Profile stats Keychain secret could not be read.");
  }

  const generated = randomBytes(32).toString("base64url");
  const created = await runCommand(securityExecutablePath, [
    "add-generic-password",
    "-s",
    serviceName,
    "-a",
    accountName,
    "-w",
    generated
  ]);
  if (!created.success) {
    throw new Error("Profile stats Keychain secret could not be created.");
  }
  return generated;
}

function isMissingKeychainSecret(result: CommandResult): boolean {
  const output = [result.stdout, result.stderr, result.output]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return result.status === 44 || output.includes("specified item could not be found");
}
