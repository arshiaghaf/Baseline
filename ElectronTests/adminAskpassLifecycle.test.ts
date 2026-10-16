// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { expect, it, vi } from "vitest";
import { AdminAskpassLifecycle } from "../src/main/adminAskpassLifecycle";
import { AskpassMessage as M } from "../src/main/adminAskpassProtocol";

const operationID = "1".repeat(32),
  first = "2".repeat(32),
  second = "3".repeat(32);
function harness() {
  const changed = vi.fn();
  const lifecycle = new AdminAskpassLifecycle(operationID, changed);
  const frame = (type: number, promptID = first, id = operationID) => ({
    type,
    promptID,
    operationID: id
  });
  const send = (type: number, promptID = first) => lifecycle.receive(frame(type, promptID));
  const begin = (promptID = first) => {
    send(M.hello, promptID);
    return send(M.begin, promptID);
  };
  return { lifecycle, changed, send, frame, begin };
}

it("keeps answer delivery completion separate from dialog outcome, including late write failure", () => {
  const h = harness();
  h.begin();
  h.send(M.answered);
  h.send(M.invocationError);
  h.lifecycle.disconnected(first);
  expect(h.lifecycle.finish(true)).toEqual({
    cancelled: false,
    helperError: true,
    cleanupConfirmed: true
  });
});

it("requires invocation completion even when the command exits successfully", () => {
  const h = harness();
  h.begin();
  h.send(M.answered);
  expect(h.lifecycle.finish(true).helperError).toBe(true);
});

it("permits sudo-controlled retries but denies further admission immediately after cancellation", () => {
  const h = harness();
  h.begin();
  h.send(M.answered);
  h.send(M.complete);
  expect(h.begin(second)).toBe("ack");
  h.send(M.cancelled, second);
  expect(h.send(M.hello, "4".repeat(32))).toBe("deny");
  h.send(M.complete, second);
  h.lifecycle.disconnected(second);
  expect(h.lifecycle.finish(true)).toEqual({
    cancelled: true,
    helperError: false,
    cleanupConfirmed: true
  });
});

it("does not clear a newer wait on an older prompt's duplicate completion", () => {
  const h = harness();
  h.begin();
  h.send(M.answered);
  h.send(M.complete);
  h.begin(second);
  h.send(M.complete);
  expect(h.lifecycle.waitingPromptID).toBe(second);
  expect(h.changed.mock.calls.at(-1)).toEqual([second]);
});

it("defers overlapping dialog admission and rechecks it after the current dialog finishes", () => {
  const h = harness();
  h.begin();
  h.send(M.hello, second);
  expect(h.send(M.begin, second)).toBe("defer");
  h.send(M.answered);
  expect(h.send(M.begin, second)).toBe("ack");
});

it("keeps cancellation and cleanup uncertainty independent of intentional termination", () => {
  const h = harness();
  h.begin();
  h.send(M.cancelled);
  h.lifecycle.disconnected(first, "cancelled");
  expect(h.lifecycle.finish(false)).toEqual({
    cancelled: true,
    helperError: false,
    cleanupConfirmed: false
  });
});

it.each(["command-exit", "cancelled"] as const)(
  "does not treat coordinator %s teardown as proof of a completed noncancelled invocation",
  (reason) => {
    const h = harness();
    h.begin();
    h.lifecycle.disconnected(first, reason);
    expect(h.lifecycle.finish(true)).toEqual({
      cancelled: false,
      helperError: true,
      cleanupConfirmed: true
    });
  }
);

it("treats unexplained peer death and missing completion after cancellation as helper errors", () => {
  const h = harness();
  h.begin();
  h.send(M.cancelled);
  h.lifecycle.disconnected(first);
  expect(h.lifecycle.finish(true)).toEqual({
    cancelled: true,
    helperError: true,
    cleanupConfirmed: true
  });
});

it("rejects lifecycle regressions, and seals old operations against late frames", () => {
  const h = harness();
  h.begin();
  h.send(M.answered);
  expect(h.send(M.begin)).toBe("deny");
  h.send(M.complete);
  expect(h.lifecycle.finish(true).helperError).toBe(true);
  expect(h.send(M.begin, second)).toBe("deny");
  expect(h.lifecycle.receive(h.frame(M.cancelled, second, "4".repeat(32)))).toBe("deny");
  expect(h.lifecycle.cancelled).toBe(false);
});

it("accepts no-invocation cached/no-sudo work without inventing missing lifecycle", () => {
  expect(harness().lifecycle.finish(true)).toEqual({
    cancelled: false,
    helperError: false,
    cleanupConfirmed: true
  });
});
