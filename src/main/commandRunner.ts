// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import {
  brewExecutableCandidates,
  masExecutableCandidates,
  resolvedExecutablePath
} from "../shared/security";

export type CommandResult = {
  success: boolean;
  status: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
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
  onOutputLine: (line: string) => void = () => undefined
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executablePath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    let stdoutBuffered = "";
    let stderrBuffered = "";

    const append = (chunk: Buffer, stream: string[], buffer: string): string => {
      const text = chunk.toString("utf8");
      output.push(text);
      stream.push(text);
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          onOutputLine(line);
        }
        newline = buffer.indexOf("\n");
      }
      return buffer;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffered = append(chunk, stdout, stdoutBuffered);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffered = append(chunk, stderr, stderrBuffered);
    });
    child.on("error", () => {
      resolve({
        success: false,
        status: null,
        output: output.join(""),
        stdout: stdout.join(""),
        stderr: stderr.join("")
      });
    });
    child.on("close", (status) => {
      for (const buffered of [stdoutBuffered, stderrBuffered]) {
        const line = buffered.trim();
        if (line) {
          onOutputLine(line);
        }
      }
      resolve({
        success: status === 0,
        status,
        output: output.join(""),
        stdout: stdout.join(""),
        stderr: stderr.join("")
      });
    });
  });
}

export async function runBrewCommand(
  args: string[],
  onOutputLine?: (line: string) => void
): Promise<CommandResult> {
  const executable = await resolvedBrewExecutablePath();
  if (!executable) {
    return { success: false, status: null, output: "", stdout: "", stderr: "" };
  }
  return runCommand(executable, args, onOutputLine);
}

export async function runMasCommand(args: string[]): Promise<CommandResult> {
  const executable = await resolvedMasExecutablePath();
  if (!executable) {
    return { success: false, status: null, output: "", stdout: "", stderr: "" };
  }
  return runCommand(executable, args);
}
