// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { shell } from "electron";

export async function openAppBundle(bundlePath: string): Promise<void> {
  // Electron resolves with an error string when Launch Services cannot open a path.
  const error = await shell.openPath(bundlePath);
  if (error) throw new Error("Could not open the app.");
}
