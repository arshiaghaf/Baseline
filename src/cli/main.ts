// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { cliHelp, parseCLIArguments } from "./arguments";
import { cliUserData } from "./endpoint";
import { sendCLIRequest } from "./client";
import {
  CLIError,
  cliExit,
  type CLIOperation,
  type CLIResponse,
  type CLITarget
} from "../shared/cli";
import packageJSON from "../../package.json";

const clean = (value: string) =>
  Array.from(value, (c) =>
    c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159) ? " " : c
  ).join("");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function human(response: CLIResponse): string {
  if (response.error) return `${clean(response.error.message)}\n`;
  const data = response.data as {
    targets?: CLITarget[];
    target?: CLITarget;
    operation?: CLIOperation;
    diagnostics?: string;
    planID?: string;
    effects?: string;
    version?: string;
    lastExplicitCheckAt?: string | null;
    lastRefreshAt?: string | null;
    homebrewCheckStatus?: string;
    freshForUpdates?: boolean;
    notices?: string[];
  };
  if (data?.operation) {
    const op = data.operation;
    return `${op.id}  ${op.state}${op.message ? `\n${clean(op.message)}` : ""}\n${op.results.map((r) => `${clean(r.id)}  ${r.status}${r.message ? ` — ${clean(r.message)}` : ""}\n`).join("")}`;
  }
  if (data?.targets || data?.target) {
    const targets = data.targets ?? [data.target!];
    return `${targets.length ? "ID\tNAME\tSOURCE\tINSTALLED\tAVAILABLE\tACTION\n" : "No installed targets are recorded. Run baseline check.\n"}${targets.map((t) => [t.id, t.name, t.source, t.installedVersion, t.availableVersion ?? "—", t.action].map(clean).join("\t")).join("\n")}\n${data.target?.reason ? `${clean(data.target.reason)}\n` : ""}Last scan: ${clean(data.lastRefreshAt ?? "Never")}. Run baseline check for a fresh scan.\n${data.planID ? `Plan: ${data.planID}\n${clean(data.effects ?? "")}\n` : ""}`;
  }
  if (data?.diagnostics) return `${data.diagnostics.split("\n").map(clean).join("\n")}\n`;
  if (data?.version)
    return `Baseline ${clean(data.version)}\nLast explicit check: ${clean(data.lastExplicitCheckAt ?? "Never")}\nLast scan: ${clean(data.lastRefreshAt ?? "Never")}\nHomebrew check: ${clean(data.homebrewCheckStatus ?? "unknown")}\n${data.freshForUpdates ? "A recent explicit check is available; individual target protections still apply." : "Run baseline check before updating."}\n${(data.notices ?? []).map((notice) => `${clean(notice)}\n`).join("")}`;
  return `${JSON.stringify(response.data, null, 2)}\n`;
}

