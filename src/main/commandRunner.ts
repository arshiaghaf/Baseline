// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename } from "node:path";
import { CommandCapture, CommandOutputStream } from "./commandOutput";
import { terminateCommandGroup } from "./commandProcessGroup";
import {
  homebrewEnvironment,
  homebrewReadCommand,
  commandReadTimeoutMs,
  commandCompleteCaptureBytes,
  commandTailCaptureBytes
} from "./commandEnvironment";
import {
  brewExecutableCandidates,
  masExecutableCandidates,
  resolvedExecutablePath
} from "../shared/security";

// A failed group signal is an uncertainty boundary shared by direct inventory
// callers and operation wrappers. Only restarting the process clears quarantine.
let homebrewCleanupUnconfirmed = false;

/** Also covers direct inventory callers that do not retain CommandResult.failure. */
export function homebrewCleanupIsUnconfirmed(): boolean {
  return homebrewCleanupUnconfirmed;
}

export type CommandResult = {
  success: boolean;
  status: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  failure?: CommandFailure;
  outputTruncated?: boolean;
};

export type CommandFailure = {
  kind: "spawn" | "signal" | "cancelled" | "timeout" | "output-limit" | "callback" | "cleanup";
  message: string;
  code?: string;
};

export type CommandOptions = {
  signal?: AbortSignal;
  /** Zero disables the deadline. Generic commands have no default deadline. */
  timeoutMs?: number;
  /** Overlay inherited environment; Homebrew applies its interaction policy last. */
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  /** Complete capture fails closed on overflow. Tail capture never interrupts work. */
  capture?: "complete" | "tail";
  terminationGraceMs?: number;
  /** Total TERM/KILL/verification budget; uncertainty returns a cleanup failure. */
  cleanupTimeoutMs?: number;
};

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolvedBrewExecutablePath(): Promise<string | undefined> {
  const executable = async (path: string) => isExecutable(path);
  for (const candidate of brewExecutableCandidates()) {
    if (await executable(candidate)) {
      return resolvedExecutablePath([candidate], () => true);
    }
  }
  return undefined;
}

export async function resolvedMasExecutablePath(): Promise<string | undefined> {
  const executable = async (path: string) => isExecutable(path);
  for (const candidate of masExecutableCandidates()) {
    if (await executable(candidate)) {
      return resolvedExecutablePath([candidate], () => true);
    }
  }
  return undefined;
}

export async function runCommand(
  executablePath: string,
  args: string[],
  onOutputLine: (line: string) => void = () => undefined,
  options: CommandOptions = {}
): Promise<CommandResult> {
  return executeCommand(executablePath, args, onOutputLine, options);
}

