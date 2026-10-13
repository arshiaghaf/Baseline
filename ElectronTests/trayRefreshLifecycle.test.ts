// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import { TrayRefreshAnimation } from "../src/main/trayRefreshAnimation";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex
} from "../src/shared/domain";

it("keeps the tray busy until the winning refresh finishes and restores it after a scan error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-tray-refresh-"));
  const persistence = new SnapshotPersistence(directory);
  const gates: (() => void)[] = [];
  const tasks: Promise<void>[] = [];
  let failScan = false;
  const store = new UpdateStore({
    persistence,
    persisted: { ...defaultPersistedSnapshot(), autoRefreshEnabled: false },
    openExternalURL: async () => true,
    openAppBundle: async () => undefined,
    clients: {
      scanner: {
        scanApplications: async () => {
          if (failScan) throw new Error("Synthetic scan error");
          await new Promise<void>((resolve) => gates.push(resolve));
          return [];
        }
      },
      homebrew: {
        fetchIndex: async () => emptyHomebrewCaskIndex,
        lookupUpdate: () => undefined,
        searchCasks: () => []
      },
      homebrewFormula: {
        fetchIndex: async () => emptyHomebrewFormulaIndex,
        searchFormulae: () => []
      },
      homebrewInventory: {
        fetchInventory: async () => ({
          items: [],
          outdatedDetectionSucceeded: true,
          outdatedDetectionSucceededByKind: { formula: true, cask: true }
        })
      },
      selfUpdate: { lookup: async (currentVersion) => ({ available: false, currentVersion }) }
    }
  });
  const render = vi.fn();
  const animation = new TrayRefreshAnimation(render);
  store.on("snapshot", (snapshot) => animation.update(snapshot.isRefreshing, false));
  const refresh = (lightweight = false) => {
    const task = store.refresh(lightweight);
    void task.catch(() => undefined);
    tasks.push(task);
    return task;
  };
  try {
    refresh();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    refresh();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    refresh(true);
    gates[0]!();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(store.getSnapshot().isRefreshing).toBe(true);
    expect(render.mock.calls.every(([frame]) => frame !== undefined)).toBe(true);
    expect(render.mock.calls.length).toBeGreaterThan(1);
    gates[1]!();
    await Promise.all(tasks);
    expect(render).toHaveBeenLastCalledWith(undefined);

    failScan = true;
    await refresh();
    expect(store.getSnapshot()).toMatchObject({
      isRefreshing: false,
      refreshErrorMessage: "Synthetic scan error"
    });
    expect(render).toHaveBeenLastCalledWith(undefined);
    const count = render.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(render).toHaveBeenCalledTimes(count);
  } finally {
    animation.dispose();
    gates.forEach((release) => release());
    await Promise.allSettled(tasks);
    await persistence.load();
    await rm(directory, { recursive: true, force: true });
  }
});
