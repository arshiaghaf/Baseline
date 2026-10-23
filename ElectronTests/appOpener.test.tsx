// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { openAppBundle } from "../src/main/appOpener";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import { defaultPersistedSnapshot, type AppRecord, type UpdateRecord } from "../src/shared/domain";
import { version } from "../src/shared/version";
import { RefreshFeedback } from "../src/renderer/components/RefreshFeedback";

const shell = vi.hoisted(() => ({ openPath: vi.fn<(path: string) => Promise<string>>() }));
vi.mock("electron", () => ({ shell }));

it.each(["open", "update without metadata", "update fallback"] as const)(
  "shows controlled feedback for %s failures from Electron and accepts success",
  async (action) => {
    const root = await mkdtemp("/tmp/baseline-open-fixture-");
    const app: AppRecord = {
      id: "fixture",
      bundlePath: `${root}/Example.app`,
      displayName: "Example",
      localVersion: version("1"),
      sourceHint: "sparkle"
    };
    const update: UpdateRecord = {
      id: app.id,
      appID: app.id,
      source: "sparkle",
      supportLevel: "limited",
      localVersion: version("1"),
      remoteVersion: version("2"),
      updateURL: "https://example.com/update",
      checkedAt: "2026-10-23T00:00:00.000Z"
    };
    const openExternalURL = vi.fn(async () => false);
    const store = new UpdateStore({
      persisted: {
        ...defaultPersistedSnapshot(),
        autoRefreshEnabled: false,
        apps: [app],
        updates: action === "update fallback" ? [update] : []
      },
      persistence: new SnapshotPersistence(root),
      openAppBundle,
      openExternalURL,
      profileStatsIntegrity: {
        verifyOrInitialize: async (stats) => stats,
        seal: async (stats) => stats
      }
    });
    const invoke = () =>
      action === "open" ? store.openApp(app.id) : store.performAppUpdate(app.id);
    try {
      shell.openPath.mockResolvedValue("");
      await expect(invoke()).resolves.toBeUndefined();
      expect(store.getSnapshot().refreshErrorMessage).toBeUndefined();
      for (const result of ["returned error", "rejection"] as const) {
        const privateError = "Synthetic Launch Services error /private/fixture token=secret";
        if (result === "returned error") shell.openPath.mockResolvedValue(privateError);
        else shell.openPath.mockRejectedValue(new Error(privateError));
        await expect(invoke()).resolves.toBeUndefined();
        const snapshot = store.getSnapshot();
        expect(snapshot.refreshErrorMessage).toBe(
          "Could not open the app. It may have moved or be unavailable. Refresh and try again."
        );
        const feedback = renderToStaticMarkup(<RefreshFeedback snapshot={snapshot} />);
        expect(feedback).toContain('role="status"');
        expect(feedback).toContain("Could not open the app.");
        expect(feedback).not.toContain(privateError);
      }
      expect(shell.openPath).toHaveBeenCalledWith(app.bundlePath);
      expect(openExternalURL).toHaveBeenCalledTimes(action === "update fallback" ? 3 : 0);
    } finally {
      await store.prepareToQuit();
      shell.openPath.mockReset();
      await rm(root, { recursive: true, force: true });
    }
  }
);
