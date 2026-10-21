// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  parseServiceDiagnostics,
  renderHomebrewDiagnostics,
  type DiagnosticCommandResult
} from "../src/main/homebrewDiagnosticsService";

function row(overrides: Record<string, unknown> = {}) {
  return {
    running: false,
    loaded: true,
    schedulable: false,
    registered: true,
    status: "other",
    exit_code: null,
    ...overrides
  };
}

function result(rows: unknown[]): DiagnosticCommandResult {
  const stdout = JSON.stringify(rows);
  return { success: true, status: 0, stdout, stderr: "", output: stdout };
}

function parse(...rows: unknown[]) {
  return parseServiceDiagnostics(result(rows));
}

// Primary-source cases from FormulaWrapper.status_symbol/to_hash, Homebrew 7.0.4.
// loaded and exit_code are subordinate to running; loaded=false also takes
// precedence over historical exits. Registration is an independent observation.
const officialCases = [
  {
    status: "started",
    running: true,
    loaded: true,
    schedulable: false,
    exit_code: null,
    aggregate: "ok",
    failed: 0,
    unknown: 0
  },
  {
    status: "started",
    running: true,
    loaded: false,
    schedulable: true,
    exit_code: 17,
    aggregate: "ok",
    failed: 0,
    unknown: 0
  },
  {
    status: "none",
    running: false,
    loaded: false,
    schedulable: false,
    exit_code: null,
    aggregate: "ok",
    failed: 0,
    unknown: 0
  },
  {
    status: "none",
    running: false,
    loaded: false,
    schedulable: true,
    exit_code: 17,
    aggregate: "ok",
    failed: 0,
    unknown: 0
  },
  {
    status: "scheduled",
    running: false,
    loaded: true,
    schedulable: true,
    exit_code: 0,
    aggregate: "ok",
    failed: 0,
    unknown: 0
  },
  {
    status: "stopped",
    running: false,
    loaded: true,
    schedulable: false,
    exit_code: 0,
    aggregate: "ok",
    failed: 0,
    unknown: 0
  },
  {
    status: "error",
    running: false,
    loaded: true,
    schedulable: false,
    exit_code: 17,
    aggregate: "findings",
    failed: 1,
    unknown: 0
  },

  {
    status: "unknown",
    running: false,
    loaded: true,
    schedulable: false,
    exit_code: null,
    aggregate: "partial",
    failed: 0,
    unknown: 1
  },
  {
    status: "other",
    running: false,
    loaded: true,
    schedulable: true,
    exit_code: null,
    aggregate: "partial",
    failed: 0,
    unknown: 1
  }
] as const;

