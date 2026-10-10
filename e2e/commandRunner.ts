// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { CommandResult } from "../src/main/commandRunner";

export type E2ECommandControl = { finish?: () => void; commands: string[][] };
const failedCommand: CommandResult = {
  success: false,
  status: 1,
  output: "Test command unavailable"
};

// Only the disposable E2E bundle uses this provider. Never execute host tools.
export async function runBrewCommand(): Promise<CommandResult> {
  return failedCommand;
}

export async function runMasCommand(args: string[]): Promise<CommandResult> {
  const control = (
    globalThis as typeof globalThis & {
      nativeTrayProbe?: { command: E2ECommandControl };
    }
  ).nativeTrayProbe?.command;
  if (!control) return failedCommand;
  control.commands.push(args);
  return new Promise((resolve) => {
    control.finish = () => resolve(failedCommand);
  });
}

export type { CommandResult };
