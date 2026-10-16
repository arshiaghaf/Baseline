// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename } from "node:path";
import {
  checkHomebrewConfiguration,
  homebrewConfigurationBlockedMessage
} from "./homebrewConfiguration";
import { OperationOutputTail } from "./operationOutputTail";
import { CommandCapture, CommandOutputStream } from "./commandOutput";
import { terminateCommandGroup } from "./commandProcessGroup";
import { CommandPreflight, PreflightInterrupted } from "./commandPreflight";
import { CommandCleanup } from "./commandCleanup";
import {
  createAdminAskpassSession,
  releaseAdminAskpassSession,
  type AdminAskpassSession
} from "./adminAskpassRuntime";
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
  /** Independent of helper/cleanup failure; never infer cancellation from exit status. */
  cancelled?: boolean;
  status: number | null;
  output: string;
  /** Sanitized ephemeral support tail; never derived from truncated raw capture. */
  outputTail?: string;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  failure?: CommandFailure;
  outputTruncated?: boolean;
};

export type CommandFailure = {
  kind:
    | "spawn"
    | "signal"
    | "cancelled"
    | "timeout"
    | "output-limit"
    | "callback"
    | "cleanup"
    | "admin-helper"
    | "configuration-blocked";
  message: string;
  code?: string;
};

