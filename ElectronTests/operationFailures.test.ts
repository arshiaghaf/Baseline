// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  failureReason,
  normalizeOperationFailures,
  operationFailureDescription
} from "../src/shared/operationFailures";

describe("sanitized operation failures", () => {
  it.each([
    ["Could not resolve host example.test?token=private", "network"],
    ["Permission denied /Users/fixture/private", "permission"],
    ["SHA256 checksum mismatch", "integrity"],
    ["No available formula", "unavailable"],
    ["Another operation is running", "locked"],
    ["Unexpected error with SECRET=fixture", "command"]
  ])("classifies %s without echoing raw output", (output, reason) => {
    const classified = failureReason(output);
    expect(classified).toBe(reason);
    const message = operationFailureDescription({ reason: classified, status: 1 });
    expect(message).not.toContain(output);
    expect(message).not.toMatch(/private|SECRET|\/Users|https:/);
  });

  it("bounds, deduplicates, validates and strips unrecognized fields on disk input", () => {
    const failure = {
      entityID: "formula:example",
      operation: "update",
      reason: "network",
      status: 1,
      occurredAt: "2026-10-09T12:00:00Z",
      output: "SECRET=fixture",
      id: "untrusted"
    };
    const normalized = normalizeOperationFailures([
      failure,
      failure,
      { ...failure, reason: "raw-secret" },
      { ...failure, entityID: "bad\nname" }
    ]);
    expect(normalized).toEqual([
      {
        id: "update:formula:example",
        entityID: "formula:example",
        operation: "update",
        reason: "network",
        status: 1,
        occurredAt: "2026-10-09T12:00:00.000Z"
      }
    ]);
    expect(
      normalizeOperationFailures(
        Array.from({ length: 40 }, (_, i) => ({ ...failure, entityID: `formula:example${i}` }))
      )
    ).toHaveLength(20);
    expect(normalizeOperationFailures({ records: [failure] })).toEqual([]);
  });
});
