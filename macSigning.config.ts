// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { ForgeHookFn, ForgePackagerOptions } from "@electron-forge/shared-types";
import { execFileSync } from "node:child_process";
import path from "node:path";

// Packager supports this fail-closed option at runtime but omits it from its type.
type MacSigningOptions = Exclude<NonNullable<ForgePackagerOptions["osxSign"]>, true> & {
  continueOnError: false;
};

// Local integrity only: no certificate, provisioning profile, or notarization.
// Distribution builds can replace packagerConfig.osxSign with their own policy;
// the post-package hook verifies that signature without re-signing it.
export function localAdHocSigningOptions(): MacSigningOptions {
  return {
    identity: "-",
    identityValidation: false,
    continueOnError: false,
    strictVerify: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: () => ({
      // Preserve the existing local runtime policy. Ad-hoc signatures have no
      // Team ID, so hardened library validation cannot load Electron Framework.
      // Certificate-based distribution signing needs its own runtime policy.
      hardenedRuntime: false,
      timestamp: "none",
      // V8 needs JIT in the main and renderer processes. No device permissions
      // or disable-library-validation entitlement is added.
      entitlements: ["com.apple.security.cs.allow-jit"]
    })
  };
}

export function verifyMacBundle(appPath: string): void {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "pipe"
  });
}

export const verifyPackagedMacSignatures: ForgeHookFn<"postPackage"> = async (config, result) => {
  if (result.platform !== "darwin" && result.platform !== "mas") {
    return;
  }
  if (result.outputPaths.length === 0) {
    throw new Error("No packaged macOS app was produced for signature verification.");
  }
  for (const outputPath of result.outputPaths) {
    verifyMacBundle(path.join(outputPath, `${config.packagerConfig.name}.app`));
  }
};
