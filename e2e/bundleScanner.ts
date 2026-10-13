// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { AppRecord } from "../src/shared/domain";

// Smoke refreshes must not enumerate the host's installed apps or launch icon
// extraction tools. Unit tests cover the production scanner with local fixtures.
export class BundleScannerClient {
  async scanApplications(): Promise<AppRecord[]> {
    return [];
  }
}