export type CommandOptions = {
  /** Status metadata only. Eligibility also requires main-process helper setup. */
  adminOperation?: {
    operationID: string;
    onWaitingChanged(waitingPromptID: string | undefined): void;
  };
  collectOutputTail?: boolean;
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

export function commandWasCancelled(result: CommandResult): boolean {
  return result.cancelled === true || result.failure?.kind === "cancelled";
}

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
  onCleanupFailure?: () => void,
  admin?: AdminAskpassSession,
  cleanupBudget = new CommandCleanup(options.cleanupTimeoutMs ?? 3_000)
): Promise<CommandResult> {
  const empty = { success: false, status: null, output: "", stdout: "", stderr: "" };
  if (options.signal?.aborted) {
    if (admin) await admin.coordinator.prepareCleanup("cancelled", performance.now());
    return {
      ...empty,
      cancelled: true,
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
    const supportTail = options.collectOutputTail ? new OperationOutputTail() : undefined;
    const output = new CommandCapture(maxBytes, tail);
    const stdout = new CommandCapture(maxBytes, tail);
    const stderr = new CommandCapture(maxBytes, tail);
    let failure: CommandFailure | undefined;
    let cancellationRequested = false;
    let cleanup: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(executablePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, ...options.env }
    });
    let settled = false;
    const finish = async (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      admin?.stop.removeEventListener("abort", onAdminStop);
      if (signal && !failure)
        failure = { kind: "signal", message: `Command terminated by ${signal}.` };
      const cancelled =
        cancellationRequested ||
        failure?.kind === "cancelled" ||
        admin?.coordinator.lifecycle.cancelled;
      if (admin) {
        try {
          const evidence = await cleanupBudget.wait(
            admin.coordinator.finish(failure?.kind !== "cleanup")
          );
          if (!evidence.cleanupConfirmed)
            throw new Error("Unconfirmed administrator helper cleanup.");
          if (evidence.helperError && (!failure || failure.kind === "cancelled"))
            failure = {
              kind: "admin-helper",
              message: "The administrator password helper failed."
            };
        } catch {
          onCleanupFailure?.();
          failure = {
            kind: "cleanup",
            message:
              "Could not confirm administrator helper cleanup. Restart Baseline after checking running Homebrew processes."
          };
        }
      }
      const invalidCapture = !tail && (output.truncated || failure?.kind === "cleanup");
      resolve({
        success: status === 0 && !failure && !cancelled,
        ...(cancelled ? { cancelled: true } : {}),
        status: failure?.kind === "spawn" ? null : status,
        signal,
        failure,
        outputTail: supportTail?.text(),
        outputTruncated: output.truncated,
        stdout: invalidCapture ? "" : stdout.text(),
        stderr: stderr.text(),
        output: invalidCapture ? "" : output.text()
      });
    };
    const clean = () => {
      cleanup ??= (async () => {
        const budget = options.cleanupTimeoutMs ?? 3_000;
        const deadline = cleanupBudget.deadline;
        let helperCleanupFailed = false;
        if (admin) {
          try {
            await cleanupBudget.wait(
              admin.coordinator.prepareCleanup(
                admin.coordinator.lifecycle.cancelled || failure?.kind === "cancelled"
                  ? "cancelled"
                  : failure?.kind === "admin-helper"
                    ? "error"
                    : "command-exit",
                Math.min(deadline, performance.now() + Math.min(1_000, budget / 2))
              )
            );
          } catch {
            helperCleanupFailed = true;
          }
        }
        // Attempt group teardown even when status transport shutdown stalled.
        await cleanupBudget.wait(
          terminateCommandGroup(
            child,
            options.terminationGraceMs ?? 1_000,
            Math.max(1, deadline - performance.now())
          )
        );
        if (helperCleanupFailed)
          throw new Error("Administrator helper cleanup could not be confirmed.");
      })().catch((error: NodeJS.ErrnoException) => {
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
        void finish(null, null);
      });
      return cleanup;
    };
    const stop = (reason: CommandFailure) => {
      failure ??= reason;
      void clean();
    };
    const onAbort = () => {
      cancellationRequested = true;
      stop({ kind: "cancelled", message: "Command cancelled." });
    };
    const onAdminStop = () => {
      cancellationRequested ||= admin?.stopReason() === "cancelled";
      stop(
        admin?.stopReason() === "cancelled"
          ? { kind: "cancelled", message: "Administrator password entry cancelled." }
          : { kind: "admin-helper", message: "The administrator password helper failed." }
      );
    };
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
    child.stdout.on("data", (chunk: Buffer) => {
      supportTail?.write("stdout", chunk);
      stdoutStream.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      supportTail?.write("stderr", chunk);
      stderrStream.write(chunk);
    });
    child.stdout.on("end", () => {
      supportTail?.end("stdout");
      stdoutStream.end();
    });
    child.stderr.on("end", () => {
      supportTail?.end("stderr");
      stderrStream.end();
    });
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
      await finish(status, signal);
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    admin?.stop.addEventListener("abort", onAdminStop, { once: true });
    if (options.signal?.aborted) onAbort();
    if (admin?.stop.aborted) onAdminStop();
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
  const read = homebrewReadCommand(args);
  const cleanupBudget = new CommandCleanup(options.cleanupTimeoutMs ?? 3_000);
  const preflight = new CommandPreflight(
    options.timeoutMs ?? (read ? commandReadTimeoutMs : 0),
    options.signal
  );
  let admin: AdminAskpassSession | undefined;
  let outcome: CommandResult | undefined;
  const respond = (result: CommandResult) => (outcome = result);
  const disposeAdmin = async (session: AdminAskpassSession): Promise<boolean> => {
    let confirmed = false;
    try {
      confirmed = (await session.coordinator.finish(true)).cleanupConfirmed;
    } catch {
      // Completion/absence evidence remains independent from cancellation.
    } finally {
      if (!confirmed) homebrewCleanupUnconfirmed = true;
      releaseAdminAskpassSession(session);
    }
    return confirmed;
  };
  try {
    const executable = await preflight.run(resolvedBrewExecutablePath);
    if (homebrewCleanupUnconfirmed) return respond(quarantinedHomebrew());
    if (!executable) return respond(missingExecutable("Homebrew"));
    const commandOptions: CommandOptions = {
      collectOutputTail: !read,
      timeoutMs: read ? commandReadTimeoutMs : 0,
      capture: read ? "complete" : "tail",
      ...options,
      env: homebrewEnvironment(executable, { ...process.env, ...options.env })
    };
    const configuration = await preflight.run(() =>
      checkHomebrewConfiguration(executable, commandOptions.env!, preflight.cancellationSignal)
    );
    const blocked = (): CommandResult => ({
      success: false,
      status: null,
      output: "",
      stdout: "",
      stderr: "",
      failure: { kind: "configuration-blocked", message: homebrewConfigurationBlockedMessage }
    });
    if (!configuration.supported || !(await preflight.run(configuration.revalidate)))
      return respond(blocked());
    if (homebrewCleanupUnconfirmed) return respond(quarantinedHomebrew());
    const operation = options.adminOperation;
    try {
      admin = await preflight.run(
        () =>
          createAdminAskpassSession(
            args,
            operation && {
              ...operation,
              onWaitingChanged: (promptID) => {
                if (!preflight.cancellationSignal.aborted && !options.signal?.aborted)
                  operation.onWaitingChanged(promptID);
              }
            }
          ),
        {
          dispose: async (session) => {
            if (session) await cleanupBudget.wait(disposeAdmin(session));
          },
          failed: () => {
            homebrewCleanupUnconfirmed = true;
          }
        }
      );
    } catch (error) {
      if (error instanceof PreflightInterrupted) throw error;
      return respond({
        success: false,
        status: null,
        output: "",
        stdout: "",
        stderr: "",
        failure: {
          kind: "admin-helper",
          message: "The administrator password helper is unavailable."
        }
      });
    }
    if (admin) commandOptions.env = { ...commandOptions.env, ...admin.environment };
    if (homebrewCleanupUnconfirmed) return respond(quarantinedHomebrew());
    // Socket setup is asynchronous; the final revalidation shares the budget.
    if (!(await preflight.run(configuration.revalidate))) return respond(blocked());
    commandOptions.timeoutMs = preflight.remainingMs();
    preflight.dispose();
    return respond(
      await executeCommand(
        executable,
        args,
        onOutputLine,
        commandOptions,
        () => {
          homebrewCleanupUnconfirmed = true;
        },
        admin,
        cleanupBudget
      )
    );
  } catch (error) {
    if (error instanceof PreflightInterrupted) return respond(error.result());
    throw error;
  } finally {
    preflight.dispose();
    let confirmed = true;
    if (admin) {
      try {
        confirmed = await cleanupBudget.wait(disposeAdmin(admin));
      } catch {
        confirmed = false;
        homebrewCleanupUnconfirmed = true;
      }
    }
    if (!confirmed && outcome) {
      outcome.success = false;
      outcome.failure = {
        kind: "cleanup",
        message:
          "Could not confirm administrator helper cleanup. Restart Baseline after checking running Homebrew processes."
      };
    }
  }
}

export async function runMasCommand(
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  const executable = await resolvedMasExecutablePath();
  if (!executable) return missingExecutable("mas");
  return runCommand(executable, args, undefined, {
    collectOutputTail: args[0] === "upgrade",
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
