// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { ProfileStatsIntegrityService } from "../src/main/profileStatsIntegrityService";

// Only the E2E bundle aliases the production Keychain provider to this module.
// Use the same HMAC verification and tamper handling with a disposable test secret.
export class TestProfileStatsIntegrity extends ProfileStatsIntegrityService {
  constructor() {
    const secret = process.env.BASELINE_E2E_PROFILE_SECRET;
    if (!secret || !/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
      throw new Error("The isolated E2E profile secret is missing or invalid.");
    }
    super(async () => secret);
  }
}

export { TestProfileStatsIntegrity as KeychainProfileStatsIntegrity };
export type { ProfileStatsIntegrity } from "../src/main/profileStatsIntegrityService";
