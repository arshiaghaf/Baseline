// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import type { AppRecord, UpdateRecord } from "../src/shared/domain";
import { emptyHomebrewCaskIndex } from "../src/shared/domain";
import { version } from "../src/shared/version";
import { lookupAppUpdates } from "../src/main/appUpdateLookupService";

const app: AppRecord = {
  id: "example",
  bundlePath: "/Applications/Example.app",
  displayName: "Example",
  bundleIdentifier: "com.example.app",
  localVersion: version("1.0"),
  sparkleFeedURL: "https://example.com/appcast.xml",
  sourceHint: "unknown"
};

function input(previousUpdates: UpdateRecord[] = []) {
  return {
    apps: [app],
    previousUpdates: new Map(previousUpdates.map((update) => [update.appID, update])),
    homebrewItems: [],
    homebrewIndex: emptyHomebrewCaskIndex,
    now: "2026-10-16T00:00:00.000Z",
    force: true,
    signal: new AbortController().signal,
    isCurrent: () => true,
    isSelfApp: () => false,
    canUseHomebrewAppUpdate: () => false
  };
}

describe("lookupAppUpdates", () => {
  it("keeps App Store precedence when all sources could offer an update", async () => {
    const sparkle = vi.fn();
    const homebrew = vi.fn();
    const updates = await lookupAppUpdates(
      {
        appStore: {
          lookupOutcome: vi.fn().mockResolvedValue({
            type: "completed",
            value: { remoteVersion: version("2.0") }
          })
        },
        sparkle: { lookupOutcome: sparkle },
        homebrew: { lookupUpdate: homebrew }
      },
      input()
    );
    expect(updates).toMatchObject([{ appID: "example", source: "appStore" }]);
    expect(sparkle).not.toHaveBeenCalled();
    expect(homebrew).not.toHaveBeenCalled();
  });

  it("retains a still-valid App Store update on transient failure", async () => {
    const previous: UpdateRecord = {
      id: app.id,
      appID: app.id,
      source: "appStore",
      supportLevel: "supported",
      localVersion: app.localVersion,
      remoteVersion: version("2.0"),
      checkedAt: "2026-10-15T00:00:00.000Z"
    };
    const sparkle = vi.fn();
    const updates = await lookupAppUpdates(
      {
        appStore: { lookupOutcome: vi.fn().mockResolvedValue({ type: "transientFailure" }) },
        sparkle: { lookupOutcome: sparkle },
        homebrew: { lookupUpdate: vi.fn() }
      },
      input([previous])
    );
    expect(updates).toEqual([previous]);
    expect(sparkle).not.toHaveBeenCalled();
  });

  it("discards partial results when the generation is superseded during lookup", async () => {
    let current = true;
    const updates = await lookupAppUpdates(
      {
        appStore: {
          lookupOutcome: vi.fn().mockImplementation(async () => {
            current = false;
            return { type: "completed", value: { remoteVersion: version("2.0") } };
          })
        },
        sparkle: { lookupOutcome: vi.fn() },
        homebrew: { lookupUpdate: vi.fn() }
      },
      { ...input(), isCurrent: () => current }
    );
    expect(updates).toBeUndefined();
  });
});
