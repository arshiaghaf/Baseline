// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { ResolvedForgeConfig } from "@electron-forge/shared-types";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import config from "../forge.config";
import { localAdHocSigningOptions, verifyPackagedMacSignatures } from "../macSigning.config";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const mocked = { ...actual, execFileSync: vi.fn(() => "26") };
  return { ...mocked, default: mocked };
});

describe("macOS package signing policy", () => {
  beforeEach(() => vi.mocked(execFileSync).mockReset());

  it("wires certificate-free signing and a final production verification gate", () => {
    expect(config.packagerConfig?.osxSign).toMatchObject({
      identity: "-",
      identityValidation: false,
      continueOnError: false,
      strictVerify: true,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false
    });
    expect(config.hooks?.postPackage).toBe(verifyPackagedMacSignatures);
    const options = localAdHocSigningOptions().optionsForFile?.("Fixture Helper (Renderer).app");
    expect(options).toEqual({
      hardenedRuntime: true,
      timestamp: "none",
      entitlements: ["com.apple.security.cs.allow-jit"]
    });
  });

  it.each(["arm64", "x64"] as const)(
    "verifies every %s package without replacing its signature",
    async (arch) => {
      const distributionConfig = {
        packagerConfig: {
          name: "Fixture",
          osxSign: { identity: "Developer ID Application: Fixture" }
        }
      } as ResolvedForgeConfig;
      await verifyPackagedMacSignatures(distributionConfig, {
        platform: "darwin",
        arch,
        outputPaths: ["out/one", "out/two"]
      });
      expect(vi.mocked(execFileSync).mock.calls).toEqual(
        ["out/one", "out/two"].map((output) => [
          "/usr/bin/codesign",
          ["--verify", "--deep", "--strict", "--verbose=2", path.join(output, "Fixture.app")],
          { stdio: "pipe" }
        ])
      );
    }
  );

  it("fails packaging when verification fails", async () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("invalid resource seal");
    });
    await expect(async () => {
      await verifyPackagedMacSignatures(config as ResolvedForgeConfig, {
        platform: "darwin",
        arch: "arm64",
        outputPaths: ["out/fixture"]
      });
    }).rejects.toThrow("invalid resource seal");
  });

  it("rejects a missing macOS package rather than silently skipping verification", async () => {
    await expect(
      verifyPackagedMacSignatures(config as ResolvedForgeConfig, {
        platform: "darwin",
        arch: "arm64",
        outputPaths: []
      })
    ).rejects.toThrow("No packaged macOS app");
  });

  it("leaves non-macOS packages alone", async () => {
    await verifyPackagedMacSignatures(config as ResolvedForgeConfig, {
      platform: "linux",
      arch: "x64",
      outputPaths: ["out/linux"]
    });
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
