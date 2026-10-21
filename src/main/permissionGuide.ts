// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { app, clipboard, shell, type WebContents, type NativeImage } from "electron";
import { realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { permissionGuideIcon } from "./permissionGuideIcon";
import type { PermissionGuideAction, PermissionGuideInfo } from "../shared/permissionGuide";

const settingsURL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AppBundles";
const settingsPath = "/System/Applications/System Settings.app";

// Renderer input never chooses the file. Only the running packaged outer app
// bundle can be dragged, including a separately named preview. macOS decides
// whether its permission pane accepts the drop; no location implies a grant.
function runningBundlePath(executable: string): string | undefined {
  const bundle = path.resolve(executable, "../../..");
  if (
    !path.isAbsolute(executable) ||
    !path.basename(bundle).toLowerCase().endsWith(".app") ||
    executable !== path.join(bundle, "Contents", "MacOS", "Baseline")
  )
    return;
  if (
    path
      .dirname(bundle)
      .split(path.sep)
      .some((part) => part.toLowerCase().endsWith(".app"))
  )
    return;
  return bundle;
}

export async function runningPermissionGuideBundle(options: {
  packaged: boolean;
  executable: string;
}): Promise<string | undefined> {
  if (!options.packaged) return;
  try {
    const bundle = runningBundlePath(await realpath(options.executable));
    return bundle && (await stat(bundle)).isDirectory() ? bundle : undefined;
  } catch {
    return;
  }
}

let preparedDrag: { appPath: string; icon: NativeImage } | undefined;

export async function performPermissionGuideAction(
  action: PermissionGuideAction,
  sender: WebContents,
  windows: { show(): void; close(): void; fit?(): Promise<void> | void }
): Promise<PermissionGuideInfo> {
  if (action === "fit") {
    await windows.fit?.();
    return {};
  }
  if (action === "close") {
    preparedDrag = undefined;
    windows.close();
    return {};
  }
  if (action === "show") {
    windows.show();
    return {};
  }
  if (action === "settings") {
    try {
      // This pane URL is a best-effort macOS convention, not a grant or proof
      // of navigation. The guide always retains the manual Settings path.
      await shell.openExternal(settingsURL);
      return { message: "Settings requested. Confirm that App Management is open." };
    } catch {
      const error = await shell.openPath(settingsPath).catch(() => "Could not open Settings");
      return {
        message: error
          ? "Could not open Settings. Use the Apple menu → System Settings."
          : "Open Privacy & Security → App Management in Settings."
      };
    }
  }
  if (action === "drag") {
    // Native dragging starts during the IPC dispatch of the user's drag gesture.
    // Prepare the icon ahead of time, then synchronously recheck the fixed bundle
    // identity so async icon/filesystem work cannot outlive that gesture.
    try {
      const current = app.isPackaged
        ? runningBundlePath(realpathSync(app.getPath("exe")))
        : undefined;
      if (current && preparedDrag?.appPath === current && statSync(current).isDirectory()) {
        sender.startDrag({ file: current, icon: preparedDrag.icon });
        return { appPath: current };
      }
    } catch {
      /* Keep manual alternatives usable when the app moved. */
    }
    return {
      message: "The running app is not ready to drag. Reopen the guide or select it in Settings."
    };
  }
  const appPath = await runningPermissionGuideBundle({
    packaged: app.isPackaged,
    executable: app.getPath("exe")
  });
  if (!appPath) return { message: "Run a packaged copy of Baseline to drag its app bundle." };
  if (action === "finder") {
    shell.showItemInFolder(appPath);
    return { appPath };
  }
  if (action === "copy") {
    clipboard.writeText(appPath);
    return { appPath, message: "App path copied." };
  }
  const icon = await permissionGuideIcon(appPath);
  if (icon.isEmpty())
    return {
      appPath,
      message: "The app icon could not be loaded. Use + in Settings to select Baseline."
    };
  preparedDrag = { appPath, icon };
  return {
    appPath,
    appName: path.basename(appPath, ".app"),
    iconDataURL: icon.toDataURL({ scaleFactor: 2 })
  };
}
