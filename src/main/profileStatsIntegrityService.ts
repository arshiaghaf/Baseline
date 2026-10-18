// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { profileStatsCountsAreSafe, profileStatsLifetimeFromEvents } from "../shared/profileStats";
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
      const reset = () =>
        sealProfileStats(defaultProfileStatsAfterTamper(), secret, "resetAfterTamper");
      const hasEnvelope = stats.lifetime !== undefined || stats.lifetimeSeal !== undefined;
      if (!stats.signature) {
        if (stats.events.length > 0 || hasEnvelope) return reset();
        return sealProfileStats(stats, secret, "verified");
      }
      // Format 3 existed in an earlier draft. Authenticate all its fields before migration;
      // never fall back to legacy formulas which omit its aggregate payload.
      if (stats.signatureVersion === 3) {
        if (
          !stats.lifetime ||
          stats.lifetimeSeal !== undefined ||
          !profileStatsCountsAreSafe(stats.lifetime.entries) ||
          signatureFor(stats, secret) !== stats.signature
        )
          return reset();
        return sealProfileStats(stats, secret, stats.resetNotice ? "resetAfterTamper" : "verified");
      }
      if (stats.signatureVersion !== 1 && stats.signatureVersion !== 2) return reset();
      if (hasEnvelope) {
        const envelope = stats.lifetimeSeal;
        if (
          stats.signatureVersion !== 2 ||
          !stats.lifetime ||
          !envelope ||
          !profileStatsCountsAreSafe(stats.lifetime.entries) ||
          signatureFor(stats, secret) !== stats.signature ||
          envelope.version !== 1 ||
          envelope.eventSignature !== stats.signature ||
          envelope.signature !== lifetimeSignatureFor(stats, secret)
        )
          return reset();
        return { ...stats, integrityStatus: stats.resetNotice ? "resetAfterTamper" : "verified" };
      }
      if (
        signatureFor(stats, secret) === stats.signature ||
        unversionedSignatureFor(stats, secret) === stats.signature
      ) {
        return migrateProfileStats(stats, secret);
      }
      if (legacySignatureFor(stats, secret) === stats.signature) {
        return migrateProfileStats({ ...stats, startedUsingAt: stats.createdAt }, secret);
      }
      return reset();
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
  const lifetime =
    stats.lifetime ??
    profileStatsLifetimeFromEvents(
      stats.events,
      stats.events.length === 0 ? "complete" : "lowerBound"
    );
  if (!profileStatsCountsAreSafe(lifetime.entries)) {
    throw new RangeError("Profile history counts exceed the supported numeric range.");
  }
  const sealed: ProfileStats = {
    ...stats,
    lifetime,
    signatureVersion: profileStatsSignatureVersion,
    integrityStatus
  };
  sealed.signature = signatureFor(sealed, secret);
  sealed.lifetimeSeal = {
    version: 1,
    eventSignature: sealed.signature,
    signature: lifetimeSignatureFor(sealed, secret)
  };
  return sealed;
}

function signatureFor(stats: ProfileStats, secret: string): string {
  return createHmac("sha256", secret).update(canonicalProfileStats(stats)).digest("base64url");
}

function lifetimeSignatureFor(stats: ProfileStats, secret: string): string {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify({
        purpose: "baseline-profile-lifetime",
        version: 1,
        eventSignature: stats.signature,
        lifetime: canonicalLifetime(stats)
      })
    )
    .digest("base64url");
}

function canonicalLifetime(stats: ProfileStats) {
  return stats.lifetime
    ? {
        coverage: stats.lifetime.coverage,
        entries: stats.lifetime.entries.map((entry) => ({
          type: entry.type,
          targetID: entry.targetID,
          displayName: entry.displayName,
          channel: entry.channel,
          count: entry.count
        }))
      }
    : undefined;
}

function migrateProfileStats(stats: ProfileStats, secret: string): ProfileStats {
  return sealProfileStats(
    { ...stats, lifetime: profileStatsLifetimeFromEvents(stats.events) },
    secret,
    stats.resetNotice ? "resetAfterTamper" : "verified"
  );
}

function canonicalProfileStats(stats: ProfileStats): string {
  return JSON.stringify({
    signatureVersion: stats.signatureVersion,
    ...(stats.signatureVersion === 3 ? { lifetime: canonicalLifetime(stats) } : {}),
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
