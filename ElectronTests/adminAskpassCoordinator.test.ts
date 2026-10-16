// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { stat, access } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminAskpassCoordinator } from "../src/main/adminAskpassCoordinator";
import {
  AskpassFrameReader,
  AskpassMessage as M,
  encodeAskpassFrame,
  type AskpassFrame
} from "../src/main/adminAskpassProtocol";

const operationID = "1".repeat(32),
  first = "2".repeat(32),
  second = "3".repeat(32);
let coordinator: AdminAskpassCoordinator;
let changed: ReturnType<typeof vi.fn<(promptID: string | undefined) => void>>,
  stopped: ReturnType<typeof vi.fn<(reason: "cancelled" | "error") => void>>;
let clients: Socket[];
beforeEach(async () => {
  clients = [];
  changed = vi.fn();
  stopped = vi.fn();
  coordinator = await AdminAskpassCoordinator.create({
    operationID,
    onWaitingChanged: changed,
    onStopRequested: stopped
  });
});
afterEach(async () => {
  for (const socket of clients) socket.destroy();
  await coordinator.finish(true);
});

async function client(promptID = first) {
  const socket = createConnection(coordinator.socketPath);
  clients.push(socket);
  const queue: AskpassFrame[] = [];
  const reader = new AskpassFrameReader();
  socket.on("error", () => undefined);
  socket.on("data", (bytes) => queue.push(...reader.write(bytes)));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const write = (type: number) => socket.write(encodeAskpassFrame({ operationID, promptID, type }));
  const next = async () => {
    await vi.waitFor(() => expect(queue.length).toBeGreaterThan(0));
    return queue.shift()!;
  };
  const send = async (type: number) => {
    write(type);
    return next();
  };
  const close = async () => {
    if (socket.closed) return;
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.end();
    await closed;
  };
  expect((await send(M.hello)).type).toBe(M.hello | 128);
  return { socket, write, send, next, close, queue };
}

it("uses private short absolute socket paths and removes its owned endpoint", async () => {
  expect(path.isAbsolute(coordinator.socketPath)).toBe(true);
  expect(Buffer.byteLength(coordinator.socketPath)).toBeLessThan(104);
  expect((await stat(path.dirname(coordinator.socketPath))).mode & 0o777).toBe(0o700);
  expect((await stat(coordinator.socketPath)).mode & 0o777).toBe(0o600);
  expect(await coordinator.finish(true)).toEqual({
    cancelled: false,
    helperError: false,
    cleanupConfirmed: true
  });
  await expect(access(coordinator.socketPath)).rejects.toThrow();
});

it("correlates focus with the current wait and excludes answered/previous operations", async () => {
  const peer = await client();
  await peer.send(M.begin);
  expect(changed).toHaveBeenLastCalledWith(first);
  expect(coordinator.focus("4".repeat(32), first)).toBe(false);
  expect(coordinator.focus(operationID, second)).toBe(false);
  expect(coordinator.focus(operationID, first)).toBe(true);
  expect((await peer.next()).type).toBe(M.focus);
  await peer.send(M.answered);
  expect(coordinator.focus(operationID, first)).toBe(false);
  await peer.send(M.complete);
  await peer.close();
  expect((await coordinator.finish(true)).helperError).toBe(false);
});

it("serializes overlapping admission and ignores a prior duplicate COMPLETE for a newer wait", async () => {
  const one = await client(),
    two = await client(second);
  await one.send(M.begin);
  two.write(M.begin);
  expect((await two.send(M.hello)).type).toBe(M.hello | 128);
  await one.send(M.answered);
  expect((await two.next()).type).toBe(M.begin | 128);
  await one.send(M.complete);
  await one.send(M.complete);
  expect(coordinator.lifecycle.waitingPromptID).toBe(second);
  await one.close();
  await two.send(M.answered);
  await two.send(M.complete);
  await two.close();
  expect(await coordinator.finish(true)).toEqual({
    cancelled: false,
    helperError: false,
    cleanupConfirmed: true
  });
});

it("latches cancellation after rejection, denies a deferred retry, and drains orderly completion", async () => {
  const one = await client();
  await one.send(M.begin);
  await one.send(M.answered);
  await one.send(M.complete);
  await one.close();
  const retry = await client(second),
    deferred = await client("4".repeat(32));
  await retry.send(M.begin);
  deferred.write(M.begin);
  await retry.send(M.cancelled);
  expect(stopped).toHaveBeenCalledWith("cancelled");
  expect((await deferred.next()).type).toBe(M.deny);
  const cleanup = coordinator.prepareCleanup("cancelled", performance.now() + 1000);
  await retry.send(M.complete);
  await retry.close();
  await cleanup;
  expect(await coordinator.finish(true)).toEqual({
    cancelled: true,
    helperError: false,
    cleanupConfirmed: true
  });
});

