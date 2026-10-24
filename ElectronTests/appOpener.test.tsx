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

async function launchFixture() {
  const root = await mkdtemp("/tmp/baseline-open-retry-");
  const app: AppRecord = {
    id: "fixture",
    bundlePath: `${root}/Example.app`,
    displayName: "Example",
    localVersion: version("1"),
    sourceHint: "unknown"
  };
  const other = { ...app, id: "other", bundlePath: `${root}/Other.app` };
  const store = new UpdateStore({
    persisted: { ...defaultPersistedSnapshot(), autoRefreshEnabled: false, apps: [app, other] },
    persistence: new SnapshotPersistence(root),
    openAppBundle,
    openExternalURL: async () => false,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    }
  });
  return {
    store,
    app,
    other,
    close: async () => {
      await store.prepareToQuit();
      shell.openPath.mockReset();
      await rm(root, { recursive: true, force: true });
    }
  };
}

it("keeps one app's launch notice when opening a different app succeeds", async () => {
  const { store, app, other, close } = await launchFixture();
  try {
    shell.openPath.mockResolvedValue("Synthetic failure");
    await store.openApp(app.id);
    const notice = store.getSnapshot().refreshErrorMessage;
    expect(notice).toContain("Could not open");
    shell.openPath.mockResolvedValue("");
    await store.openApp(other.id);
    expect(store.getSnapshot().refreshErrorMessage).toBe(notice);
    await store.openApp(app.id);
    expect(store.getSnapshot().refreshErrorMessage).toBeUndefined();
  } finally {
    await close();
  }
});

it.each(["same app", "another app", "unrelated error"] as const)(
  "preserves a newer %s notice when an older launch retry succeeds",
  async (newer) => {
    const { store, app, other, close } = await launchFixture();
    let finish!: (value: string) => void;
    const blocked = new Promise<string>((resolve) => {
      finish = resolve;
    });
    let retry: Promise<void> | undefined;
    try {
      shell.openPath.mockResolvedValue("Synthetic failure");
      await store.openApp(app.id);
      expect(store.getSnapshot().refreshErrorMessage).toContain("Could not open");
      shell.openPath.mockReturnValueOnce(blocked);
      retry = store.openApp(app.id);
      if (newer === "unrelated error") await store.openExternal("http://example.com/unsafe");
      else await store.openApp(newer === "same app" ? app.id : other.id);
      const notice = store.getSnapshot().refreshErrorMessage;
      expect(notice).toBe(
        newer === "unrelated error"
          ? "Blocked an unsafe external link."
          : "Could not open the app. It may have moved or be unavailable. Refresh and try again."
      );
      finish("");
      await retry;
      expect(store.getSnapshot().refreshErrorMessage).toBe(notice);
    } finally {
      finish("");
      await Promise.allSettled([blocked, retry]);
      await close();
    }
  }
);

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
        shell.openPath.mockResolvedValue("");
        await expect(invoke()).resolves.toBeUndefined();
        expect(store.getSnapshot().refreshErrorMessage).toBeUndefined();
        expect(renderToStaticMarkup(<RefreshFeedback snapshot={store.getSnapshot()} />)).toBe("");
      }
      expect(shell.openPath).toHaveBeenCalledWith(app.bundlePath);
      expect(openExternalURL).toHaveBeenCalledTimes(action === "update fallback" ? 5 : 0);
    } finally {
      await store.prepareToQuit();
      shell.openPath.mockReset();
      await rm(root, { recursive: true, force: true });
    }
  }
);
