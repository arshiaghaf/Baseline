// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";
import path from "node:path";
import { createDMG } from "electron-installer-dmg";

const [appPath, dmgPath, title] = process.argv.slice(2);
if (!appPath || !dmgPath || !title || process.argv.length !== 5) {
  throw new Error("Usage: node scripts/package-dmg.mjs <app-path> <dmg-path> <volume-title>");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const layout = JSON.parse(
  await readFile(new URL("../assets/dmg/layout.json", import.meta.url), "utf8")
);
await createDMG({
  appPath: path.resolve(appPath),
  dmgPath: path.resolve(dmgPath),
  name: "Baseline",
  title,
  format: "UDZO",
  overwrite: true,
  background: path.join(root, layout.background),
  icon: path.join(root, layout.icon),
  iconSize: layout.iconSize,
  additionalDMGOptions: { window: layout.window },
  contents: [
    { ...layout.app, type: "file", path: path.resolve(appPath), name: "Baseline.app" },
    { ...layout.applications, type: "link", path: "/Applications", name: "Applications" }
  ]
});
console.log(`Created unsigned DMG: ${path.resolve(dmgPath)}`);
