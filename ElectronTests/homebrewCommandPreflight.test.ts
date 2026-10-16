// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommandResult } from "../src/main/commandRunner";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  check: vi.fn(),
  spawn: vi.fn(),
  terminate: vi.fn()
}));
vi.mock("node:fs/promises", () => ({ access: mocks.access }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/shared/security", async (original) => ({
  ...(await original<typeof import("../src/shared/security")>()),
  brewExecutableCandidates: () => ["/fixture/bin/brew"]
}));
vi.mock("../src/main/homebrewConfiguration", () => ({
  checkHomebrewConfiguration: mocks.check,
  homebrewConfigurationBlockedMessage: "fixture configuration refusal"
}));
vi.mock("../src/main/commandProcessGroup", () => ({ terminateCommandGroup: mocks.terminate }));
import { runBrewCommand } from "../src/main/commandRunner";

const pending: Promise<unknown>[] = [];
const releases: (() => void)[] = [];
let revalidate: ReturnType<typeof vi.fn>;
let autoExit: boolean;
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
function stall(stage: string, promise: Promise<void>) {
  if (stage === "resolution") mocks.access.mockImplementation(() => promise);
  if (stage === "check")
    mocks.check.mockImplementation(async () => {
      await promise;
      return { supported: true, revalidate };
    });
  if (stage === "revalidate")
    revalidate.mockImplementation(async () => {
      await promise;
      return true;
    });
  if (stage === "final revalidation")
    revalidate.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      await promise;
      return true;
    });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  autoExit = true;
  revalidate = vi.fn(async () => true);
  mocks.access.mockResolvedValue(undefined);
  mocks.check.mockImplementation(async () => ({ supported: true, revalidate }));
  mocks.terminate.mockImplementation(async (child: EventEmitter) => {
    queueMicrotask(() => child.emit("close", 0, null));
  });
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough()
    });
    if (autoExit) queueMicrotask(() => child.emit("close", 0, null));
    return child;
  });
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await vi.advanceTimersByTimeAsync(0);
  await Promise.allSettled(pending.splice(0));
  vi.useRealTimers();
});

it("rejects an already-aborted command before executable resolution", async () => {
  const abort = new AbortController();
  abort.abort();
  const result = await runBrewCommand(["--version"], undefined, { signal: abort.signal });
  expect(result.failure?.kind).toBe("cancelled");
  expect(result.cancelled).toBe(true);
  expect(mocks.access).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it.each(["resolution", "check", "revalidate", "final revalidation"])(
  "times out stalled %s and prevents late spawn",
  async (stage) => {
    const deferred = gate();
    stall(stage, deferred.promise);
    const result = observe(runBrewCommand(["--version"], undefined, { timeoutMs: 15 }));
    await vi.advanceTimersByTimeAsync(16);
    expect(result()?.failure?.kind).toBe("timeout");
    expect(mocks.spawn).not.toHaveBeenCalled();
    deferred.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).not.toHaveBeenCalled();
  }
);

it.each(["resolution", "check", "revalidate", "final revalidation"])(
  "cancels stalled %s and prevents late spawn",
  async (stage) => {
    const deferred = gate();
    stall(stage, deferred.promise);
    const abort = new AbortController();
    const result = observe(runBrewCommand(["--version"], undefined, { signal: abort.signal }));
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result()?.failure?.kind).toBe("cancelled");
    deferred.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).not.toHaveBeenCalled();
  }
);

it("does not add a default deadline to mutation preflight", async () => {
  const deferred = gate();
  stall("check", deferred.promise);
  const result = observe(runBrewCommand(["upgrade", "--cask", "fixture"]));
  await vi.advanceTimersByTimeAsync(120_001);
  expect(result()).toBeUndefined();
  deferred.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(result()?.success).toBe(true);
});

it.each([6, 8])(
  "spends the budget once across preflight and execution (stage delay %s)",
  async (delayMs) => {
    const delay = () => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    mocks.access.mockImplementation(delay);
    mocks.check.mockImplementation(async () => {
      await delay();
      return { supported: true, revalidate };
    });
    revalidate.mockImplementation(async () => {
      await delay();
      return true;
    });
    autoExit = false;
    const result = observe(runBrewCommand(["--version"], undefined, { timeoutMs: 30 }));
    await vi.advanceTimersByTimeAsync(29);
    expect(result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(result()?.failure?.kind).toBe("timeout");
    expect(mocks.spawn).toHaveBeenCalledTimes(delayMs === 6 ? 1 : 0);
    await vi.advanceTimersByTimeAsync(3);
  }
);

it.each(["abort", "timeout"])(
  "keeps %s as the first interruption and consumes late rejection",
  async (first) => {
    const deferred = gate();
    stall("check", deferred.promise);
    const abort = new AbortController();
    const result = observe(
      runBrewCommand(["--version"], undefined, { timeoutMs: 15, signal: abort.signal })
    );
    await vi.advanceTimersByTimeAsync(5);
    if (first === "abort") abort.abort();
    await vi.advanceTimersByTimeAsync(11);
    abort.abort();
    deferred.reject(new Error("late fixture rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(result()?.failure?.kind).toBe(first === "abort" ? "cancelled" : "timeout");
    expect(mocks.spawn).not.toHaveBeenCalled();
  }
);
