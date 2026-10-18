// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ brew: "", uncertain: false }));
vi.mock("../src/shared/security", async (original) => ({
  ...(await original<object>()),
  brewExecutableCandidates: () => [fixture.brew]
}));
vi.mock("../src/main/commandProcessGroup", async (original) => {
  const actual = await original<typeof import("../src/main/commandProcessGroup")>();
  return {
    terminateCommandGroup: async (...args: Parameters<typeof actual.terminateCommandGroup>) => {
      await actual.terminateCommandGroup(...args);
      if (fixture.uncertain)
        throw Object.assign(new Error("fixture cleanup uncertainty"), { code: "EPERM" });
    }
  };
});

describe.skipIf(process.platform !== "darwin" || existsSync("/etc/homebrew/brew.env"))(
  "command integration with unmodified Homebrew launcher and native-only fake sudo",
  () => {
    let directory: string, helper: string, driver: string, prefix: string, launches: string;
    let api: typeof import("../src/main/commandRunner"),
      runtime: typeof import("../src/main/adminAskpassRuntime");
    let env: NodeJS.ProcessEnv;
    beforeAll(async () => {
      directory = await mkdtemp("/tmp/baseline command integration ");
      helper = path.join(directory, "native helper");
      driver = path.join(directory, "policy fixture");
      execFileSync("/usr/bin/xcrun", [
        "clang",
        "-fobjc-arc",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-framework",
        "Foundation",
        "native/admin-askpass/main.m",
        "ElectronTests/Fixtures/adminAskpassDialog.m",
        "-o",
        helper
      ]);
      execFileSync("/usr/bin/xcrun", [
        "clang",
        "-Wall",
        "-Wextra",
        "-Werror",
        "ElectronTests/Fixtures/adminAskpassSudoFixture.c",
        "-o",
        driver
      ]);
    }, 90000);
    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    beforeEach(async () => {
      fixture.uncertain = false;
      vi.resetModules();
      api = await import("../src/main/commandRunner");
      runtime = await import("../src/main/adminAskpassRuntime");
      prefix = await mkdtemp(path.join(directory, "prefix "));
      launches = path.join(prefix, "launches");
      fixture.brew = path.join(prefix, "bin/brew");
      for (const name of ["bin", "Library/Homebrew", "user"])
        await mkdir(path.join(prefix, name), { recursive: true });
      await copyFile("ElectronTests/Fixtures/Homebrew/brew", fixture.brew);
      await chmod(fixture.brew, 0o755);
      await writeFile(
        path.join(prefix, "Library/Homebrew/brew.sh"),
        '#!/bin/bash\nprintf x >> "$HOMEBREW_BASELINE_TEST_LAUNCH_FILE"\nif [[ "$2" == --cask && ( "$1" == install || "$1" == upgrade || "$1" == uninstall ) ]]; then\n exec "$HOMEBREW_BASELINE_TEST_DRIVER" "$SUDO_ASKPASS" "$HOMEBREW_BASELINE_TEST_MODE"\nfi\n[[ -z "${SUDO_ASKPASS+x}" && -z "${HOMEBREW_BASELINE_ASKPASS_SOCKET+x}" && -z "${HOMEBREW_BASELINE_ASKPASS_OPERATION+x}" ]] || exit 31\nprintf read\n'
      );
      env = {
        HOME: path.join(prefix, "user"),
        PWD: prefix,
        XDG_CONFIG_HOME: undefined,
        HOMEBREW_XDG_CONFIG_HOME: undefined,
        HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY: undefined,
        SUDO_ASKPASS: "/inherited helper",
        HOMEBREW_BASELINE_ASKPASS_SOCKET: "/untrusted",
        HOMEBREW_BASELINE_ASKPASS_OPERATION: "untrusted",
        HOMEBREW_BASELINE_TEST_DRIVER: driver,
        HOMEBREW_BASELINE_TEST_LAUNCH_FILE: launches
      };
      await runtime.configureAdminAskpass(helper);
    });
    afterEach(async () => {
      await rm(prefix, { recursive: true, force: true });
    });

    it.each([
      ["correct", true, undefined, false, 1],
      ["wrong-then-correct", true, undefined, false, 2],
      ["exhaustion", false, undefined, false, 5],
      ["empty", false, undefined, false, 1],
      ["cancel", false, "cancelled", true, 1],
      ["cancel-after-rejection", false, "cancelled", true, 2],
      ["crash", false, "admin-helper", false, 1],
      ["missing-completion", false, "admin-helper", false, 1],
      ["cached", true, undefined, false, 0],
      ["no-sudo", true, undefined, false, 0]
    ] as const)(
      "handles %s without a Node answer channel or whole-command retry",
      async (mode, success, failureKind, cancelled, prompts) => {
        const waiting = vi.fn(),
          lines = vi.fn();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const command = api.runBrewCommand(["upgrade", "--cask", "--greedy", "fixture"], lines, {
          env: { ...env, HOMEBREW_BASELINE_TEST_MODE: mode },
          signal: controller.signal,
          adminOperation: { operationID: "1".repeat(32), onWaitingChanged: waiting }
        });
        try {
          const result = await command;
          expect(result.success).toBe(success);
          expect(result.failure?.kind).toBe(failureKind);
          expect(api.commandWasCancelled(result)).toBe(cancelled);
          expect(api.homebrewCleanupIsUnconfirmed()).toBe(false);
          expect(waiting.mock.calls.filter(([id]) => id !== undefined)).toHaveLength(prompts);
          expect(result.output).toBe("");
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe("");
          expect(result.outputTail ?? "").toBe("");
          expect(lines).not.toHaveBeenCalled();
          expect(await readFile(launches, "utf8")).toBe("x");
        } finally {
          clearTimeout(timer);
          controller.abort();
          await command;
        }
      },
      15000
    );

    it.each(["synchronous", "deferred"] as const)(
      "cancels during %s waiting publication under the existing cleanup budget",
      async (timing) => {
        const controller = new AbortController();
        let seen = false;
        const command = api.runBrewCommand(["install", "--cask", "fixture"], undefined, {
          env: { ...env, HOMEBREW_BASELINE_TEST_MODE: "hold" },
          signal: controller.signal,
          adminOperation: {
            operationID: "2".repeat(32),
            onWaitingChanged: (id) => {
              if (id && !seen) {
                seen = true;
                if (timing === "synchronous") controller.abort();
                else queueMicrotask(() => controller.abort());
              }
            }
          }
        });
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const result = await command;
          expect(seen).toBe(true);
          expect(result.cancelled).toBe(true);
          expect(result.failure?.kind).toBe("cancelled");
          expect(api.homebrewCleanupIsUnconfirmed()).toBe(false);
          expect(runtime.focusAdminAskpass("2".repeat(32), "3".repeat(32))).toBe(false);
        } finally {
          clearTimeout(timer);
          controller.abort();
          await command;
        }
      },
      15000
    );

    it.each([["--version"], ["list", "--cask"], ["upgrade", "fixture"], ["update"], ["cleanup"]])(
      "never enables askpass for noneligible command %j",
      async (...args) => {
        const waiting = vi.fn();
        const result = await api.runBrewCommand(args, undefined, {
          env,
          adminOperation: { operationID: "1".repeat(32), onWaitingChanged: waiting }
        });
        expect(result.success).toBe(true);
        expect(result.output).toBe("read");
        expect(waiting).not.toHaveBeenCalled();
      }
    );

    it("fails closed before launching a cask mutation when the packaged helper is missing", async () => {
      await runtime.configureAdminAskpass(path.join(prefix, "missing helper"));
      const result = await api.runBrewCommand(["install", "--cask", "fixture"], undefined, {
        env,
        adminOperation: { operationID: "1".repeat(32), onWaitingChanged: vi.fn() }
      });
      expect(result.failure?.kind).toBe("admin-helper");
      expect(existsSync(launches)).toBe(false);
    });

    it("keeps cancellation latched when cleanup uncertainty quarantines the command runner", async () => {
      fixture.uncertain = true;
      const result = await api.runBrewCommand(["install", "--cask", "fixture"], undefined, {
        env: { ...env, HOMEBREW_BASELINE_TEST_MODE: "cancel" },
        adminOperation: { operationID: "1".repeat(32), onWaitingChanged: vi.fn() }
      });
      expect(result.cancelled).toBe(true);
      expect(result.failure?.kind).toBe("cleanup");
      expect(api.homebrewCleanupIsUnconfirmed()).toBe(true);
      expect((await api.runBrewCommand(["--version"], undefined, { env })).failure?.kind).toBe(
        "cleanup"
      );
      expect(await readFile(launches, "utf8")).toBe("x");
    });

    it("does not let inherited metadata grant operation eligibility without a current context", async () => {
      const result = await api.runBrewCommand(["install", "--cask", "fixture"], undefined, { env });
      expect(result.failure?.kind).toBe("admin-helper");
      expect(existsSync(launches)).toBe(false);
    });
  }
);