it("keeps unconfirmed group cleanup independent from orderly cancellation", async () => {
  const peer = await client();
  await peer.send(M.begin);
  await peer.send(M.cancelled);
  await peer.send(M.complete);
  await peer.close();
  expect(await coordinator.finish(false)).toEqual({
    cancelled: true,
    helperError: false,
    cleanupConfirmed: false
  });
});

it("permits bounded intentional cancellation teardown without claiming invocation completion", async () => {
  const peer = await client();
  await peer.send(M.begin);
  await coordinator.prepareCleanup("cancelled", performance.now() + 10);
  expect(await coordinator.finish(false)).toEqual({
    cancelled: true,
    helperError: false,
    cleanupConfirmed: false
  });
});

it.each(["waiting", "answered"])(
  "does not hide missing COMPLETE on normal exit while %s",
  async (phase) => {
    const peer = await client();
    await peer.send(M.begin);
    if (phase === "answered") await peer.send(M.answered);
    await coordinator.prepareCleanup("command-exit", performance.now() + 10);
    expect(await coordinator.finish(true)).toEqual({
      cancelled: false,
      helperError: true,
      cleanupConfirmed: true
    });
  }
);

it("retains post-answer delivery failure and unexplained peer death", async () => {
  const peer = await client();
  await peer.send(M.begin);
  await peer.send(M.answered);
  await peer.send(M.invocationError);
  await peer.close();
  expect(stopped).toHaveBeenCalledWith("error");
  expect((await coordinator.finish(true)).helperError).toBe(true);
});

it("contains observer failures through cleanup instead of throwing from socket callbacks", async () => {
  changed.mockImplementation(() => {
    throw new Error("fixture observer failure");
  });
  const peer = await client();
  expect((await peer.send(M.begin)).type).toBe(M.deny);
  expect(stopped).toHaveBeenCalledWith("error");
  expect((await coordinator.finish(true)).helperError).toBe(true);
});

it.each(["cancelled", "error", "command-exit"] as const)(
  "denies BEGIN when waiting publication synchronously starts %s cleanup",
  async (reason) => {
    let cleanup: Promise<void> | undefined;
    changed.mockImplementation((prompt) => {
      if (prompt) cleanup = coordinator.prepareCleanup(reason, performance.now() + 1000);
    });
    const peer = await client();
    expect((await peer.send(M.begin)).type).toBe(M.deny);
    await peer.close();
    await cleanup;
    expect(await coordinator.finish(true)).toEqual({
      cancelled: reason === "cancelled",
      helperError: reason !== "cancelled",
      cleanupConfirmed: true
    });
  }
);

it("denies an already-deferred admission after waiting-clear publication fails while still draining completion", async () => {
  const one = await client(),
    two = await client(second);
  await one.send(M.begin);
  two.write(M.begin);
  changed.mockImplementation((prompt) => {
    if (prompt === undefined) throw new Error("fixture observer failure");
  });
  expect((await one.send(M.answered)).type).toBe(M.answered | 128);
  expect((await two.next()).type).toBe(M.deny);
  expect(stopped).toHaveBeenCalledWith("error");
  expect((await one.send(M.complete)).type).toBe(M.complete | 128);
  await one.close();
  await two.close();
  expect(await coordinator.finish(true)).toEqual({
    cancelled: false,
    helperError: true,
    cleanupConfirmed: true
  });
});

it.each(["truncated", "overflow", "unknown", "wrong-operation", "changed-prompt"])(
  "rejects %s status without accepting text payloads",
  async (scenario) => {
    const peer = await client();
    if (scenario === "truncated") {
      peer.socket.write(Buffer.alloc(3));
      await peer.close();
    }
    if (scenario === "overflow") peer.socket.write(Buffer.alloc(4097));
    if (scenario === "unknown") {
      const bytes = encodeAskpassFrame({ operationID, promptID: first, type: M.begin });
      bytes[5] = 9;
      peer.socket.write(bytes);
    }
    if (scenario === "wrong-operation")
      peer.socket.write(
        encodeAskpassFrame({ operationID: "4".repeat(32), promptID: first, type: M.begin })
      );
    if (scenario === "changed-prompt")
      peer.socket.write(encodeAskpassFrame({ operationID, promptID: second, type: M.begin }));
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledWith("error"));
    expect((await coordinator.finish(true)).helperError).toBe(true);
  }
);

it("rejects prompt identity reuse on another transport", async () => {
  const peer = await client();
  await peer.send(M.begin);
  await peer.send(M.answered);
  await peer.send(M.complete);
  await peer.close();
  const duplicate = createConnection(coordinator.socketPath);
  clients.push(duplicate);
  duplicate.on("error", () => undefined);
  duplicate.write(encodeAskpassFrame({ operationID, promptID: first, type: M.hello }));
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledWith("error"));
  expect((await coordinator.finish(true)).helperError).toBe(true);
});
