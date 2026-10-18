// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { expect, it, vi } from "vitest";
import { UpdateStore } from "../src/main/updateStore";
import type { SnapshotPersistence } from "../src/main/persistence";
import { defaultPersistedSnapshot } from "../src/shared/domain";
import type { PreferencePatch } from "../src/shared/ipc";

function fixture() {
  const save = vi.fn(async () => undefined);
  const store = new UpdateStore({
    persistence: { save } as unknown as SnapshotPersistence,
    persisted: { ...defaultPersistedSnapshot(), autoRefreshEnabled: false },
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    }
  });
  return { store, save };
}

it.each([
  { ignoredIDs: ["app"], showDockIcon: false },
  { apps: [] },
  { isRefreshing: true },
  { profileStats: {} },
  { refreshIntervalMinutes: NaN },
  { autoRefreshEnabled: "false" },
  { collapsedHomebrewSectionIDs: [1] },
  { appearancePreference: "other" },
  null,
  [],
  JSON.parse('{"__proto__":{"showDockIcon":false}}')
])("rejects malformed or non-preference state keys atomically %#", async (patch) => {
  const { store, save } = fixture();
  const before = structuredClone(store.getSnapshot());
  await expect(store.updatePreferences(patch as PreferencePatch)).rejects.toThrow(
    "Invalid preference patch"
  );
  expect(store.getSnapshot()).toEqual(before);
  expect(save).not.toHaveBeenCalled();
});

it("preserves valid preferences, interval clamping and visibility recovery through saving", async () => {
  const { store, save } = fixture();
  await store.updatePreferences({
    collapsedAppSectionIDs: ["apps"],
    collapsedHomebrewSectionIDs: ["formulae"],
    autoRefreshEnabled: false,
    refreshIntervalMinutes: 1.5,
    appearancePreference: "dark",
    useMasForAppStoreUpdates: false,
    showDockIcon: false,
    showMenuBarIcon: false
  });
  expect(store.getSnapshot()).toMatchObject({
    collapsedAppSectionIDs: ["apps"],
    collapsedHomebrewSectionIDs: ["formulae"],
    autoRefreshEnabled: false,
    refreshIntervalMinutes: 5,
    appearancePreference: "dark",
    useMasForAppStoreUpdates: false,
    showDockIcon: true,
    showMenuBarIcon: false
  });
  expect(save).toHaveBeenCalledOnce();
  await store.updatePreferences({ refreshIntervalMinutes: 2000, showDockIcon: true });
  expect(store.getSnapshot().refreshIntervalMinutes).toBe(1440);
});

it("omits undefined preferences and takes ownership of section arrays", async () => {
  const { store } = fixture();
  const sections = ["apps"];
  await store.updatePreferences({
    collapsedAppSectionIDs: sections,
    autoRefreshEnabled: undefined
  });
  sections.push("mutated");
  expect(store.getSnapshot().collapsedAppSectionIDs).toEqual(["apps"]);
  expect(store.getSnapshot().autoRefreshEnabled).toBe(false);
});
