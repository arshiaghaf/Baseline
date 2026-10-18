// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, beforeEach, expect, it, vi } from "vitest";
let runtime: typeof import("../src/main/adminAskpassRuntime");
let session: Awaited<ReturnType<typeof runtime.createAdminAskpassSession>>;
const operation = { operationID: "1".repeat(32), onWaitingChanged: () => undefined };
beforeEach(async () => {
  vi.resetModules();
  runtime = await import("../src/main/adminAskpassRuntime");
});
afterEach(async () => {
  if (session) {
    await session.coordinator.finish(true);
    runtime.releaseAdminAskpassSession(session);
    session = undefined;
  }
});

it.each([
  [["install", "--cask", "fixture"], true],
  [["uninstall", "--cask", "fixture"], true],
  [["upgrade", "--cask", "--greedy", "fixture", "other"], true],
  [["upgrade", "fixture"], false],
  [["info", "--cask", "fixture"], false],
  [["install", "--cask"], false],
  [["install", "--cask", "--force", "fixture"], false],
  [["install", "--cask", "fixture;echo"], false],
  [["upgrade", "--cask", "--greedy"], false],
  [["uninstall", "--cask", "../fixture"], false]
] as const)("grants askpass only to explicit validated cask mutation %j", (args, eligible) => {
  expect(runtime.adminAskpassEligibleCommand([...args])).toBe(eligible);
});

it("requires main-process setup and a current operation rather than metadata alone", async () => {
  expect(
    await runtime.createAdminAskpassSession(["install", "--cask", "fixture"], operation)
  ).toBeUndefined();
  await runtime.configureAdminAskpass(process.execPath);
  await expect(
    runtime.createAdminAskpassSession(["install", "--cask", "fixture"])
  ).rejects.toThrow();
  expect(await runtime.createAdminAskpassSession(["list", "--cask"], operation)).toBeUndefined();
});

it("reserves the helper across asynchronous setup and rejects overlapping operation creation", async () => {
  await runtime.configureAdminAskpass(process.execPath); // Never launched by this status-only test.
  const pending = runtime.createAdminAskpassSession(["install", "--cask", "fixture"], operation);
  try {
    await expect(
      runtime.createAdminAskpassSession(["install", "--cask", "other"], {
        ...operation,
        operationID: "2".repeat(32)
      })
    ).rejects.toThrow();
    session = await pending;
    expect(session?.environment).toMatchObject({
      SUDO_ASKPASS: process.execPath,
      HOMEBREW_BASELINE_ASKPASS_OPERATION: operation.operationID
    });
    await expect(runtime.configureAdminAskpass(process.execPath)).rejects.toThrow();
  } finally {
    session ??= await pending;
  }
});

it.each(["relative/helper", "/tmp/app.asar/admin-askpass", "/tmp/missing-admin-helper"])(
  "refuses unsupported helper path %s before any mutation",
  async (helper) => {
    await runtime.configureAdminAskpass(helper);
    await expect(
      runtime.createAdminAskpassSession(["install", "--cask", "fixture"], operation)
    ).rejects.toThrow();
  }
);
