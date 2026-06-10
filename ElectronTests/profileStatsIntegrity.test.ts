// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeychainProfileStatsIntegrity } from "../src/main/profileStatsIntegrity";
import { defaultProfileStats, type ProfileStats } from "../src/shared/domain";
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

    expect(verified.integrityStatus).toBe("verified");
    expect(tampered.integrityStatus).toBe("resetAfterTamper");
    expect(tampered.events).toEqual([]);
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
    expect(migrated.signature).toBeDefined();
    expect(migrated.signature).not.toBe(legacySignature);
  });
});

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
