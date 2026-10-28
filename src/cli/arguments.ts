// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { randomUUID } from "node:crypto";
import { CLIError, cliExit, validateCLIRequest, type CLIRequest } from "../shared/cli";

export const cliHelp = `Usage: baseline <command> [options]

  status                     Show backend version, freshness and active work
  list                       List installed apps/packages with exact target IDs
  inspect <id>               Inspect one exact target
  check                      Scan and explicitly revalidate update metadata
  update <id>... --dry-run    Preview exact targets and receive a plan ID
  update <id>... --yes        Apply exact targets through the shared app backend
  operation <uuid>           Inspect work accepted by the current app session
  doctor                     Show diagnostics, capabilities and exit codes

Options:
  --json                     One versioned JSON response on stdout
  --interactive              Allow cask authorization and open app handoffs
  --expect-plan <id>         Apply only if a dry-run plan still matches
  --operation-id <uuid>      Reuse an identical request in this app session
  --no-wait                  Return as soon as check/update is accepted
  --wait                     Wait for an operation command to finish
  --timeout <seconds>        Stop waiting after 1–3600 seconds (default 300)
  --help, -h                 Show help without launching Baseline
  --version                  Show CLI version without launching Baseline

Run check before updating. Ignored/pinned apps and Baseline itself are protected.
Homebrew can update dependencies and perform its normal cleanup. App handoffs
require finishing the installation yourself; opening one is never success.
Ctrl-C and timeouts stop waiting; accepted work continues. Save the operation ID
and query it before retrying. Unknown IDs after restart do not prove failure.
`;

export function parseCLIArguments(args: string[]): {
  request?: CLIRequest;
  json: boolean;
  wait: boolean;
  timeoutMS: number;
  local?: "help" | "version";
} {
  const result = { json: args.includes("--json"), wait: true, timeoutMS: 300_000 };
  if (args.includes("--help") || args.includes("-h") || args.length === 0)
    return { ...result, local: "help" };
  if (
    args.includes("--version") &&
    args.every((arg) => ["--version", "--json"].includes(arg)) &&
    args.filter((arg) => arg === "--version").length === 1 &&
    args.filter((arg) => arg === "--json").length <= 1
  )
    return { ...result, local: "version" };
  const positional: string[] = [];
  const options: Partial<CLIRequest> = {};
  const seen = new Set<string>();
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--" && !literal) {
      literal = true;
      continue;
    }
    if (!literal && arg.startsWith("-")) {
      if (seen.has(arg))
        throw new CLIError("duplicate-option", `Option supplied twice: ${arg}`, cliExit.usage);
      seen.add(arg);
      if (arg === "--json") continue;
      if (arg === "--wait") {
        result.wait = true;
        continue;
      }
      if (arg === "--no-wait") {
        result.wait = false;
        continue;
      }
      const boolean = {
        "--dry-run": "dryRun",
        "--yes": "yes",
        "--interactive": "interactive"
      } as const;
      if (arg in boolean) {
        options[boolean[arg as keyof typeof boolean]] = true;
        continue;
      }
      if (["--timeout", "--expect-plan", "--operation-id"].includes(arg)) {
        const value = args[++i];
        if (!value || value.startsWith("--"))
          throw new CLIError("missing-value", `Missing value for ${arg}.`, cliExit.usage);
        if (arg === "--timeout") {
          if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 3600)
            throw new CLIError(
              "invalid-timeout",
              "Timeout must be an integer from 1 to 3600 seconds.",
              cliExit.usage
            );
          result.timeoutMS = Number(value) * 1000;
        } else if (arg === "--expect-plan") options.expectPlan = value;
        else options.operationID = value;
        continue;
      }
      throw new CLIError(
        "unknown-option",
        `Unknown option: ${arg}. Run baseline --help.`,
        cliExit.usage
      );
    }
    positional.push(arg);
  }
  const command = positional.shift();
  if (command === "operation" && options.operationID)
    throw new CLIError(
      "invalid-options",
      "operation takes its UUID as a positional argument.",
      cliExit.usage
    );
  if (seen.has("--wait") && (command !== "operation" || seen.has("--no-wait")))
    throw new CLIError(
      "invalid-options",
      "--wait applies only to operation, without --no-wait.",
      cliExit.usage
    );
  if (command === "operation" && !seen.has("--wait")) result.wait = false;
  const request = validateCLIRequest({
    schemaVersion: 1,
    command,
    ...options,
    ...(command === "operation"
      ? { operationID: positional.shift() }
      : positional.length
        ? { ids: positional }
        : {})
  });
  if (command === "operation" && positional.length)
    throw new CLIError("invalid-targets", "operation takes one UUID.", cliExit.usage);
  if (
    (!result.wait || seen.has("--timeout")) &&
    !["check", "update", "operation"].includes(request.command)
  )
    throw new CLIError(
      "invalid-options",
      "Wait options apply to check, update and operation.",
      cliExit.usage
    );
  if ((request.command === "check" || request.command === "update") && !request.dryRun)
    request.operationID ??= randomUUID();
  return { ...result, request };
}
