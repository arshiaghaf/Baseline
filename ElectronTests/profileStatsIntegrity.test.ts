// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeychainProfileStatsIntegrity } from "../src/main/profileStatsIntegrity";
import {
  defaultProfileStats,
  profileStatsSignatureVersion,
  type ProfileStats
} from "../src/shared/domain";
import { runCommand } from "../src/main/commandRunner";

vi.mock("../src/main/commandRunner", () => ({
  runCommand: vi.fn()
}));

const runCommandMock = vi.mocked(runCommand);

beforeEach(() => {
  runCommandMock.mockReset();
  runCommandMock.mockResolvedValue({
    success: true,
    status: 0,
    output: "profile-stats-secret\n",
    stdout: "profile-stats-secret\n",
    stderr: ""
  });
});

describe("profile stats integrity", () => {
  it("detects local edits to the started using date", async () => {
    const integrity = new KeychainProfileStatsIntegrity();
    const sealed = await integrity.seal({
      ...defaultProfileStats("2026-06-01T12:00:00.000Z"),
      integrityStatus: "verified"
    });

    const verified = await integrity.verifyOrInitialize(sealed);
    const tampered = await integrity.verifyOrInitialize({
      ...sealed,
      startedUsingAt: "2020-01-01T12:00:00.000Z"
    });

    expect(sealed.signatureVersion).toBe(profileStatsSignatureVersion);
    expect(verified.integrityStatus).toBe("verified");
    expect(tampered.integrityStatus).toBe("resetAfterTamper");
    expect(tampered.events).toEqual([]);
  });

  it("migrates valid unversioned seals to the current signature version", async () => {
    const integrity = new KeychainProfileStatsIntegrity();
    const unversionedStats = {
      ...defaultProfileStats("2026-06-01T12:00:00.000Z"),
      events: [
        {
          id: "appUpdate:example",
          type: "appUpdate" as const,
          targetID: "app:example",
          displayName: "Example",
          channel: "appStore" as const,
          occurredAt: "2026-06-02T12:00:00.000Z"
        }
      ]
    };
    const unversionedSignature = unversionedSignatureFor(unversionedStats, "profile-stats-secret");

    const migrated = await integrity.verifyOrInitialize({
      ...unversionedStats,
      signature: unversionedSignature
    });

    expect(migrated.integrityStatus).toBe("verified");
    expect(migrated.events).toEqual(unversionedStats.events);
    expect(migrated.signatureVersion).toBe(profileStatsSignatureVersion);
    expect(migrated.signature).toBeDefined();
    expect(migrated.signature).not.toBe(unversionedSignature);
  });

  it("migrates valid legacy seals without trusting the unsigned started using date", async () => {
    const integrity = new KeychainProfileStatsIntegrity();
    const legacyStats: ProfileStats = {
      ...defaultProfileStats("2026-06-01T12:00:00.000Z"),
      startedUsingAt: "2020-01-01T12:00:00.000Z",
      integrityStatus: "pending",
      events: [
        {
          id: "appUpdate:example",
          type: "appUpdate",
          targetID: "app:example",
          displayName: "Example",
          channel: "appStore",
          occurredAt: "2026-06-02T12:00:00.000Z"
        }
      ]
    };
    const legacySignature = legacySignatureFor(legacyStats, "profile-stats-secret");

    const migrated = await integrity.verifyOrInitialize({
      ...legacyStats,
      signature: legacySignature
    });

    expect(migrated.integrityStatus).toBe("verified");
    expect(migrated.events).toEqual(legacyStats.events);
    expect(migrated.startedUsingAt).toBe("2026-06-01T12:00:00.000Z");
    expect(migrated.signatureVersion).toBe(profileStatsSignatureVersion);
    expect(migrated.signature).toBeDefined();
    expect(migrated.signature).not.toBe(legacySignature);
  });

  it("does not bless populated unsigned stats history", async () => {
    const integrity = new KeychainProfileStatsIntegrity();

    const verified = await integrity.verifyOrInitialize({
      ...defaultProfileStats("2026-06-01T12:00:00.000Z"),
      events: [
        {
          id: "appUpdate:unsigned",
          type: "appUpdate",
          targetID: "app:unsigned",
          displayName: "Unsigned",
          channel: "appStore",
          occurredAt: "2026-06-02T12:00:00.000Z"
        }
      ]
    });

    expect(verified.integrityStatus).toBe("unavailable");
    expect(verified.signature).toBeUndefined();
  });

  it("preserves the existing signature when sealing is unavailable", async () => {
    const integrity = new KeychainProfileStatsIntegrity();
    const signed = await integrity.seal({
      ...defaultProfileStats("2026-06-01T12:00:00.000Z"),
      integrityStatus: "verified"
    });
    runCommandMock.mockResolvedValue({
      success: false,
      status: 1,
      output: "",
      stdout: "",
      stderr: "Keychain unavailable"
    });

    const unavailable = await integrity.seal({
      ...signed,
      events: [
        {
          id: "appUpdate:later",
          type: "appUpdate",
          targetID: "app:later",
          displayName: "Later",
          channel: "appStore",
          occurredAt: "2026-06-02T12:00:00.000Z"
        }
      ]
    });

    expect(unavailable.integrityStatus).toBe("unavailable");
    expect(unavailable.signature).toBe(signed.signature);
  });
});

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
