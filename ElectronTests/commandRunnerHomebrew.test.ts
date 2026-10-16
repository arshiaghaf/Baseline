// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  failCleanup: false,
  cleanupCode: "EPERM",
  source: "process.stdout.write('fixture');",
  children: [] as import("node:child_process").ChildProcess[],
  accessGate: undefined as undefined | Promise<void>,
  onSpawn: undefined as undefined | (() => void)
}));

// All executable resolution and launch paths are redirected. These tests never
// invoke real Homebrew, even on a host where it is installed.
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  access: vi.fn(async () => {
    await control.accessGate;
  })
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((_path, _args, options) => {
      const child = actual.spawn(process.execPath, ["-e", control.source], options);
      control.children.push(child);
      control.onSpawn?.();
      return child;
    })
  };
});
vi.mock("../src/main/commandProcessGroup", () => ({
  terminateCommandGroup: vi.fn(async () => {
    if (control.failCleanup)
      throw Object.assign(new Error("fixture cleanup failure"), {
        code: control.cleanupCode
      });
  })
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  control.failCleanup = false;
  control.cleanupCode = "EPERM";
  control.source = "process.stdout.write('fixture');";
  control.accessGate = undefined;
  control.onSpawn = undefined;
});

afterEach(async () => {
  await Promise.all(
    control.children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("close", resolve);
        child.kill("SIGKILL");
      });
    })
  );
});

it.each(["EPERM", "ETIMEDOUT"])(
  "settles %s cleanup uncertainty with a live child and open pipes",
  async (code) => {
    control.failCleanup = true;
    control.cleanupCode = code;
    control.source = "setInterval(() => {}, 1000);";
    const { runBrewCommand, homebrewCleanupIsUnconfirmed } =
      await import("../src/main/commandRunner");
    const { spawn } = await import("node:child_process");
    expect(homebrewCleanupIsUnconfirmed()).toBe(false);
    const started = performance.now();
    const result = await runBrewCommand(["info"], undefined, {
      timeoutMs: 20,
      cleanupTimeoutMs: 50
    });
    expect(result.failure).toMatchObject({ kind: "cleanup", code });
    expect(homebrewCleanupIsUnconfirmed()).toBe(true);
    expect(result.success).toBe(false);
    expect(result.status).toBeNull();
    expect(result.stdout).toBe("");
    expect(performance.now() - started).toBeLessThan(500);
    const child = control.children[0]!;
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(child.stdout?.destroyed).toBe(true);
    expect(child.stderr?.destroyed).toBe(true);
    expect((await runBrewCommand(["info"])).failure?.kind).toBe("cleanup");
    expect(spawn).toHaveBeenCalledOnce();
  }
);

it("quarantines Homebrew after uncertain cleanup, including commands resolving paths", async () => {
  const { runBrewCommand } = await import("../src/main/commandRunner");
  const { spawn } = await import("node:child_process");
  let release!: () => void;
  let resolving!: ReturnType<typeof runBrewCommand>;
  control.onSpawn = () => {
    control.onSpawn = undefined;
    control.accessGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    resolving = runBrewCommand(["outdated"]);
    control.failCleanup = true;
  };
  const initial = runBrewCommand(["info"]);
  const first = await initial;
  expect(first.failure?.kind).toBe("cleanup");
  release();
  expect((await resolving).failure?.kind).toBe("cleanup");
  const quarantined = await runBrewCommand(["upgrade", "fixture"]);
  expect(quarantined.failure?.kind).toBe("cleanup");
  expect(quarantined.failure?.message).toContain("stop any remaining Homebrew processes");
  expect(spawn).toHaveBeenCalledOnce();
});

it("applies Homebrew-only environment controls to the fake executable", async () => {
  const { runBrewCommand, runCommand } = await import("../src/main/commandRunner");
  const { spawn } = await import("node:child_process");
  expect(
    (
      await runBrewCommand(["info"], undefined, {
        env: {
          HTTPS_PROXY: "fixture-proxy",
          HOMEBREW_NO_AUTO_UPDATE: "0"
        }
      })
    ).success
  ).toBe(true);
  expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({
    env: {
      HTTPS_PROXY: "fixture-proxy",
      HOMEBREW_NO_AUTO_UPDATE: "1",
      NONINTERACTIVE: "1"
    }
  });
  await runCommand("fixture", [], undefined, { env: { HOMEBREW_NO_AUTO_UPDATE: "0" } });
  expect(vi.mocked(spawn).mock.calls[1]?.[2]).toMatchObject({
    env: { HOMEBREW_NO_AUTO_UPDATE: "0" }
  });
});
