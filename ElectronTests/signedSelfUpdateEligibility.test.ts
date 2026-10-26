// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { beforeEach, expect, it, vi } from "vitest";
import { readFile, realpath } from "node:fs/promises";
import { signedUpdaterIsAvailable } from "../src/main/signedSelfUpdater";
import { signedUpdateFeedURL } from "../src/shared/signedSelfUpdate";
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), realpath: vi.fn() }));
const options = {
  bundlePath: "/Applications/Baseline.app",
  resourcesPath: "/fixture/resources",
  home: "/fixture/home",
  packaged: true,
  isolatedProfile: false,
  platform: "darwin",
  architecture: "arm64",
  verifyOwnership: vi.fn(async () => true)
};
beforeEach(() => {
  vi.resetAllMocks();
  options.verifyOwnership.mockResolvedValue(true);
  vi.mocked(readFile).mockResolvedValue(
    JSON.stringify({
      enabled: true,
      publicKey: "pfIShU4dEXqPd5ObYNfDBiQWcXozk7estwzTnF9BamQ=",
      feedURL: signedUpdateFeedURL
    })
  );
  vi.mocked(realpath).mockResolvedValue(options.bundlePath);
});
it("admits direct installs with fresh ownership approval, independently of Homebrew presence", async () => {
  await expect(signedUpdaterIsAvailable(options)).resolves.toBe(true);
  expect(options.verifyOwnership).toHaveBeenCalledOnce();
});
it.each([
  { packaged: false },
  { isolatedProfile: true },
  { architecture: "x64" },
  { platform: "linux" },
  { verifyOwnership: undefined }
])("keeps unsupported/unverified installs manual %j", async (change) => {
  await expect(signedUpdaterIsAvailable({ ...options, ...change })).resolves.toBe(false);
});
it("does not cache approval or admit unknown ownership", async () => {
  await expect(signedUpdaterIsAvailable(options)).resolves.toBe(true);
  options.verifyOwnership.mockResolvedValue(false);
  await expect(signedUpdaterIsAvailable(options)).resolves.toBe(false);
  options.verifyOwnership.mockRejectedValue(new Error("uncertain"));
  await expect(signedUpdaterIsAvailable(options)).resolves.toBe(false);
});
it("refuses symlinked or unexpected install paths before checking ownership", async () => {
  vi.mocked(realpath).mockResolvedValue("/opt/homebrew/Caskroom/example/Baseline.app");
  await expect(signedUpdaterIsAvailable(options)).resolves.toBe(false);
  vi.mocked(realpath).mockResolvedValue("/Downloads/Baseline.app");
  await expect(
    signedUpdaterIsAvailable({ ...options, bundlePath: "/Downloads/Baseline.app" })
  ).resolves.toBe(false);
  expect(options.verifyOwnership).not.toHaveBeenCalled();
});
it.each(["{}", "{broken", JSON.stringify({ enabled: true })])(
  "fails closed for damaged config %s",
  async (contents) => {
    vi.mocked(readFile).mockResolvedValue(contents);
    await expect(signedUpdaterIsAvailable(options)).resolves.toBe(false);
  }
);
