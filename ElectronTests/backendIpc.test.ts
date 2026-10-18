// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { readFile } from "node:fs/promises";
import type { IpcMainInvokeEvent } from "electron";
import ts from "typescript";
import { beforeEach, expect, it, vi } from "vitest";
import { backendIpcRegistrar } from "../src/main/backendIpc";
import { isTrustedBackendSender } from "../src/main/backendIpcAuthorization";
import { ipcChannels } from "../src/shared/ipc";

const item = {
  id: "cask:example",
  kind: "cask",
  token: "example",
  displayName: "Example",
  version: { raw: "1" }
};
const validArguments = {
  getSnapshot: [],
  getAppMetadata: [],
  getDiagnostics: [],
  collectHomebrewDiagnostics: [{ doctor: true, services: false }],
  getHomebrewInstalledContext: ["cask:example"],
  getToolStatus: [],
  refreshToolStatus: [],
  cleanUpHomebrew: [],
  refresh: [false, true],
  setSearchText: [""],
  setSelectedTab: ["apps"],
  updatePreferences: [{ autoRefreshEnabled: false }],
  acknowledgeProfileStatsReset: [],
  dismissOperationFailure: ["failure"],
  toggleIgnoredApp: ["app"],
  toggleIgnoredHomebrew: ["cask:example"],
  performAppUpdate: ["app"],
  performHomebrewUpdate: ["cask:example"],
  performHomebrewUpdateAll: [["cask:example"]],
  installHomebrewItem: [item],
  uninstallHomebrewItem: ["cask:example"],
  openApp: ["app"],
  openExternal: ["https://example.com"],
  chooseDirectory: [],
  removeDirectory: ["/Applications/Extra"],
  copyOperationFailure: ["failure", "attempt"],
  copyDiagnostics: [],
  showMainWindow: [],
  showSettings: []
} satisfies Record<string, unknown[]>;
type Method = keyof typeof validArguments;
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
let handlers: Map<string, Handler>;
let effects: ReturnType<typeof vi.fn>[];
let windows: { isDestroyed: () => boolean; webContents: { mainFrame: { url: string } } }[];
let store: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(async () => {
  handlers = new Map();
  effects = [];
  const effect = (result?: unknown) => {
    const fn = vi.fn(() => result);
    effects.push(fn);
    return fn;
  };
  store = Object.fromEntries(Object.keys(validArguments).map((method) => [method, effect()]));
  store.getSnapshot = effect({});
  store.getCatalogueDiagnostics = effect("");
  store.operationFailureText = effect("Sanitized failure");
  store.addDirectory = effect();
  windows = ["main", "menubar"].map((route) => ({
    isDestroyed: () => false,
    webContents: { mainFrame: { url: `file:///fixture/index.html#/${route}` } }
  }));
  const source = await readFile("src/main/main.ts", "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = ["wireIpc", "requireBackendSender"]
    .map((name) => {
      const node = ast.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
      );
      expect(node).toBeDefined();
      return node!.getText(ast);
    })
    .join("\n");
  const js = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function(
    "ipcMain",
    "backendIpcRegistrar",
    "isTrustedBackendSender",
    "ipcChannels",
    "mainWindow",
    "menuWindow",
    "MAIN_WINDOW_VITE_DEV_SERVER_URL",
    "store",
    "metadata",
    "renderDiagnostics",
    "dialog",
    "clipboard",
    "showMainWindow",
    "BrowserWindow",
    "confirmHomebrewCleanup",
    `${js}\nwireIpc();`
  )(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    backendIpcRegistrar,
    isTrustedBackendSender,
    ipcChannels,
    ...windows,
    "file:///fixture/index.html",
    store,
    { version: "1" },
    effect("Sanitized diagnostics"),
    { showOpenDialog: effect(Promise.resolve({ canceled: true, filePaths: [] })) },
    { writeText: effect() },
    effect(),
    { fromWebContents: effect() },
    effect()
  );
});

function event(window = windows[0]!): IpcMainInvokeEvent {
  return {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame
  } as IpcMainInvokeEvent;
}
function invoke(method: Method, caller: IpcMainInvokeEvent, args: unknown[]) {
  return Promise.resolve().then(() => handlers.get(ipcChannels[method])!(caller, ...args));
}
function expectNoEffects() {
  for (const effect of effects) expect(effect).not.toHaveBeenCalled();
}

it("registers every invoke channel, excluding outbound events", () => {
  expect([...handlers.keys()].sort()).toEqual(
    Object.entries(ipcChannels)
      .filter(([name]) => !["snapshotChanged", "snapshotProgress"].includes(name))
      .map(([, channel]) => channel)
      .sort()
  );
});

it.each(Object.keys(validArguments) as Method[])(
  "rejects unauthorized senders before %s has effects",
  async (method) => {
    const main = event();
    const callers = [
      { ...main, sender: { mainFrame: main.senderFrame } },
      { ...main, senderFrame: { url: "file:///fixture/index.html#/main" } },
      { ...main, senderFrame: null }
    ] as IpcMainInvokeEvent[];
    for (const caller of callers)
      await expect(invoke(method, caller, validArguments[method])).rejects.toThrow(
        "Untrusted diagnostics caller"
      );
    for (const url of [
      "https://example.com",
      "file:///other/index.html",
      "file:///fixture/index.html?unexpected=1",
      "about:blank"
    ]) {
      windows[0]!.webContents.mainFrame.url = url;
      await expect(invoke(method, event(), validArguments[method])).rejects.toThrow(
        "Untrusted diagnostics caller"
      );
    }
    windows[0]!.webContents.mainFrame.url = "file:///fixture/index.html#/main";
    windows[0]!.isDestroyed = () => true;
    await expect(invoke(method, event(), validArguments[method])).rejects.toThrow(
      "Untrusted diagnostics caller"
    );
    expectNoEffects();
  }
);

