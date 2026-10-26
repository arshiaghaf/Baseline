// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { beforeEach, expect, it, vi } from "vitest";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { signedUpdaterIsAvailable } from "../src/main/signedSelfUpdater";
import { signedUpdateFeedURL } from "../src/shared/signedSelfUpdate";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  lstat: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn()
}));
const options = {
  bundlePath: "/Applications/Baseline.app",
  resourcesPath: "/fixture/resources",
  home: "/fixture/home",
  packaged: true,
  isolatedProfile: false,
  platform: "darwin",
  architecture: "arm64",
  environment: { PATH: "/usr/bin:/bin" }
};
const directory = { isDirectory: () => true, isSymbolicLink: () => false } as Stats;
const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readFile).mockResolvedValue(
    JSON.stringify({
      enabled: true,
      publicKey: "pfIShU4dEXqPd5ObYNfDBiQWcXozk7estwzTnF9BamQ=",
      feedURL: signedUpdateFeedURL
    })
  );
  vi.mocked(realpath).mockResolvedValue(options.bundlePath);
  vi.mocked(access).mockResolvedValue(undefined);
  vi.mocked(lstat).mockImplementation(async (file) => {
    if (["/opt", "/usr/local", "/usr/bin", "/bin"].includes(String(file))) return directory;
    throw missing();
  });
});

it("admits a configured canonical direct install only after checking package-manager absence", async () => {
  await expect(signedUpdaterIsAvailable(options)).resolves.toBe(true);
  expect(lstat).toHaveBeenCalledWith("/opt/homebrew/Caskroom");
  expect(lstat).toHaveBeenCalledWith("/usr/bin/brew");
});

it.each([
  { packaged: false },
  { isolatedProfile: true },
  { architecture: "x64" },
  { platform: "linux" },
  { environment: { HOMEBREW_PREFIX: "/custom" } },
  { environment: { HOMEBREW_CELLAR: "/custom/Cellar" } }
])("retains the manual route for unsupported or ambiguous installations %j", async (change) => {
  await expect(signedUpdaterIsAvailable({ ...options, ...change })).resolves.toBe(false);
});

it.each(["/opt/homebrew/bin/brew", "/opt/homebrew/Caskroom", "/usr/local/bin/brew"])(
  "never replaces installations with package-manager evidence at %s",
  async (present) => {
    const previous = vi.mocked(lstat).getMockImplementation()!;
    vi.mocked(lstat).mockImplementation(async (file) =>
      String(file) === present ? directory : previous(file)
    );
    await expect(signedUpdaterIsAvailable(options)).resolves.toBe(false);
  }
);

it("refuses inaccessible parents and broken aliases rather than recording package-manager absence", async () => {
  vi.mocked(access).mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
  await expect(signedUpdaterIsAvailable(options)).resolves.toBe(false);
});

it("refuses symlinked or unexpected installation paths", async () => {
  vi.mocked(realpath).mockResolvedValue("/opt/homebrew/Caskroom/example/Baseline.app");
  await expect(signedUpdaterIsAvailable(options)).resolves.toBe(false);
  vi.mocked(realpath).mockResolvedValue("/Downloads/Baseline.app");
  await expect(
    signedUpdaterIsAvailable({ ...options, bundlePath: "/Downloads/Baseline.app" })
  ).resolves.toBe(false);
});

it.each(["missing", "{}", "{broken", JSON.stringify({ enabled: true })])(
  "retains the manual route with damaged/missing configuration %s",
  async (contents) => {
    if (contents === "missing") vi.mocked(readFile).mockRejectedValue(missing());
    else vi.mocked(readFile).mockResolvedValue(contents);
    await expect(signedUpdaterIsAvailable(options)).resolves.toBe(false);
  }
);
