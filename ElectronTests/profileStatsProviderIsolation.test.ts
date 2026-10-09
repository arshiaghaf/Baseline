// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertIsolatedIntegrityBundle,
  assertProductionIntegrityBundle
} from "../e2e/bundleIsolation";
import { TestProfileStatsIntegrity } from "../e2e/profileStatsIntegrity";
import { SnapshotPersistence } from "../src/main/persistence";
import { UpdateStore } from "../src/main/updateStore";
import { defaultPersistedSnapshot, defaultProfileStats } from "../src/shared/domain";

const runCommandMock = vi.hoisted(() => vi.fn());
vi.mock("../src/main/commandRunner", () => ({
  runCommand: runCommandMock,
  runBrewCommand: vi.fn(),
  runMasCommand: vi.fn()
}));

afterEach(() => {
  vi.unstubAllEnvs();
  runCommandMock.mockReset();
});

describe("profile integrity provider isolation", () => {
  it("keeps the store default on Keychain even when test environment variables are set", async () => {
    vi.stubEnv("BASELINE_E2E_PROFILE_SECRET", randomBytes(32).toString("base64url"));
    vi.stubEnv("BASELINE_SKIP_INITIAL_REFRESH", "1");
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-provider-test-"));
    vi.stubEnv("BASELINE_USER_DATA_DIR", directory);
    runCommandMock.mockResolvedValue({ success: true, stdout: "mock-keychain-secret" });
    try {
      const store = new UpdateStore({
        persistence: new SnapshotPersistence(directory),
        persisted: defaultPersistedSnapshot(),
        openExternalURL: async () => false,
        openAppBundle: async () => undefined
      });
      await store.verifyProfileStatsIntegrity();
      expect(runCommandMock).toHaveBeenCalledTimes(1);
      expect(runCommandMock).toHaveBeenCalledWith(
        "/usr/bin/security",
        expect.arrayContaining(["find-generic-password", "Baseline Profile Stats"])
      );
      expect(store.getSnapshot().profileStats.integrityStatus).toBe("verified");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the injected secret across relaunches without running any Keychain command", async () => {
    vi.stubEnv("BASELINE_E2E_PROFILE_SECRET", randomBytes(32).toString("base64url"));
    const stats = defaultProfileStats("2026-06-01T12:00:00.000Z");
    const sealed = await new TestProfileStatsIntegrity().verifyOrInitialize(stats);
    const verified = await new TestProfileStatsIntegrity().verifyOrInitialize(sealed);
    const tampered = await new TestProfileStatsIntegrity().verifyOrInitialize({
      ...sealed,
      startedUsingAt: "2026-05-01T12:00:00.000Z"
    });
    expect(sealed.signature).toEqual(expect.any(String));
    expect(verified.integrityStatus).toBe("verified");
    expect(tampered.integrityStatus).toBe("resetAfterTamper");
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("refuses a missing test secret rather than falling back to Keychain", () => {
    vi.stubEnv("BASELINE_E2E_PROFILE_SECRET", "");
    expect(() => new TestProfileStatsIntegrity()).toThrow("missing or invalid");
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("rejects production and mixed provider bundles before Electron launch", () => {
    const production = "find-generic-password add-generic-password";
    const isolated = "BASELINE_E2E_PROFILE_SECRET";
    expect(() => assertIsolatedIntegrityBundle(production)).toThrow("Refusing to launch");
    expect(() => assertIsolatedIntegrityBundle(`${production} ${isolated}`)).toThrow(
      "Refusing to launch"
    );
    expect(() => assertIsolatedIntegrityBundle("")).toThrow("Refusing to launch");
    expect(() => assertProductionIntegrityBundle(`${production} ${isolated}`)).toThrow(
      "no test provider"
    );
    expect(() => assertProductionIntegrityBundle(production)).not.toThrow();
    expect(() => assertIsolatedIntegrityBundle(isolated)).not.toThrow();
  });
});
