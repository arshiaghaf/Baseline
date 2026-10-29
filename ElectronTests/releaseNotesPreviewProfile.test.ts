// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  rmSync
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { preparePreviewProfile } from "../preview/profile";

it("creates and reuses only a dedicated empty profile, including its output directories", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "notes-profile-test-"));
  try {
    const ordinary = path.join(root, "ordinary");
    mkdirSync(ordinary);
    const candidate = path.join(root, "preview");
    const profile = preparePreviewProfile(candidate, ordinary);
    expect(existsSync(path.join(profile, "logs"))).toBe(true);
    expect(existsSync(path.join(profile, "crashDumps"))).toBe(true);
    expect(preparePreviewProfile(profile, ordinary)).toBe(profile);
    const occupied = path.join(root, "occupied");
    mkdirSync(occupied);
    writeFileSync(path.join(occupied, "preferences"), "keep");
    expect(() => preparePreviewProfile(occupied, ordinary)).toThrow("empty directory");
    expect(readFileSync(path.join(occupied, "preferences"), "utf8")).toBe("keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects ordinary app-data aliases before creation and never follows profile marker links", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "notes-profile-test-"));
  try {
    const ordinary = path.join(root, "ordinary");
    mkdirSync(ordinary);
    const alias = path.join(root, "alias");
    symlinkSync(ordinary, alias);
    expect(() => preparePreviewProfile(path.join(alias, "new-profile"), ordinary)).toThrow(
      "ordinary application data"
    );
    expect(existsSync(path.join(ordinary, "new-profile"))).toBe(false);
    const outside = path.join(root, "outside");
    writeFileSync(outside, "keep");
    const candidate = path.join(root, "preview");
    mkdirSync(candidate);
    symlinkSync(outside, path.join(candidate, ".baseline-notes-preview"));
    expect(() => preparePreviewProfile(candidate, ordinary)).toThrow("marker is invalid");
    expect(readFileSync(outside, "utf8")).toBe("keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
