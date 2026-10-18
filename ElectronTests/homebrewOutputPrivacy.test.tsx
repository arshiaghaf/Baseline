// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { runCommand, type CommandResult } from "../src/main/commandRunner";
import { SnapshotPersistence } from "../src/main/persistence";
import { UpdateStore } from "../src/main/updateStore";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type HomebrewManagedItem
} from "../src/shared/domain";
import type { HomebrewMaintenanceRunEvent } from "../src/shared/homebrewProgress";
import { ipcChannels, type BaselineAPI } from "../src/shared/ipc";
import { version } from "../src/shared/version";
import { RefreshFeedback } from "../src/renderer/components/RefreshFeedback";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn<(name: string, api: BaselineAPI) => void>() },
  ipcRenderer: { on: vi.fn(), off: vi.fn(), invoke: vi.fn() }
}));
vi.mock("electron", () => electron);

type Delivery = { window: number; channel: string; payload: unknown };

async function wireRendererRecipients(store: UpdateStore, deliveries: Delivery[]): Promise<void> {
  // Execute the production wiring without importing the app's launching entry point.
  const source = await readFile("src/main/main.ts", "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "wireStoreEvents"
  );
  expect(declaration).toBeDefined();
  const js = ts.transpileModule(declaration!.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const windows = [1, 2].map((window) => ({
    webContents: {
      send: (channel: string, payload: unknown) =>
        deliveries.push({ window, channel, payload: structuredClone(payload) })
    }
  }));
  new Function(
    "store",
    "BrowserWindow",
    "ipcChannels",
    "applyAppearancePreference",
    "syncAppVisibility",
    `${js}\nwireStoreEvents();`
  )(
    store,
    { getAllWindows: () => windows },
    ipcChannels,
    () => undefined,
    () => undefined
  );
}

const item: HomebrewManagedItem = {
  id: "cask:fixture",
  kind: "cask",
  token: "fixture",
  fullToken: "fixture",
  tap: "homebrew/cask",
  name: "Fixture",
  installedVersion: version("1"),
  isOutdated: false
};

it.each([false, true])(
  "keeps raw uninstall logs inside main when the sanitized tail is omitted: %s",
  async (omitted) => {
    const token = "ghp_SYNTHETIC_TOKEN_ONLY_123456";
    const credential = "SYNTHETIC_URL_PASSWORD";
    const rawLine = omitted
      ? `${token}${"x".repeat(20_000)}\n`
      : `Error: download failed token=${token} path=/Users/fixture/private\n`;
    const urlLine = omitted ? "" : `https://fixture:${credential}@example.com/private\n`;
    const directory = await mkdtemp("/tmp/baseline-output-privacy-");
    const persistence = new SnapshotPersistence(directory);
    const deliveries: Delivery[] = [];
    const internalEvents: HomebrewMaintenanceRunEvent[] = [];
    let result: CommandResult | undefined;
    const store = new UpdateStore({
      persistence,
      persisted: {
        ...defaultPersistedSnapshot(),
        homebrewItems: [item],
        autoRefreshEnabled: false
      },
      openExternalURL: async () => false,
      openAppBundle: async () => {
        throw new Error("Unexpected app open");
      },
      runBrewCommand: async (args, onLine) => {
        expect(args).toEqual(["uninstall", "--cask", "fixture"]);
        // Split known patterns across chunks on both pipes. No brew or sudo runs.
        const chunks = [
          ["stdout", rawLine.slice(0, 29)],
          ["stderr", urlLine.slice(0, 20)],
          ["stdout", rawLine.slice(29)],
          ["stderr", urlLine.slice(20)]
        ];
        result = await runCommand(
          process.execPath,
          [
            "-e",
            `const chunks = ${JSON.stringify(chunks)};
             (async () => {
               for (const [pipe, text] of chunks) {
                 process[pipe].write(text);
                 await new Promise(setImmediate);
               }
               process.exitCode = 1;
             })();`
          ],
          onLine,
          { capture: "tail", collectOutputTail: true }
        );
        return result;
      },
      runMasCommand: async () => {
        throw new Error("Unexpected mas command");
      },
      profileStatsIntegrity: {
        verifyOrInitialize: async (stats) => stats,
        seal: async (stats) => stats
      },
      clients: {
        scanner: { scanApplications: async () => [] },
        appStore: { lookupOutcome: async () => ({ type: "completed" }) },
        sparkle: { lookupOutcome: async () => ({ type: "completed" }) },
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
            items: [item],
            inventoryReadSucceededByKind: { formula: true, cask: true },
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true }
          })
        },
        selfUpdate: {
          lookup: async (currentVersion, checkedAt) => ({
            available: false,
            currentVersion,
            checkedAt,
            releaseURL: "https://example.com/releases"
          })
        }
      }
    });
    store.on("homebrewCommand", (event) => internalEvents.push(event));
    try {
      await wireRendererRecipients(store, deliveries);
      await store.uninstallHomebrewItem(item.id);
      const snapshot = store.getSnapshot();
      expect(result!.output).toContain(token);
      expect(internalEvents.some((event) => event.type === "outputLine")).toBe(true);
      expect(internalEvents.at(-1)).toEqual({
        type: "commandFinished",
        command: ["uninstall", "--cask", "fixture"],
        success: false
      });
      expect(new Set(deliveries.map(({ window }) => window))).toEqual(new Set([1, 2]));
      expect(deliveries.length).toBeGreaterThan(0);
      const safeChannels = new Set<string>([
        ipcChannels.snapshotChanged,
        ipcChannels.snapshotProgress
      ]);
      expect(deliveries.every(({ channel }) => safeChannels.has(channel))).toBe(true);
      const rendererData = JSON.stringify({ deliveries, snapshot });
      const html = renderToStaticMarkup(<RefreshFeedback snapshot={snapshot} />);
      for (const privateValue of [token, credential, "/Users/fixture"]) {
        expect(rendererData).not.toContain(privateValue);
        expect(html).not.toContain(privateValue);
      }
      if (omitted) {
        expect(result!.outputTail).toBeUndefined();
        expect(snapshot.refreshErrorMessage).toBe("Homebrew uninstall failed for Fixture.");
      } else {
        expect(snapshot.refreshErrorMessage).toContain("[REDACTED]");
        expect(snapshot.refreshErrorMessage).toContain("~/private");
        expect(snapshot.refreshErrorMessage).toContain("[REDACTED URL]");
        expect(snapshot.refreshErrorMessage!.length).toBeLessThan(650);
      }
      expect(snapshot.operationFailureDetails!["uninstall:cask:fixture"]!.outputTail).toBe(
        result!.outputTail
      );
      const saved = JSON.stringify(await persistence.load());
      expect(saved).not.toContain(token);
      expect(saved).not.toContain("outputTail");
      expect(saved).not.toContain("refreshErrorMessage");
    } finally {
      await store.prepareToQuit();
      await persistence.load();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it("exposes snapshot subscriptions without a raw command subscription", async () => {
  await import("../src/main/preload");
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
    "baseline",
    expect.any(Object)
  );
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]![1];
  expect(api).not.toHaveProperty("onHomebrewCommandEvent");
  const callback = vi.fn();
  const unsubscribe = api.onSnapshotChanged(callback);
  const [channel, listener] = electron.ipcRenderer.on.mock.calls[0]!;
  expect(channel).toBe(ipcChannels.snapshotChanged);
  const snapshot = { ...defaultPersistedSnapshot() };
  listener({}, snapshot);
  expect(callback).toHaveBeenCalledWith(snapshot);
  unsubscribe();
  expect(electron.ipcRenderer.off).toHaveBeenCalledWith(channel, listener);
});
