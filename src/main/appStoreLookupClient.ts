// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import type { AppStoreLookupResult } from "../shared/domain";
import { byteLimits, sanitizeExternalURL } from "../shared/security";
import { isVersionGreater, type VersionValue, version } from "../shared/version";

type LookupEntry = {
  kind?: string;
  version?: string;
  trackViewUrl?: string;
  trackId?: number;
  releaseNotes?: string;
  currentVersionReleaseDate?: string;
};

export type LookupOutcome<T> = { type: "completed"; value?: T } | { type: "transientFailure" };

export class AppStoreLookupClient {
  async lookupOutcome(
    bundleIdentifier: string,
    localVersion: VersionValue
  ): Promise<LookupOutcome<AppStoreLookupResult>> {
    const url = new URL("https://itunes.apple.com/lookup");
    url.searchParams.set("bundleId", bundleIdentifier);
    url.searchParams.set("entity", "macSoftware");

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        return { type: "transientFailure" };
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return { type: "completed", value: this.parseLookupResponse(buffer, localVersion) };
    } catch {
      return { type: "transientFailure" };
    }
  }

  parseLookupResponse(data: Buffer, localVersion: VersionValue): AppStoreLookupResult | undefined {
    if (data.byteLength > byteLimits.appStoreLookupMaxBytes) {
      return undefined;
    }
    const response = JSON.parse(data.toString("utf8")) as { results?: LookupEntry[] };
    const results = response.results ?? [];
    const selected =
      results.find((entry) => entry.kind === "mac-software") ??
      (results.length === 1 && !results[0]?.kind ? results[0] : undefined);
    if (!selected) {
      return undefined;
    }

    const remoteVersion = version(selected.version);
    if (!isVersionGreater(remoteVersion, localVersion)) {
      return undefined;
    }

    return {
      remoteVersion,
      updateURL: sanitizeExternalURL(selected.trackViewUrl),
      releaseNotesSummary: selected.releaseNotes,
      releaseDate: selected.currentVersionReleaseDate,
      appStoreItemID: selected.trackId
    };
  }
}
