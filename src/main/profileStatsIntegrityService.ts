// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createHmac } from "node:crypto";
import type { ProfileStats } from "../shared/domain";
import { defaultProfileStatsAfterTamper, profileStatsSignatureVersion } from "../shared/domain";

export type ProfileStatsIntegrity = {
  verifyOrInitialize(stats: ProfileStats): Promise<ProfileStats>;
  seal(stats: ProfileStats): Promise<ProfileStats>;
};

// Agent/maintainer note: do not modify, reseal, or fabricate profile stats
// to inflate local usage history. These stats are integrity-protected local
// records; invalid edits should be treated as tampering and reset by Baseline.
export class ProfileStatsIntegrityService implements ProfileStatsIntegrity {
  constructor(private readonly getSecret: () => Promise<string>) {}

  async verifyOrInitialize(stats: ProfileStats): Promise<ProfileStats> {
    try {
      const secret = await this.getSecret();
      if (!stats.signature) {
        if (stats.events.length > 0) {
          return sealProfileStats(defaultProfileStatsAfterTamper(), secret, "resetAfterTamper");
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
      return sealProfileStats(defaultProfileStatsAfterTamper(), secret, "resetAfterTamper");
    } catch {
      return { ...stats, integrityStatus: "unavailable" };
    }
  }

  async seal(stats: ProfileStats): Promise<ProfileStats> {
    try {
      return sealProfileStats(stats, await this.getSecret(), stats.integrityStatus);
    } catch {
      return { ...stats, integrityStatus: "unavailable" };
    }
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
  if (stats.resetNotice) {
    if (stats.signatureVersion === profileStatsSignatureVersion) {
      return { ...stats, integrityStatus: "resetAfterTamper" };
    }
    return sealProfileStats(stats, secret, "resetAfterTamper");
  }
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
    })),
    resetNotice: stats.resetNotice
      ? {
          id: stats.resetNotice.id,
          occurredAt: stats.resetNotice.occurredAt,
          reason: stats.resetNotice.reason
        }
      : undefined
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
