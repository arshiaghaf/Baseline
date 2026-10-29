// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import os from "node:os";

const markerText = "Isolated read-only release-notes preview\n";

/** Run before Electron readiness; never adopt an ordinary or aliased app-data profile. */
export function preparePreviewProfile(candidate: string | undefined, appData: string): string {
  const input = candidate ?? mkdtempSync(path.join(os.tmpdir(), "baseline-notes-preview-"));
  const resolved = path.resolve(input);
  const parent = realpathSync(path.dirname(resolved));
  const canonicalCandidate = path.join(parent, path.basename(resolved));
  const ordinary = realpathSync(appData);
  if (
    canonicalCandidate === path.parse(canonicalCandidate).root ||
    canonicalCandidate === realpathSync(os.homedir()) ||
    canonicalCandidate === ordinary ||
    canonicalCandidate.startsWith(`${ordinary}${path.sep}`)
  )
    throw new Error("Use a dedicated preview directory outside ordinary application data.");
  if (existsSync(canonicalCandidate)) {
    const entry = lstatSync(canonicalCandidate);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("The preview profile must be a real dedicated directory.");
  } else mkdirSync(canonicalCandidate, { mode: 0o700 });
  const profile = realpathSync(canonicalCandidate);
  const marker = path.join(profile, ".baseline-notes-preview");
  const entries = readdirSync(profile);
  if (entries.includes(".baseline-notes-preview")) {
    const entry = lstatSync(marker);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !readFileSync(marker, "utf8").startsWith(markerText)
    )
      throw new Error("The preview profile marker is invalid.");
  } else {
    if (entries.length)
      throw new Error(
        "The preview requires an empty directory or an existing marked preview profile."
      );
    writeFileSync(marker, markerText, { flag: "wx", mode: 0o600 });
  }
  for (const name of ["logs", "crashDumps"]) {
    const folder = path.join(profile, name);
    if (existsSync(folder)) {
      const entry = lstatSync(folder);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Preview output folders must remain inside the dedicated profile.");
    } else mkdirSync(folder, { mode: 0o700 });
  }
  return profile;
}
