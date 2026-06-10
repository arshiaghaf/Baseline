// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeychainProfileStatsIntegrity } from "../src/main/profileStatsIntegrity";
import { defaultProfileStats } from "../src/shared/domain";
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
});