async function main(): Promise<void> {
  let json = process.argv.includes("--json");
  let operationID: string | undefined;
  let sessionID = "";
  let interrupted = false;
  let signalCode: number = cliExit.interrupted;
  const interrupt = new AbortController();
  const onInterrupt = () => {
    interrupted = true;
    signalCode = cliExit.interrupted;
    interrupt.abort(
      new CLIError(
        "interrupted",
        "Stopped waiting. Accepted work continues in Baseline.",
        signalCode
      )
    );
  };
  const onTerminate = () => {
    interrupted = true;
    signalCode = 143;
    interrupt.abort(
      new CLIError(
        "interrupted",
        "Stopped waiting. Accepted work continues in Baseline.",
        signalCode
      )
    );
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const output = (response: CLIResponse) => {
    process.exitCode = response.exitCode;
    const content = json ? `${JSON.stringify(response)}\n` : human(response);
    (json || response.ok ? process.stdout : process.stderr).write(content);
  };
  try {
    const parsed = parseCLIArguments(process.argv.slice(2));
    json = parsed.json;
    if (parsed.local) {
      const text = parsed.local === "help" ? cliHelp : packageJSON.version;
      if (json)
        output({
          schemaVersion: 1,
          sessionID,
          ok: true,
          exitCode: 0,
          data: parsed.local === "help" ? { help: text } : { version: text }
        });
      else process.stdout.write(`${text}\n`);
      return;
    }
    const request = parsed.request!;
    operationID = request.operationID;
    const userData = cliUserData();
    const start = performance.now();
    const send = (r: Parameters<typeof sendCLIRequest>[1]) => {
      const remaining = parsed.timeoutMS - (performance.now() - start);
      if (remaining <= 0)
        throw new CLIError(
          "timeout",
          "Stopped waiting. Query the operation ID before retrying any submitted work.",
          cliExit.timeout
        );
      return sendCLIRequest(userData, r, {
        timeoutMS: Math.min(10_000, remaining),
        signal: interrupt.signal
      });
    };
    const checkInterrupt = () => {
      if (interrupted)
        throw new CLIError(
          "interrupted",
          "Stopped waiting. Accepted work continues in Baseline.",
          signalCode
        );
    };
    // Probe with a harmless read before launching. Never resend a mutation after
    // any transport uncertainty. Startup retries are exclusively status reads.
    let probe: CLIResponse | undefined;
    try {
      probe = await send({ schemaVersion: 1, command: "status" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOENT", "ECONNREFUSED"].includes(code ?? "")) throw error;
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      delete env.NODE_REPL_EXTERNAL_MODULE;
      const child = spawn(process.execPath, ["--baseline-cli-background"], {
        detached: true,
        stdio: "ignore",
        env,
        cwd: path.dirname(process.execPath)
      });
      let launchError: Error | undefined;
      child.once("error", (e) => {
        launchError = e;
      });
      child.unref();
      while (performance.now() - start < Math.min(parsed.timeoutMS, 15_000)) {
        checkInterrupt();
        if (launchError)
          throw new CLIError(
            "launch-failed",
            "Could not launch the packaged Baseline app.",
            cliExit.unavailable
          );
        await pause(100);
        try {
          probe = await send({ schemaVersion: 1, command: "status" });
          break;
        } catch (retryError) {
          if (
            !["ENOENT", "ECONNREFUSED"].includes((retryError as NodeJS.ErrnoException).code ?? "")
          )
            throw retryError;
        }
      }
    }
    if (!probe)
      throw new CLIError(
        "backend-unavailable",
        "Baseline did not start its CLI backend. Quit any older running copy, then update or restart the app.",
        cliExit.unavailable
      );
    sessionID = probe.sessionID;
    checkInterrupt();
    if (operationID && request.command !== "operation")
      process.stderr.write(`Operation: ${operationID}\n`);
    let response = await send(request);
    if (response.sessionID !== sessionID)
      throw new CLIError(
        "session-changed",
        "Baseline restarted. Inspect installed state before retrying.",
        cliExit.unavailable
      );
    let operation = (response.data as { operation?: CLIOperation } | undefined)?.operation;
    while (response.ok && operation && !operation.finishedAt && parsed.wait) {
      checkInterrupt();
      if (performance.now() - start >= parsed.timeoutMS)
        throw new CLIError(
          "timeout",
          "Stopped waiting. Accepted work continues; query the operation ID before retrying.",
          cliExit.timeout
        );
      await pause(200);
      response = await send({
        schemaVersion: 1,
        command: "operation",
        operationID: operation.id
      });
      if (response.sessionID !== sessionID)
        throw new CLIError(
          "session-changed",
          "Baseline restarted. Inspect installed state before retrying.",
          cliExit.unavailable
        );
      operation = (response.data as { operation?: CLIOperation } | undefined)?.operation;
    }
    if (operation?.finishedAt)
      response = { ...response, ok: operation.exitCode === 0, exitCode: operation.exitCode };
    output(response);
  } catch (error) {
    const e =
      error instanceof CLIError
        ? error
        : new CLIError(
            "unavailable",
            "Could not reach Baseline. Restart the app and run baseline doctor.",
            cliExit.unavailable
          );
    output({
      schemaVersion: 1,
      sessionID,
      ok: false,
      exitCode: e.exitCode,
      error: { code: e.code, message: e.message },
      ...(operationID
        ? {
            data: {
              operationID,
              outcome: "unknown-or-running",
              next: `baseline operation ${operationID} --json`
            }
          }
        : {})
    });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

for (const stream of [process.stdout, process.stderr])
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    else process.exit(1);
  });
void main();
