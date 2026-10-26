// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// @vitest-environment node

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { pathToFileURL } from "node:url";
import { ModuleKind, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";
import { defaultPersistedSnapshot } from "../src/shared/domain";

describe("main startup activation", () => {
  it.each(["resolve", "reject"])(
    "reopens the window while startup probes wait and after they %s",
    async (outcome) => {
      let release!: () => void;
      let reject!: (error: Error) => void;
      const probe = new Promise<void>((yes, no) => {
        release = yes;
        reject = no;
      });
      let started!: () => void;
      const starting = new Promise<void>((resolve) => {
        started = resolve;
      });
      let startup: Promise<void> | undefined;
      const electronApp = Object.assign(new EventEmitter(), {
        isPackaged: false,
        requestSingleInstanceLock: () => true,
        getPath: () => "/fixture/profile",
        setAboutPanelOptions: () => undefined,
        whenReady: () => ({
          then: (callback: () => Promise<void>) => {
            startup = callback();
            // Observe rejection even when assertions fail before releasing probes.
            void startup.catch(() => undefined);
          }
        })
      });
      const windows: FakeWindow[] = [];
      class FakeWindow extends EventEmitter {
        visible = false;
        webContents = new EventEmitter();
        constructor() {
          super();
          windows.push(this);
        }
        static getAllWindows() {
          return windows;
        }
        loadURL() {
          return Promise.resolve();
        }
        show() {
          this.visible = true;
        }
        focus() {}
        hide() {
          this.visible = false;
        }
        close() {
          const preventDefault = vi.fn();
          this.emit("close", { preventDefault });
          if (!preventDefault.mock.calls.length) this.emit("closed");
        }
      }
      const snapshot = { ...defaultPersistedSnapshot(), showMenuBarIcon: false };
      class FakeStore extends EventEmitter {
        getSnapshot() {
          return snapshot;
        }
        async verifyProfileStatsIntegrity() {}
        start() {
          started();
          return probe;
        }
      }
      const modules: Record<string, unknown> = {
        electron: {
          app: electronApp,
          BrowserWindow: FakeWindow,
          nativeTheme: {},
          powerMonitor: new EventEmitter()
        },
        "node:path": path,
        "node:fs/promises": {},
        "node:url": { pathToFileURL },
        "./appOpener": {},
        "./signedSelfUpdater": { SignedSelfUpdater: class {} },
        "./selfUpdateScheduler": {
          SelfUpdateScheduler: class {
            start() {}
            request() {}
          }
        },
        "./permissionGuide": {},
        "./adminAskpassRuntime": {},
        "./homebrewCleanupConfirmation": {},
        "./appMetadata": { appMetadata: () => ({ version: "1", buildNumber: "1" }) },
        "../shared/diagnostics": {},
        "./trayStatus": {},
        "../shared/ipc": {},
        "../shared/security": {},
        "./persistence": {
          SnapshotPersistence: class {
            async load() {
              return snapshot;
            }
          }
        },
        "./trayWindowPosition": {},
        "./updateStore": { UpdateStore: FakeStore },
        "./catalogueCacheDirectory": { catalogueCacheDirectory: () => "/fixture/cache" },
        "./backendIpcAuthorization": {},
        "./backendIpc": { backendIpcRegistrar: () => () => undefined },
        "./trayMenu": {}
      };
      const errors = vi.fn();
      const context = createContext({
        exports: {},
        require: (name: string) => {
          if (!(name in modules)) throw new Error(`Unexpected startup import: ${name}`);
          return modules[name];
        },
        __dirname: "/fixture/main",
        process: { env: {} },
        console: { error: errors },
        MAIN_WINDOW_VITE_DEV_SERVER_URL: "https://example.test",
        MAIN_WINDOW_VITE_NAME: "main_window"
      });
      const source = readFileSync(path.resolve("src/main/main.ts"), "utf8");
      try {
        runInContext(
          transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText,
          context
        );
        await starting;
        const window = windows[0]!;
        window.emit("ready-to-show");
        window.close();
        expect(window.visible).toBe(false);
        electronApp.emit("activate");
        expect(window.visible).toBe(true);
        expect(windows).toHaveLength(1);
        if (outcome === "reject") reject(new Error("synthetic probe failure"));
        else release();
        await startup;
        expect(errors).toHaveBeenCalledTimes(outcome === "reject" ? 1 : 0);
        window.close();
        electronApp.emit("activate");
        expect(window.visible).toBe(true);
        expect(electronApp.listenerCount("activate")).toBe(1);
        window.emit("closed");
        electronApp.emit("activate");
        expect(windows).toHaveLength(2);
        windows[1]!.emit("ready-to-show");
        expect(windows[1]!.visible).toBe(true);
      } finally {
        release();
        await startup?.catch(() => undefined);
      }
    }
  );
});