describe("Homebrew service producer-state projection", () => {
  it.each(officialCases)("projects official $status state ($loaded, $exit_code)", (test) => {
    const { aggregate, failed, unknown, ...state } = test;
    for (const registered of [true, false]) {
      expect(parse(row({ ...state, registered }))).toEqual({
        status: aggregate,
        exitStatus: 0,
        total: 1,
        running: Number(state.running),
        registered: Number(registered),
        failed,
        unknown,
        omittedServices: 0
      });
    }
  });

  it.each([
    { status: "unknown", exit_code: 0 },
    { status: "unknown", exit_code: 17 },
    { status: "other", exit_code: 0 },
    { status: "started", running: false, exit_code: 0 },
    { status: "error", running: true, exit_code: 17 },
    { status: "none", running: true, loaded: false },
    { status: "none", loaded: true, exit_code: null },
    { status: "error", loaded: false, exit_code: 17 },
    { status: "error", exit_code: 0 },
    { status: "error", exit_code: null },
    { status: "scheduled", schedulable: false, exit_code: 0 },
    { status: "scheduled", schedulable: true, exit_code: null },
    { status: "stopped", schedulable: true, exit_code: 0 },
    { status: "stopped", schedulable: false, exit_code: 17 }
  ])("does not invent a failure or healthy result for contradictory state %j", (state) => {
    const report = parse(row(state));
    expect(report).toMatchObject({
      status: "partial",
      failed: 0,
      unknown: 1,
      running: Number(state.running === true),
      registered: 1
    });
  });

  it.each(["future-status", "STARTED", "", null, {}])(
    "counts unrecognized status %j once without exposing it",
    (status) => {
      expect(parse(row({ status }))).toMatchObject({ status: "partial", unknown: 1, failed: 0 });
    }
  );

  it.each(["running", "loaded", "schedulable", "registered", "status", "exit_code"])(
    "keeps a missing producer field %s visibly uncertain",
    (field) => {
      const service: Record<string, unknown> = row({ status: "error", exit_code: 17 });
      delete service[field];
      expect(parse(service)).toMatchObject({ status: "partial", unknown: 1, failed: 0 });
    }
  );

  it.each([
    { running: "false" },
    { loaded: null },
    { schedulable: 0 },
    { registered: "true" },
    { exit_code: -1 },
    { exit_code: "17" },
    { exit_code: false },
    { exit_code: 1.5 },
    { exit_code: Number.MAX_SAFE_INTEGER + 1 }
  ])("treats malformed projected state fields as uncertain: %j", (fields) => {
    const service = row({ status: "error", exit_code: 17, ...fields });
    expect(parse(service)).toMatchObject({
      status: "partial",
      unknown: 1,
      failed: 0,
      running: Number(service.running === true),
      registered: Number(service.registered === true)
    });
  });

  it.each(["-0", "1e400", "9007199254740992"])(
    "rejects unobserved wire-number boundaries without inventing a failure: %s",
    (literal) => {
      const stdout = JSON.stringify([row({ status: "error", exit_code: 17 })]).replace(
        '"exit_code":17',
        `"exit_code":${literal}`
      );
      const report = parseServiceDiagnostics({
        success: true,
        status: 0,
        stdout,
        stderr: "",
        output: stdout
      });
      expect(report).toMatchObject({ status: "partial", unknown: 1, failed: 0 });
    }
  );

  it.each(["NaN", "Infinity"])("rejects invalid JSON numeric token %s", (literal) => {
    const stdout = JSON.stringify([row()]).replace('"exit_code":null', `"exit_code":${literal}`);
    expect(
      parseServiceDiagnostics({ success: true, status: 0, stdout, stderr: "", output: stdout })
    ).toMatchObject({ status: "invalid", total: 0, unknown: 0, failed: 0 });
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER])(
    "accepts producer-compatible nonnegative exit %s",
    (exit_code) => {
      const report = parse(row({ status: exit_code === 0 ? "stopped" : "error", exit_code }));
      expect(report).toMatchObject({
        status: exit_code === 0 ? "ok" : "findings",
        failed: Number(exit_code !== 0),
        unknown: 0
      });
    }
  );

  it.each([null, 17, "private fixture", []])("handles malformed scalar row %j", (service) => {
    expect(parse(service)).toMatchObject({
      status: "partial",
      unknown: 1,
      failed: 0,
      running: 0,
      registered: 0
    });
  });

  it("counts an uncertain row once while retaining independent typed observations", () => {
    expect(
      parse({
        running: true,
        registered: true,
        loaded: "bad",
        schedulable: null,
        status: "unknown",
        exit_code: "bad"
      })
    ).toMatchObject({
      status: "partial",
      total: 1,
      running: 1,
      registered: 1,
      unknown: 1,
      failed: 0
    });
  });

  it("gives partial precedence over confirmed findings and preserves known counts", () => {
    const report = parse(
      row({ status: "error", exit_code: 17 }),
      row({ status: "unknown" }),
      row({ running: true, status: "started", exit_code: 17 }),
      { running: false, registered: false }
    );
    expect(report).toEqual({
      status: "partial",
      exitStatus: 0,
      total: 4,
      running: 1,
      registered: 3,
      failed: 1,
      unknown: 2,
      omittedServices: 0
    });
  });

  it("keeps omitted and capture-truncated aggregates visibly incomplete", () => {
    const rows = [
      row({ status: "error", exit_code: 17 }),
      ...Array.from({ length: 256 }, () => row({ status: "stopped", exit_code: 0 }))
    ];
    expect(parse(...rows)).toMatchObject({
      status: "partial",
      total: 257,
      failed: 1,
      unknown: 0,
      omittedServices: 1
    });
    expect(parseServiceDiagnostics({ ...result(rows), outputTruncated: true })).toMatchObject({
      status: "truncated",
      total: 0,
      failed: 0,
      unknown: 0
    });
    expect(parseServiceDiagnostics({ ...result(rows), success: false, status: 1 })).toMatchObject({
      status: "unavailable",
      total: 0,
      failed: 0,
      unknown: 0
    });
  });

  it("never exports unknown status strings or unused private metadata", () => {
    const secret = "SECRET /Users/private user/key.pem https://user:password@private.example";
    const report = parse(
      row({
        status: secret,
        name: secret,
        user: secret,
        pid: secret,
        command: secret,
        file: secret,
        log_path: secret
      })
    );
    expect(report).toMatchObject({ status: "partial", unknown: 1, registered: 1, failed: 0 });
    expect(JSON.stringify(report)).not.toContain("SECRET");
    expect(renderHomebrewDiagnostics({ status: "complete", services: report })).not.toMatch(
      /SECRET|private user|password/u
    );
  });
});
