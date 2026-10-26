// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import type { Stats } from "node:fs";
import type { CommandResult } from "../src/main/commandRunner";
import { directSelfInstallIsVerified } from "../src/main/selfUpdateOwnership";

const host = {
  bundlePath: "/Applications/Baseline.app",
  bundleIdentifier: "com.arshiaghaf.baseline"
};
const success = (value: unknown): CommandResult => ({
  success: true,
  status: 0,
  output: typeof value === "string" ? value : JSON.stringify(value)
});
function fixture() {
  const cask = {
    token: "other",
    full_token: "other",
    tap: "homebrew/cask",
    version: "1",
    installed: "1",
    artifacts: [{ app: ["Other.app"] }]
  };
  const source = "/opt/homebrew/Caskroom/other/1/Other.app";
  const responses: Record<string, CommandResult> = {
    "list --cask --versions": success("other 1\n"),
    "info --cask --installed --json=v2": success({ casks: [cask] }),
    "--prefix": success("/opt/homebrew\n"),
    "list --cask -- other": success(source + "\n")
  };
  const run = vi.fn(async (args: string[]) => responses[args.join(" ")]!);
  const files = {
    lstat: vi.fn(async (file: string) => {
      if (file === source || file === "/opt/homebrew/bin/brew")
        return { isSymbolicLink: () => true } as Stats;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }),
    realpath: vi.fn(async (file: string) => (file === source ? "/Applications/Other.app" : file))
  };
  return {
    cask,
    source,
    responses,
    run,
    files,
    check: () => directSelfInstallIsVerified(run, host, files, { PATH: "" })
  };
}

describe("fresh self-update ownership admission", () => {
  it("admits a direct install with other Homebrew apps using actual installed artifact links", async () => {
    const f = fixture();
    await expect(f.check()).resolves.toBe(true);
    expect(f.files.realpath).toHaveBeenCalledWith(f.source);
    expect(
      f.run.mock.calls.filter(([args]) => args.join(" ") === "list --cask --versions")
    ).toHaveLength(2);
  });
  it("does not reuse a prior direct result when a receipt link later identifies the running app", async () => {
    const f = fixture();
    await expect(f.check()).resolves.toBe(true);
    f.files.realpath.mockImplementation(async (file: string) =>
      file === f.source ? host.bundlePath : file
    );
    await expect(f.check()).resolves.toBe(false);
  });
  it("preserves the managed route for renamed or custom targets, regardless of the cask token", async () => {
    const f = fixture();
    f.files.realpath.mockImplementation(async (file: string) =>
      file === f.source ? host.bundlePath : file
    );
    await expect(f.check()).resolves.toBe(false);
  });
  it("also retains the managed route when installed metadata identifies the host bundle", async () => {
    const f = fixture();
    f.responses["info --cask --installed --json=v2"] = success({
      casks: [{ ...f.cask, bundle_id: host.bundleIdentifier }]
    });
    await expect(f.check()).resolves.toBe(false);
  });
  it("does not confuse a second Homebrew scope or broken brew alias with absence", async () => {
    for (const location of ["/usr/local/Caskroom", "/usr/local/bin/brew"]) {
      const f = fixture();
      const stat = f.files.lstat.getMockImplementation()!;
      f.files.lstat.mockImplementation(async (file) =>
        file === location ? ({ isSymbolicLink: () => true } as Stats) : stat(file)
      );
      if (location.endsWith("/brew")) {
        const resolve = f.files.realpath.getMockImplementation()!;
        f.files.realpath.mockImplementation(async (file) => {
          if (file === location) throw Object.assign(new Error("broken alias"), { code: "ENOENT" });
          return resolve(file);
        });
      }
      await expect(f.check()).resolves.toBe(false);
    }
  });
  it("does not claim ownership absence for an unobserved configured prefix", async () => {
    const f = fixture();
    await expect(
      directSelfInstallIsVerified(f.run, host, f.files, { PATH: "", HOMEBREW_PREFIX: "/custom" })
    ).resolves.toBe(false);
  });
  it.each([
    "missing-info",
    "bad-list",
    "omitted-cask",
    "truncated",
    "missing-artifact",
    "broken-alias",
    "not-link",
    "package",
    "inventory-changed"
  ])("fails closed for %s", async (mode) => {
    const f = fixture();
    if (mode === "missing-info")
      f.responses["info --cask --installed --json=v2"] = { success: false, status: 1, output: "" };
    if (mode === "bad-list") f.responses["list --cask --versions"] = success("other\n");
    if (mode === "omitted-cask")
      f.responses["info --cask --installed --json=v2"] = success({ casks: [] });
    if (mode === "truncated")
      f.responses["info --cask --installed --json=v2"]!.outputTruncated = true;
    if (mode === "missing-artifact") f.responses["list --cask -- other"] = success("");
    if (mode === "broken-alias") f.files.realpath.mockRejectedValue(new Error("missing target"));
    if (mode === "not-link")
      f.files.lstat.mockResolvedValue({ isSymbolicLink: () => false } as Stats);
    if (mode === "package")
      f.responses["info --cask --installed --json=v2"] = success({
        casks: [{ ...f.cask, artifacts: [{ pkg: ["Other.pkg"] }] }]
      });
    if (mode === "inventory-changed") {
      const run = f.run.getMockImplementation()!;
      let reads = 0;
      f.run.mockImplementation(async (args) =>
        args.join(" ") === "list --cask --versions" && ++reads > 1
          ? success("other 2\n")
          : run(args)
      );
    }
    await expect(f.check().catch(() => false)).resolves.toBe(false);
  });
  it("allows only explicit tool absence, not failed probes", async () => {
    const f = fixture();
    f.run.mockResolvedValue({
      success: false,
      status: null,
      output: "",
      failure: { kind: "spawn", code: "ENOENT", message: "missing" }
    });
    f.files.lstat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(f.check()).resolves.toBe(true);
    f.run.mockResolvedValue({ success: false, status: 1, output: "" });
    await expect(f.check()).resolves.toBe(false);
  });
});
