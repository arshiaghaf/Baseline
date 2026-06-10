// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { createHmac, randomBytes } from "node:crypto";
import os from "node:os";
import type { ProfileStats } from "../shared/domain";
import { defaultProfileStats, profileStatsSignatureVersion } from "../shared/domain";
import { runCommand } from "./commandRunner";

export type ProfileStatsIntegrity = {
  verifyOrInitialize(stats: ProfileStats): Promise<ProfileStats>;
  seal(stats: ProfileStats): Promise<ProfileStats>;
};

const securityExecutablePath = "/usr/bin/security";
const serviceName = "Baseline Profile Stats";
const accountName = os.userInfo().username || "local";

export class KeychainProfileStatsIntegrity implements ProfileStatsIntegrity {
  async verifyOrInitialize(stats: ProfileStats): Promise<ProfileStats> {
    try {
      const secret = await this.keychainSecret();
      if (!stats.signature) {
        if (stats.events.length > 0) {
          return { ...stats, integrityStatus: "unavailable" };
        }
        return sealProfileStats(stats, secret, "verified");
      }
      if (signatureFor(stats, secret) === stats.signature) {
        return normalizeProfileStatsSignature(stats, secret);
      }
      if (unversionedSignatureFor(stats, secret) === stats.signature) {
        return sealProfileStats(stats, secret, "verified");
      }
      if (legacySignatureFor(stats, secret) === stats.signature) {
        return sealProfileStats(
          {
            ...stats,
            startedUsingAt: stats.createdAt
          },
          secret,
          "verified"
        );
      }
      return sealProfileStats(defaultProfileStats(), secret, "resetAfterTamper");
    } catch {
      return { ...stats, integrityStatus: "unavailable" };
    }
  }

  async seal(stats: ProfileStats): Promise<ProfileStats> {
    try {
      return sealProfileStats(stats, await this.keychainSecret(), stats.integrityStatus);
    } catch {
      return { ...stats, integrityStatus: "unavailable" };
    }
  }

  private async keychainSecret(): Promise<string> {
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

    const generated = randomBytes(32).toString("base64url");
    const created = await runCommand(securityExecutablePath, [
      "add-generic-password",
      "-s",
      serviceName,
      "-a",
      accountName,
      "-w",
      generated,
      "-U"
    ]);
    if (!created.success) {
      throw new Error("Profile stats Keychain secret could not be created.");
    }
    return generated;
  }
}

function sealProfileStats(
  stats: ProfileStats,
  secret: string,
  integrityStatus: ProfileStats["integrityStatus"]
): ProfileStats {
  const sealed = { ...stats, signatureVersion: profileStatsSignatureVersion, integrityStatus };
  return { ...sealed, signature: signatureFor(sealed, secret) };
}

function signatureFor(stats: ProfileStats, secret: string): string {
  return createHmac("sha256", secret).update(canonicalProfileStats(stats)).digest("base64url");
}

function normalizeProfileStatsSignature(stats: ProfileStats, secret: string): ProfileStats {
  if (stats.signatureVersion === profileStatsSignatureVersion) {
    return { ...stats, integrityStatus: "verified" };
  }
  return sealProfileStats(stats, secret, "verified");
}

function canonicalProfileStats(stats: ProfileStats): string {
  return JSON.stringify({
    signatureVersion: stats.signatureVersion,
    createdAt: stats.createdAt,
    startedUsingAt: stats.startedUsingAt,
    events: stats.events.map((event) => ({
      id: event.id,
      type: event.type,
      targetID: event.targetID,
      displayName: event.displayName,
      channel: event.channel,
      occurredAt: event.occurredAt
    }))
  });
}

function unversionedSignatureFor(stats: ProfileStats, secret: string): string {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify({
        createdAt: stats.createdAt,
        startedUsingAt: stats.startedUsingAt,
        events: stats.events.map((event) => ({
          id: event.id,
          type: event.type,
          targetID: event.targetID,
          displayName: event.displayName,
          channel: event.channel,
          occurredAt: event.occurredAt
        }))
      })
    )
    .digest("base64url");
}

function legacySignatureFor(stats: ProfileStats, secret: string): string {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify({
        createdAt: stats.createdAt,
        events: stats.events.map((event) => ({
          id: event.id,
          type: event.type,
          targetID: event.targetID,
          displayName: event.displayName,
          channel: event.channel,
          occurredAt: event.occurredAt
        }))
      })
    )
    .digest("base64url");
}
