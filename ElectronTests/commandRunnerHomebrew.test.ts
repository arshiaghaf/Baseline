// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { beforeEach, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  failCleanup: false,
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
      const child = actual.spawn(
        process.execPath,
        ["-e", "process.stdout.write('fixture');"],
        options
      );
      control.onSpawn?.();
      return child;
    })
  };
});
vi.mock("../src/main/commandProcessGroup", () => ({
  terminateCommandGroup: vi.fn(async () => {
    if (control.failCleanup) throw new Error("fixture permission failure");
  })
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  control.failCleanup = false;
  control.accessGate = undefined;
  control.onSpawn = undefined;
});

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
  expect((await runBrewCommand(["upgrade", "fixture"])).failure?.kind).toBe("cleanup");
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
