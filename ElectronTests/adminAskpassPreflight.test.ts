// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommandResult } from "../src/main/commandRunner";

const fixture = vi.hoisted(() => ({ create: vi.fn(), spawn: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  access: async () => {}
}));
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));
vi.mock("../src/shared/security", async (original) => ({
  ...(await original<typeof import("../src/shared/security")>()),
  brewExecutableCandidates: () => [process.execPath]
}));
vi.mock("../src/main/homebrewConfiguration", () => ({
  checkHomebrewConfiguration: async () => ({ supported: true, revalidate: async () => true }),
  homebrewConfigurationBlockedMessage: "fixture configuration refusal"
}));
vi.mock("../src/main/adminAskpassCoordinator", () => ({
  AdminAskpassCoordinator: { create: fixture.create }
}));

let api: typeof import("../src/main/commandRunner"),
  runtime: typeof import("../src/main/adminAskpassRuntime");
const releases: (() => void)[] = [];
const pending: Promise<unknown>[] = [];
function gate() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  releases.push(resolve);
  return { promise, resolve, reject };
}
function observe(command: Promise<CommandResult>) {
  let result: CommandResult | undefined;
  pending.push(
    command.then((value) => {
      result = value;
    })
  );
  return () => result;
}
const args = ["install", "--cask", "fixture"];
const operation = { operationID: "1".repeat(32), onWaitingChanged: vi.fn() };
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  api = await import("../src/main/commandRunner");
  runtime = await import("../src/main/adminAskpassRuntime");
  await runtime.configureAdminAskpass(process.execPath); // Metadata only; never launched.
  vi.useFakeTimers();
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.allSettled(pending.splice(0));
  vi.useRealTimers();
});

it.each(["cancelled", "timeout"])(
  "disposes late setup after %s while retaining starting/active ownership",
  async (kind) => {
    const setup = gate(),
      finishing = gate();
    let callback!: (promptID: string | undefined) => void;
    const coordinator = {
      socketPath: "/fixture/socket",
      finish: vi.fn(async () => {
        await finishing.promise;
        return { cleanupConfirmed: true };
      })
    };
    fixture.create.mockImplementation(async (options) => {
      callback = options.onWaitingChanged;
      await setup.promise;
      return coordinator;
    });
    const abort = new AbortController();
    const result = observe(
      api.runBrewCommand(args, undefined, {
        adminOperation: operation,
        signal: abort.signal,
        timeoutMs: kind === "timeout" ? 15 : 0
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.create).toHaveBeenCalledTimes(1);
    if (kind === "cancelled") abort.abort();
    await vi.advanceTimersByTimeAsync(16);
    expect(result()?.failure?.kind).toBe(kind);
    expect(fixture.spawn).not.toHaveBeenCalled();
    await expect(runtime.createAdminAskpassSession(args, operation)).rejects.toThrow();
    callback("2".repeat(32));
    expect(operation.onWaitingChanged).not.toHaveBeenCalled();
    setup.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.finish).toHaveBeenCalledTimes(1);
    await expect(runtime.createAdminAskpassSession(args, operation)).rejects.toThrow();
    finishing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(runtime.configureAdminAskpass(process.execPath)).resolves.toBeUndefined();
    expect(api.homebrewCleanupIsUnconfirmed()).toBe(false);
  }
);

it("consumes delayed setup rejection after cancellation and releases starting ownership", async () => {
  const setup = gate();
  fixture.create.mockImplementation(async () => {
    await setup.promise;
    throw new Error("fixture setup rejection");
  });
  const abort = new AbortController();
  const result = observe(
    api.runBrewCommand(args, undefined, { adminOperation: operation, signal: abort.signal })
  );
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(result()?.cancelled).toBe(true);
  setup.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await expect(runtime.configureAdminAskpass(process.execPath)).resolves.toBeUndefined();
  expect(fixture.spawn).not.toHaveBeenCalled();
  expect(api.homebrewCleanupIsUnconfirmed()).toBe(false);
});

it.each(["rejection", "unconfirmed"])(
  "quarantines late setup cleanup %s without changing delivered cancellation",
  async (failure) => {
    const setup = gate();
    fixture.create.mockImplementation(async () => {
      await setup.promise;
      return {
        socketPath: "/fixture/socket",
        finish: async () => {
          if (failure === "rejection") throw new Error("fixture cleanup rejection");
          return { cleanupConfirmed: false };
        }
      };
    });
    const abort = new AbortController();
    const result = observe(
      api.runBrewCommand(args, undefined, { adminOperation: operation, signal: abort.signal })
    );
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result()?.cancelled).toBe(true);
    setup.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.homebrewCleanupIsUnconfirmed()).toBe(true);
    expect((await api.runBrewCommand(["--version"])).failure?.kind).toBe("cleanup");
    expect(result()?.failure?.kind).toBe("cancelled");
    expect(fixture.spawn).not.toHaveBeenCalled();
  }
);
