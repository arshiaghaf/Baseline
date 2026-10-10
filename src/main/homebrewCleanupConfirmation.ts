// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { dialog, type BrowserWindow } from "electron";

export async function confirmHomebrewCleanup(window?: BrowserWindow | null): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    title: "Clean up Homebrew?",
    message: "Clean up Homebrew?",
    detail:
      "Homebrew will clean up old package versions and downloads across its installation. Unused dependencies may also be removed, according to your Homebrew settings. This applies to all Homebrew packages, including ignored items. It cannot be undone.",
    buttons: ["Cancel", "Clean up"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}