async function executeCommand(
  executablePath: string,
  args: string[],
  onOutputLine: (line: string) => void = () => undefined,
  options: CommandOptions = {},
  onCleanupFailure?: () => void
): Promise<CommandResult> {
  const empty = { success: false, status: null, output: "", stdout: "", stderr: "" };
  if (options.signal?.aborted) {
    return {
      ...empty,
      failure: { kind: "cancelled", message: "Command cancelled before launch." }
    };
  }
  const tail = options.capture === "tail";
  const maxBytes =
    options.maxOutputBytes ?? (tail ? commandTailCaptureBytes : commandCompleteCaptureBytes);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    (options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) ||
        options.timeoutMs < 0 ||
        options.timeoutMs > 2_147_483_647)) ||
    (options.terminationGraceMs !== undefined &&
      (!Number.isFinite(options.terminationGraceMs) || options.terminationGraceMs < 0)) ||
    (options.cleanupTimeoutMs !== undefined &&
      (!Number.isFinite(options.cleanupTimeoutMs) || options.cleanupTimeoutMs < 1))
  ) {
    throw new RangeError("Invalid command capture limit or deadline.");
  }
  return new Promise((resolve) => {
    const output = new CommandCapture(maxBytes, tail);
    const stdout = new CommandCapture(maxBytes, tail);
    const stderr = new CommandCapture(maxBytes, tail);
    let failure: CommandFailure | undefined;
    let cleanup: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(executablePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, ...options.env }
    });
    let settled = false;
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (signal && !failure)
        failure = { kind: "signal", message: `Command terminated by ${signal}.` };
      const invalidCapture = !tail && (output.truncated || failure?.kind === "cleanup");
      resolve({
        success: status === 0 && !failure,
        status: failure?.kind === "spawn" ? null : status,
        signal,
        failure,
        outputTruncated: output.truncated,
        stdout: invalidCapture ? "" : stdout.text(),
        stderr: stderr.text(),
        output: invalidCapture ? "" : output.text()
      });
    };
    const clean = () => {
      cleanup ??= terminateCommandGroup(
        child,
        options.terminationGraceMs ?? 1_000,
        options.cleanupTimeoutMs ?? 3_000
      ).catch((error: NodeJS.ErrnoException) => {
        onCleanupFailure?.();
        failure = {
          kind: "cleanup",
          code: error.code,
          message:
            "Could not confirm command process-group cleanup. Check for and stop any remaining processes before retrying."
        };
        // Cleanup uncertainty must settle even while an unkillable child owns
        // open pipes. Release only our handles, never claim the process exited.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null, null);
      });
      return cleanup;
    };
    const stop = (reason: CommandFailure) => {
      failure ??= reason;
      void clean();
    };
    const onAbort = () => stop({ kind: "cancelled", message: "Command cancelled." });
    const onLine = (line: string) => {
      if (failure) return;
      try {
        onOutputLine(line);
      } catch {
        stop({ kind: "callback", message: "Command output callback failed." });
      }
    };
    const stream = (capture: CommandCapture) =>
      new CommandOutputStream((text) => {
        capture.append(text);
        output.append(text);
        if (!tail && output.truncated) {
          stop({ kind: "output-limit", message: `Command output exceeded ${maxBytes} bytes.` });
        }
      }, onLine);
    const stdoutStream = stream(stdout);
    const stderrStream = stream(stderr);
    child.stdout.on("data", (chunk: Buffer) => stdoutStream.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrStream.write(chunk));
    child.stdout.on("end", () => stdoutStream.end());
    child.stderr.on("end", () => stderrStream.end());
    child.on("error", (error: NodeJS.ErrnoException) => {
      // Never expose args, environment, or the error's potentially private path.
      failure ??= {
        kind: "spawn",
        code: error.code,
        message: `Could not launch ${basename(executablePath)} (${error.code ?? "unknown error"}).`
      };
    });
    child.on("exit", () => {
      void clean();
    });
    child.on("close", async (status, signal) => {
      await clean();
      finish(status, signal);
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    if (options.timeoutMs)
      timer = setTimeout(
        () =>
          stop({
            kind: "timeout",
            message: `Command exceeded its ${options.timeoutMs} ms deadline.`
          }),
        options.timeoutMs
      );
  });
}

export async function runBrewCommand(
  args: string[],
  onOutputLine?: (line: string) => void,
  options: CommandOptions = {}
): Promise<CommandResult> {
  if (homebrewCleanupUnconfirmed) return quarantinedHomebrew();
  const executable = await resolvedBrewExecutablePath();
  // A concurrent command may have failed teardown during executable resolution.
  if (homebrewCleanupUnconfirmed) return quarantinedHomebrew();
  if (!executable) return missingExecutable("Homebrew");
  const read = homebrewReadCommand(args);
  const commandOptions: CommandOptions = {
    timeoutMs: read ? commandReadTimeoutMs : 0,
    capture: read ? "complete" : "tail",
    ...options,
    env: homebrewEnvironment(executable, { ...process.env, ...options.env })
  };
  return executeCommand(executable, args, onOutputLine, commandOptions, () => {
    homebrewCleanupUnconfirmed = true;
  });
}

export async function runMasCommand(
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  const executable = await resolvedMasExecutablePath();
  if (!executable) return missingExecutable("mas");
  return runCommand(executable, args, undefined, {
    timeoutMs: args[0] === "version" ? commandReadTimeoutMs : 0,
    capture: args[0] === "version" ? "complete" : "tail",
    ...options
  });
}

function missingExecutable(name: string): CommandResult {
  return {
    success: false,
    status: null,
    output: "",
    stdout: "",
    stderr: "",
    failure: { kind: "spawn", code: "ENOENT", message: `${name} executable was not found.` }
  };
}

function quarantinedHomebrew(): CommandResult {
  return {
    success: false,
    status: null,
    output: "",
    stdout: "",
    stderr: "",
    failure: {
      kind: "cleanup",
      message:
        "Homebrew commands are blocked because earlier process cleanup was not confirmed. Check for and stop any remaining Homebrew processes before restarting Baseline and retrying."
    }
  };
}
