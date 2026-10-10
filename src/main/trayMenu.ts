// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { MenuItemConstructorOptions } from "electron";
import type { UpdateStore } from "./updateStore";

export function trayMenuTemplate(options: {
  store: Pick<UpdateStore, "getSnapshot" | "refresh">;
  showSettings: () => void;
  checkForUpdates: () => Promise<void>;
  isCheckingForUpdates: boolean;
  quit: () => void;
}): MenuItemConstructorOptions[] {
  return [
    {
      label: "Refresh",
      toolTip: "Check for updates to your installed apps and Homebrew items.",
      enabled: !options.store.getSnapshot().isRefreshing,
      click: () => {
        if (!options.store.getSnapshot().isRefreshing) void options.store.refresh(false);
      }
    },
    { label: "Settings", click: options.showSettings },
    {
      label: "Check for Updates",
      toolTip: "Check for a new version of Baseline itself.",
      enabled: !options.isCheckingForUpdates,
      click: () => {
        void options.checkForUpdates();
      }
    },
    { type: "separator" },
    { label: "Quit", click: options.quit }
  ];
}
