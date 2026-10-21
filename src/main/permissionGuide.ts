// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { app, clipboard, nativeImage, shell, type WebContents, type NativeImage } from "electron";
import { realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { PermissionGuideAction, PermissionGuideInfo } from "../shared/permissionGuide";

const settingsURL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AppBundles";
const settingsPath = "/System/Applications/System Settings.app";

// The payload is always the currently running installed bundle. Renderer input
// cannot select a file, executable, URL, or permission to grant.
function installedBundlePath(executable: string, home: string): string | undefined {
  const bundle = path.resolve(executable, "../../..");
  if (
    path.basename(bundle) !== "Baseline.app" ||
    executable !== path.join(bundle, "Contents", "MacOS", "Baseline")
  )
    return;
  const installed = ["/Applications", path.join(home, "Applications")].some((root) => {
    const relative = path.relative(root, bundle);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      !relative
        .split(path.sep)
        .slice(0, -1)
        .some((part) => part.toLowerCase().endsWith(".app"))
    );
  });
  return installed ? bundle : undefined;
}

export async function installedPermissionGuideBundle(options: {
  packaged: boolean;
  executable: string;
  home: string;
}): Promise<string | undefined> {
  if (!options.packaged) return;
  try {
    const bundle = installedBundlePath(await realpath(options.executable), options.home);
    return bundle && (await stat(bundle)).isDirectory() ? bundle : undefined;
  } catch {
    return;
  }
}

let preparedDrag: { appPath: string; icon: NativeImage } | undefined;

export async function performPermissionGuideAction(
  action: PermissionGuideAction,
  sender: WebContents,
  windows: { show(): void; close(): void }
): Promise<PermissionGuideInfo> {
  if (action === "close") {
    preparedDrag = undefined;
    windows.close();
    return {};
  }
  if (action === "show") windows.show();
  if (action === "show" || action === "settings") {
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
        ? installedBundlePath(realpathSync(app.getPath("exe")), app.getPath("home"))
        : undefined;
      if (current && preparedDrag?.appPath === current && statSync(current).isDirectory()) {
        sender.startDrag({ file: current, icon: preparedDrag.icon });
        return { appPath: current };
      }
    } catch {
      /* Keep manual alternatives usable when the app moved. */
    }
    return {
      message: "The installed app is not ready to drag. Reopen the guide or select it in Settings."
    };
  }
  const appPath = await installedPermissionGuideBundle({
    packaged: app.isPackaged,
    executable: app.getPath("exe"),
    home: app.getPath("home")
  });
  if (!appPath)
    return {
      message:
        "Drag is available only from an installed copy in Applications. Select your installed Baseline.app in Settings instead."
    };
  if (action === "finder") {
    shell.showItemInFolder(appPath);
    return { appPath };
  }
  if (action === "copy") {
    clipboard.writeText(appPath);
    return { appPath, message: "App path copied." };
  }
  const icon = await app
    .getFileIcon(appPath, { size: "large" })
    .catch(() => nativeImage.createEmpty());
  if (icon.isEmpty())
    return {
      appPath,
      message: "The app icon could not be loaded. Use Show in Finder or select the app in Settings."
    };
  preparedDrag = { appPath, icon };
  return { appPath, iconDataURL: icon.toDataURL() };
}
