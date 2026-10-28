// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

/** Public, additive v1 contract. Human output is deliberately not an API. */
export const cliSchemaVersion = 1;
export const cliExit = {
  success: 0,
  failed: 1,
  usage: 2,
  action: 3,
  busy: 4,
  unavailable: 5,
  timeout: 6,
  interrupted: 130
} as const;
export type CLICommand =
  "status" | "list" | "inspect" | "check" | "update" | "operation" | "doctor";
export type CLIRequest = {
  schemaVersion: 1;
  command: CLICommand;
  ids?: string[];
  operationID?: string;
  dryRun?: boolean;
  yes?: boolean;
  interactive?: boolean;
  expectPlan?: string;
};
export type CLIResponse = {
  schemaVersion: 1;
  sessionID: string;
  ok: boolean;
  exitCode: number;
  data?: unknown;
  error?: { code: string; message: string };
};
export type CLITarget = {
  id: string;
  kind: "app" | "formula" | "cask";
  name: string;
  installedVersion: string;
  availableVersion?: string;
  source: string;
  checkedAt?: string;
  checkStatus?: string;
  ignored: boolean;
  pinned: boolean;
  action: "update" | "requires-user-action" | "blocked" | "none";
  reason?: string;
  linkedTargetID?: string;
};
export type CLIOperation = {
  id: string;
  kind: "check" | "update";
  state:
    "running" | "waiting-for-user" | "succeeded" | "partial" | "failed" | "requires-user-action";
  startedAt: string;
  finishedAt?: string;
  results: {
    id: string;
    status: "updated" | "failed" | "requires-user-action" | "blocked";
    message?: string;
  }[];
  exitCode: number;
  message?: string;
};

export class CLIError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode: number = cliExit.failed
  ) {
    super(message);
  }
}

export function validCLIIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2048 &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}

export function validateCLIRequest(value: unknown): CLIRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CLIError("invalid-request", "Expected a command object.", cliExit.usage);
  const r = value as Record<string, unknown>;
  const allowed = [
    "schemaVersion",
    "command",
    "ids",
    "operationID",
    "dryRun",
    "yes",
    "interactive",
    "expectPlan"
  ];
  if (
    Object.keys(r).some((key) => !allowed.includes(key)) ||
    r.schemaVersion !== 1 ||
    !["status", "list", "inspect", "check", "update", "operation", "doctor"].includes(
      String(r.command)
    )
  )
    throw new CLIError("invalid-request", "Unsupported command or schema version.", cliExit.usage);
  if (
    r.ids !== undefined &&
    (!Array.isArray(r.ids) ||
      r.ids.length > 50 ||
      !r.ids.every(validCLIIdentity) ||
      new Set(r.ids).size !== r.ids.length)
  )
    throw new CLIError(
      "invalid-targets",
      "Supply 1–50 distinct exact IDs from baseline list.",
      cliExit.usage
    );
  for (const key of ["dryRun", "yes", "interactive"])
    if (r[key] !== undefined && typeof r[key] !== "boolean")
      throw new CLIError("invalid-request", `Invalid ${key}.`, cliExit.usage);
  if (
    r.operationID !== undefined &&
    (typeof r.operationID !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(r.operationID))
  )
    throw new CLIError("invalid-operation", "Expected a UUID operation ID.", cliExit.usage);
  if (
    r.expectPlan !== undefined &&
    (typeof r.expectPlan !== "string" || !/^[a-f0-9]{64}$/u.test(r.expectPlan))
  )
    throw new CLIError("invalid-plan", "Expected the plan ID from a dry run.", cliExit.usage);
  const command = r.command;
  if (
    (command === "update" || command === "inspect") !==
      (Array.isArray(r.ids) && r.ids.length > 0) ||
    (command === "inspect" && (r.ids as unknown[]).length !== 1)
  )
    throw new CLIError(
      "invalid-targets",
      "This command requires exact target IDs; inspect takes one ID.",
      cliExit.usage
    );
  if (
    (command === "operation" && !r.operationID) ||
    (!["check", "update", "operation"].includes(String(command)) && r.operationID !== undefined) ||
    (command !== "update" &&
      [r.dryRun, r.yes, r.interactive, r.expectPlan].some((v) => v !== undefined))
  )
    throw new CLIError(
      "invalid-options",
      "These options do not apply to this command.",
      cliExit.usage
    );
  return r as CLIRequest;
}
