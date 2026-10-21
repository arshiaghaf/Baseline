// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// @vitest-environment node

import { expect, test } from "vitest";
import { LifecycleLog } from "../e2e/electronLifecycleDiagnostics";

test("bounds lifecycle diagnostics and redacts the fixture secret across output chunks", () => {
  const secret = "synthetic-profile-secret";
  const log = new LifecycleLog(secret);
  log.output("stderr", "prefix synthetic-profile-");
  log.output("stderr", "secret suffix");
  log.output("stdout", "x".repeat(20_000));
  for (let index = 0; index < 120; index++) log.event("phase", { index, secret });
  const snapshot = log.snapshot();
  const result = JSON.parse(snapshot);
  expect(snapshot).not.toContain(secret);
  expect(result.stderr).toBe("prefix [redacted] suffix");
  expect(result.stdout).toHaveLength(16_384);
  expect(result.events).toHaveLength(96);
  expect(result.droppedEvents).toBe(24);
  expect(result.events.at(-1).detail.index).toBe(119);
});
