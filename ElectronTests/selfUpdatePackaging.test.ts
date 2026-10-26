// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { execFileSync } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { packageSelfUpdater } from "../selfUpdatePackaging.config";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  mkdtemp: vi.fn(),
  cp: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn()
}));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

it("does not package a native installer or read a key for ordinary builds", async () => {
  vi.stubEnv("BASELINE_ENABLE_SIGNED_UPDATES", "0");
  await packageSelfUpdater("/fixture/app");
  expect(readFile).not.toHaveBeenCalled();
  expect(execFileSync).not.toHaveBeenCalled();
});

it("rejects an altered framework archive before extraction or compilation", async () => {
  vi.stubEnv("BASELINE_ENABLE_SIGNED_UPDATES", "1");
  vi.stubEnv("BASELINE_SELF_UPDATE_PUBLIC_KEY", "pfIShU4dEXqPd5ObYNfDBiQWcXozk7estwzTnF9BamQ=");
  vi.mocked(readFile).mockResolvedValue(Buffer.from("altered archive"));
  await expect(packageSelfUpdater("/fixture/app")).rejects.toThrow(/verification/);
  expect(mkdtemp).not.toHaveBeenCalled();
  expect(execFileSync).not.toHaveBeenCalled();
});
