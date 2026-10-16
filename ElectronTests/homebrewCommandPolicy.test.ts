// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const executable = vi.hoisted(() => ({ path: "" }));
vi.mock("../src/shared/security", async (original) => ({
  ...(await original<object>()),
  brewExecutableCandidates: () => [executable.path]
}));
import { runBrewCommand } from "../src/main/commandRunner";

describe.skipIf(existsSync("/etc/homebrew/brew.env"))(
  "Homebrew askpass policy through the real launcher",
  () => {
    let directory: string, configuration: string;
    let environment: NodeJS.ProcessEnv;
    beforeEach(async () => {
      directory = await mkdtemp("/tmp/baseline command policy ");
      executable.path = path.join(directory, "bin/brew");
      configuration = path.join(directory, "etc/homebrew/brew.env");
      for (const name of ["bin", "etc/homebrew", "Library/Homebrew", "user"])
        await mkdir(path.join(directory, name), { recursive: true });
      await copyFile("ElectronTests/Fixtures/Homebrew/brew", executable.path);
      await chmod(executable.path, 0o755);
      await writeFile(
        path.join(directory, "Library/Homebrew/brew.sh"),
        '#!/bin/bash\n[[ -z "${SUDO_ASKPASS+x}" && -z "${HOMEBREW_BASELINE_ASKPASS_SOCKET+x}" && -z "${HOMEBREW_BASELINE_ASKPASS_OPERATION+x}" && -z "${BASELINE_ASKPASS_SOCKET+x}" ]] || exit 31\nprintf "fixture completed"\n'
      );
      environment = {
        HOME: path.join(directory, "user"),
        PWD: directory,
        XDG_CONFIG_HOME: undefined,
        HOMEBREW_XDG_CONFIG_HOME: undefined,
        HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY: undefined,
        SUDO_ASKPASS: "/inherited helper",
        HOMEBREW_BASELINE_ASKPASS_SOCKET: "/inherited socket",
        HOMEBREW_BASELINE_ASKPASS_OPERATION: "untrusted",
        BASELINE_ASKPASS_SOCKET: "/untrusted socket"
      };
    });
    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it.each([
      ["--version"],
      ["list", "--cask", "--versions"],
      ["upgrade", "fixture"],
      ["install", "--cask", "fixture"]
    ])("clears inherited helper metadata for %j, including caller overlays", async (...args) => {
      const changed = vi.fn();
      const result = await runBrewCommand(args, undefined, {
        env: environment,
        adminOperation: { operationID: "1".repeat(32), onWaitingChanged: changed }
      });
      expect(result.success).toBe(true);
      expect(result.output).toBe("fixture completed");
      expect(changed).not.toHaveBeenCalled();
    });

    it.each([["--version"], ["upgrade", "--cask", "fixture"]])(
      "refuses configuration before execution for %j",
      async (...args) => {
        await writeFile(configuration, "SUDO_ASKPASS=/configured helper\n");
        const result = await runBrewCommand(args, undefined, { env: environment });
        expect(result).toMatchObject({
          success: false,
          status: null,
          output: "",
          stdout: "",
          stderr: "",
          failure: { kind: "configuration-blocked" }
        });
        expect(JSON.stringify(result)).not.toContain("/configured helper");
        expect(result.outputTail).toBeUndefined();
      }
    );
  }
);