it.each(Object.keys(validArguments) as Method[])(
  "rejects malformed %s arguments before dispatch",
  async (method) => {
    const args = validArguments[method];
    await expect(invoke(method, event(), args.length ? [null] : ["unexpected"])).rejects.toThrow(
      "Invalid IPC arguments"
    );
    await expect(invoke(method, event(), [...args, "unexpected"])).rejects.toThrow(
      "Invalid IPC arguments"
    );
    expectNoEffects();
  }
);

it.each(Object.keys(validArguments) as Method[])(
  "accepts valid %s calls from main and tray documents",
  async (method) => {
    for (const window of windows) await invoke(method, event(window), validArguments[method]);
    if (
      ![
        "getAppMetadata",
        "getDiagnostics",
        "getToolStatus",
        "cleanUpHomebrew",
        "refresh",
        "chooseDirectory",
        "copyOperationFailure",
        "copyDiagnostics",
        "showMainWindow",
        "showSettings"
      ].includes(method)
    ) {
      expect(store[method]).toHaveBeenCalledTimes(2);
      expect(store[method]).toHaveBeenCalledWith(...validArguments[method]);
    }
  }
);

it.each([
  ["refresh", ["false"]],
  ["refresh", [false, 1]],
  ["performHomebrewUpdateAll", ["cask:example"]],
  ["performHomebrewUpdateAll", [["cask:example", 1]]],
  ["performHomebrewUpdateAll", [new Array(1)]],
  ["setSelectedTab", ["settings"]],
  ["setSelectedTab", [["apps"]]],
  ["copyOperationFailure", ["failure"]],
  ["collectHomebrewDiagnostics", [{ doctor: "false" }]],
  ["collectHomebrewDiagnostics", [{ extra: true }]],
  ["installHomebrewItem", [{ ...item, kind: "other" }]],
  ["installHomebrewItem", [{ ...item, version: { raw: 1 } }]],
  ["installHomebrewItem", [{ ...item, presentation: ["app"] }]],
  ["installHomebrewItem", [{ ...item, homepageURL: 5 }]],
  ["updatePreferences", [{ showDockIcon: false, apps: [] }]],
  ["updatePreferences", [{ refreshIntervalMinutes: NaN }]],
  ["updatePreferences", [{ refreshIntervalMinutes: Infinity }]],
  ["updatePreferences", [{ autoRefreshEnabled: "false" }]],
  ["updatePreferences", [{ collapsedAppSectionIDs: [1] }]],
  ["updatePreferences", [JSON.parse('{"__proto__":{"showDockIcon":false}}')]]
] as [Method, unknown[]][])(
  "rejects invalid %s payload %# without mutation",
  async (method, args) => {
    await expect(invoke(method, event(), args)).rejects.toThrow("Invalid IPC arguments");
    expectNoEffects();
  }
);

it.each(
  [[], [undefined], [undefined, undefined], [false], [false, undefined]].map((args) => ({ args }))
)("preserves optional refresh arguments %#", async ({ args }) => {
  await invoke("refresh", event(), args);
  expect(store.refresh).toHaveBeenCalledWith(args[0], { forceAppDiscovery: args[1] });
});

it("preserves optional bulk selection and diagnostics requests", async () => {
  await invoke("performHomebrewUpdateAll", event(), []);
  await invoke("collectHomebrewDiagnostics", event(), [undefined]);
  expect(store.performHomebrewUpdateAll).toHaveBeenCalledWith(undefined);
  expect(store.collectHomebrewDiagnostics).toHaveBeenCalledWith(undefined);
});

it("preserves handler rejections without retrying or exposing payloads in validation errors", async () => {
  const error = new Error("Operation unavailable");
  store.performAppUpdate!.mockRejectedValue(error);
  await expect(invoke("performAppUpdate", event(), ["app"])).rejects.toBe(error);
  expect(store.performAppUpdate).toHaveBeenCalledOnce();
  await expect(invoke("openExternal", event(), [{ private: "SYNTHETIC_SECRET" }])).rejects.toThrow(
    /^Invalid IPC arguments$/
  );
});

it.each(["formula", "app", "cli", "package", "cask", undefined])(
  "preserves discovery installs with presentation %s",
  async (presentation) => {
    const request = {
      ...item,
      kind: presentation === "formula" ? "formula" : "cask",
      presentation
    };
    await invoke("installHomebrewItem", event(), [request]);
    expect(store.installHomebrewItem).toHaveBeenCalledWith(request);
  }
);

it("preserves an explicit empty bulk selection instead of broadening it", async () => {
  await invoke("performHomebrewUpdateAll", event(), [[]]);
  expect(store.performHomebrewUpdateAll).toHaveBeenCalledWith([]);
});

it("keeps copying sanitized failure details opt-in and returns false when unavailable", async () => {
  store.operationFailureText!.mockReturnValue(undefined);
  expect(await invoke("copyOperationFailure", event(), ["failure", "attempt"])).toBe(false);
  expect(store.operationFailureText).toHaveBeenCalledWith("failure", "attempt");
  for (const effect of effects)
    if (effect !== store.operationFailureText) expect(effect).not.toHaveBeenCalled();
});
