// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ link: "", failCellar: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const mapped = (file: unknown) => (file === "/usr/local/bin/brew" ? fixture.link : file);
  return {
    ...fs,
    lstat: (file: Parameters<typeof fs.lstat>[0]) => {
      if (fixture.failCellar && String(file).endsWith("/Cellar"))
        return Promise.reject(Object.assign(new Error("fixture denial"), { code: "EACCES" }));
      return fs.lstat(mapped(file) as string);
    },
    readlink: (file: Parameters<typeof fs.readlink>[0]) => fs.readlink(mapped(file) as string)
  };
});
import { checkHomebrewConfiguration } from "../src/main/homebrewConfiguration";

let root: string;
afterEach(async () => {
  fixture.failCellar = false;
  if (root) await rm(root, { recursive: true, force: true });
});

it("ignores only the broken optional compatibility link, retaining strict selected-prefix checks", async () => {
  root = await mkdtemp("/tmp/baseline-compatibility-");
  const executable = path.join(root, "prefix/bin/brew");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture");
  fixture.link = path.join(root, "unrelated-brew");
  await symlink(path.join(root, "missing/bin/brew"), fixture.link);
  const env = { HOME: root };
  expect((await checkHomebrewConfiguration(executable, env)).supported).toBe(true);
  fixture.failCellar = true;
  expect((await checkHomebrewConfiguration(executable, env)).supported).toBe(false);
  fixture.failCellar = false;
  await rm(executable);
  await symlink(path.join(root, "selected-missing/bin/brew"), executable);
  expect((await checkHomebrewConfiguration(executable, env)).supported).toBe(false);
});
