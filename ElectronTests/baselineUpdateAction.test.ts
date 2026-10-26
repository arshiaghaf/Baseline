// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { readFile } from "node:fs/promises";
import ts from "typescript";
import { beforeEach, expect, it, vi } from "vitest";

let check: () => Promise<void>;
let store: {
  checkForSelfUpdate: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
  prepareToQuit: ReturnType<typeof vi.fn>;
  prepareToQuitForSelfUpdate: ReturnType<typeof vi.fn>;
};
let native: { available: ReturnType<typeof vi.fn>; check: ReturnType<typeof vi.fn> };
let dialog: { showMessageBox: ReturnType<typeof vi.fn<() => Promise<{ response: number }>>> };

beforeEach(async () => {
  store = {
    checkForSelfUpdate: vi.fn(async () => ({
      available: true,
      latestVersion: { raw: "v0.10.0" },
      releaseURL: "https://github.com/arshiaghaf/Baseline/releases/tag/v0.10.0"
    })),
    openExternal: vi.fn(async () => true),
    prepareToQuit: vi.fn(async () => true),
    prepareToQuitForSelfUpdate: vi.fn(async () => true)
  };
  native = { available: vi.fn(async () => false), check: vi.fn(async () => undefined) };
  dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) };
  const source = await readFile("src/main/main.ts", "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "checkForBaselineUpdates"
  );
  expect(declaration).toBeDefined();
  const js = ts.transpileModule(declaration!.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  check = new Function(
    "store",
    "signedSelfUpdater",
    "dialog",
    "app",
    "metadata",
    `
    let selfUpdateCheckOpen = false, isQuitting = false, quitTask, dockHideTimer;
    ${js}; return checkForBaselineUpdates;
  `
  )(store, native, dialog, { quit: vi.fn() }, { version: "0.8.0" });
});

it("opens a freshly checked release rather than the toolbar snapshot destination", async () => {
  await check();
  expect(store.checkForSelfUpdate).toHaveBeenCalledOnce();
  expect(dialog.showMessageBox).toHaveBeenCalledWith(
    expect.objectContaining({ detail: expect.stringContaining("v0.10.0") })
  );
  expect(store.openExternal).toHaveBeenCalledWith(
    "https://github.com/arshiaghaf/Baseline/releases/tag/v0.10.0"
  );
});

it("routes eligible installations to Sparkle without authorizing via GitHub metadata", async () => {
  native.available.mockResolvedValue(true);
  await check();
  expect(native.check).toHaveBeenCalledOnce();
  expect(store.checkForSelfUpdate).not.toHaveBeenCalled();
  expect(store.openExternal).not.toHaveBeenCalled();
  const prepare = (native.check.mock.calls[0] as unknown[])[0] as () => Promise<boolean>;
  await expect(prepare()).resolves.toBe(true);
  expect(store.prepareToQuitForSelfUpdate).toHaveBeenCalledOnce();
});

it("offers a safe manual release route after native failure", async () => {
  native.available.mockResolvedValue(true);
  native.check.mockRejectedValue(new Error("invalid signature"));
  await check();
  expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  expect(store.openExternal).toHaveBeenCalledWith(
    "https://github.com/arshiaghaf/Baseline/releases/latest"
  );
});

it("coalesces concurrent toolbar and tray actions", async () => {
  let finish!: (response: { response: number }) => void;
  dialog.showMessageBox.mockImplementation(
    () =>
      new Promise((done) => {
        finish = done;
      })
  );
  const first = check();
  await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledOnce());
  await check();
  expect(store.checkForSelfUpdate).toHaveBeenCalledOnce();
  finish({ response: 1 });
  await first;
  expect(store.openExternal).not.toHaveBeenCalled();
});
