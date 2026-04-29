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
    let buffered = "";

    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output.push(text);
      buffered += text;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) {
          onOutputLine(line);
        }
        newline = buffered.indexOf("\n");
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", () => {
      resolve({ success: false, status: null, output: output.join("") });
    });
    child.on("close", (status) => {
      const line = buffered.trim();
      if (line) {
        onOutputLine(line);
      }
      resolve({ success: status === 0, status, output: output.join("") });
    });
  });
}

export async function runBrewCommand(
  args: string[],
  onOutputLine?: (line: string) => void
): Promise<CommandResult> {
  const executable = await resolvedBrewExecutablePath();
  if (!executable) {
    return { success: false, status: null, output: "" };
  }
  return runCommand(executable, args, onOutputLine);
}

export async function runMasCommand(args: string[]): Promise<CommandResult> {
  const executable = await resolvedMasExecutablePath();
  if (!executable) {
    return { success: false, status: null, output: "" };
  }
  return runCommand(executable, args);
}
