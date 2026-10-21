// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  realpath: vi.fn(async (value: string) => value),
  stat: vi.fn(async () => ({ isDirectory: () => true })),
  icon: { isEmpty: () => false, toDataURL: () => "data:image/png;base64,fixture" },
  getFileIcon: vi.fn(),
  openExternal: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  writeText: vi.fn(),
  packaged: true,
  exe: "/Applications/Baseline.app/Contents/MacOS/Baseline"
}));
vi.mock("node:fs", () => ({
  realpathSync: (value: string) => value,
  statSync: () => ({ isDirectory: () => true })
}));
vi.mock("node:fs/promises", () => ({ realpath: mocks.realpath, stat: mocks.stat }));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.packaged;
    },
    getPath: (name: string) => (name === "exe" ? mocks.exe : "/Users/fixture"),
    getFileIcon: mocks.getFileIcon
  },
  shell: {
    openExternal: mocks.openExternal,
    openPath: mocks.openPath,
    showItemInFolder: mocks.showItemInFolder
  },
  clipboard: { writeText: mocks.writeText },
  nativeImage: { createEmpty: () => ({ isEmpty: () => true }) }
}));
import {
  installedPermissionGuideBundle,
  performPermissionGuideAction
} from "../src/main/permissionGuide";
import type { WebContents } from "electron";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.packaged = true;
  mocks.exe = "/Applications/Baseline.app/Contents/MacOS/Baseline";
  mocks.realpath.mockImplementation(async (value) => value);
  mocks.getFileIcon.mockReset().mockResolvedValue(mocks.icon);
  mocks.openExternal.mockResolvedValue(undefined);
  mocks.openPath.mockResolvedValue("");
  await performPermissionGuideAction("close", {} as WebContents, { show: vi.fn(), close: vi.fn() });
});

it.each([
  [true, "/Applications/Baseline.app/Contents/MacOS/Baseline", "/Applications/Baseline.app"],
  [
    true,
    "/Users/fixture/Applications/Baseline.app/Contents/MacOS/Baseline",
    "/Users/fixture/Applications/Baseline.app"
  ],
  [false, "/Applications/Baseline.app/Contents/MacOS/Baseline", undefined],
  [true, "/tmp/out/Baseline.app/Contents/MacOS/Baseline", undefined],
  [true, "/Volumes/Baseline/Baseline.app/Contents/MacOS/Baseline", undefined],
  [
    true,
    "/Applications/Baseline.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
    undefined
  ],
  [true, "/Applications/Other.app/Contents/MacOS/Baseline", undefined],
  [
    true,
    "/Applications/Container.APP/Contents/Resources/Baseline.app/Contents/MacOS/Baseline",
    undefined
  ]
])(
  "restricts drag identity to the running installed bundle: %s %s",
  async (packaged, executable, expected) => {
    await expect(
      installedPermissionGuideBundle({ packaged, executable, home: "/Users/fixture" })
    ).resolves.toBe(expected);
  }
);

it("rejects a symlinked installed path resolving to a preview and refuses drag without an icon", async () => {
  mocks.realpath.mockResolvedValueOnce("/tmp/out/Baseline.app/Contents/MacOS/Baseline");
  await expect(
    installedPermissionGuideBundle({
      packaged: true,
      executable: mocks.exe,
      home: "/Users/fixture"
    })
  ).resolves.toBeUndefined();
  mocks.getFileIcon.mockRejectedValueOnce(new Error("icon unavailable"));
  const sender = { startDrag: vi.fn() };
  const info = await performPermissionGuideAction("info", sender as unknown as WebContents, {
    show: vi.fn(),
    close: vi.fn()
  });
  expect(info.message).toContain("icon could not be loaded");
  const result = await performPermissionGuideAction("drag", sender as unknown as WebContents, {
    show: vi.fn(),
    close: vi.fn()
  });
  expect(result.message).toContain("not ready to drag");
  expect(sender.startDrag).not.toHaveBeenCalled();
});

it("uses only the verified bundle for native dragging and reports no permission grant", async () => {
  const sender = { startDrag: vi.fn() };
  await performPermissionGuideAction("info", sender as unknown as WebContents, {
    show: vi.fn(),
    close: vi.fn()
  });
  const result = await performPermissionGuideAction("drag", sender as unknown as WebContents, {
    show: vi.fn(),
    close: vi.fn()
  });
  expect(sender.startDrag).toHaveBeenCalledWith({
    file: "/Applications/Baseline.app",
    icon: mocks.icon
  });
  expect(result).toEqual({ appPath: "/Applications/Baseline.app" });
  expect(mocks.openExternal).not.toHaveBeenCalled();
});

it("opens only the fixed Settings destination with a manual fallback, without granting access", async () => {
  const windows = { show: vi.fn(), close: vi.fn() };
  mocks.openExternal.mockRejectedValueOnce(new Error("URL rejected"));
  const result = await performPermissionGuideAction("show", {} as WebContents, windows);
  expect(windows.show).toHaveBeenCalledOnce();
  expect(mocks.openExternal).toHaveBeenCalledWith(
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AppBundles"
  );
  expect(mocks.openPath).toHaveBeenCalledWith("/System/Applications/System Settings.app");
  expect(result.message).toContain("Open Privacy & Security");
  expect(result).not.toHaveProperty("granted");
});
