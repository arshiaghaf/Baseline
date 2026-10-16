// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { dirname } from "node:path";

/** Preserve proxy, certificate, locale and custom Homebrew configuration. No login shell
 * is sourced; Homebrew itself still reads its supported brew.env files. These output
 * and interaction controls are app policy, applied after any caller overlay. */
export function homebrewEnvironment(
  executablePath: string,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...inherited,
    PATH: [
      ...new Set(
        [
          dirname(executablePath),
          ...(inherited.PATH ?? "").split(":"),
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin"
        ].filter(Boolean)
      )
    ].join(":"),
    // Keep an explicitly configured locale. Finder launches may provide none.
    ...(inherited.LANG || inherited.LC_ALL ? {} : { LANG: "en_US.UTF-8" }),
    NONINTERACTIVE: "1",
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_ANALYTICS: "1",
    HOMEBREW_NO_ENV_HINTS: "1",
    HOMEBREW_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
    NO_COLOR: "1",
    TERM: "dumb"
  };
  // Eligibility and operation metadata must come from the current coordinator,
  // never a Finder/shell/caller overlay. Reads must never inherit askpass.
  for (const key of Object.keys(environment)) {
    if (
      key === "SUDO_ASKPASS" ||
      key.startsWith("HOMEBREW_BASELINE_ASKPASS_") ||
      key.startsWith("BASELINE_ASKPASS_")
    )
      environment[key] = undefined;
  }
  return environment;
}

// Unknown commands are deliberately treated as mutations: builds/downloads may take
// hours. Only these known reads receive an automatic deadline.
export function homebrewReadCommand(args: string[]): boolean {
  return (
    ["--version", "--prefix", "list", "info", "outdated", "config", "doctor"].includes(
      args[0] ?? ""
    ) ||
    (args[0] === "services" && ["info", "list"].includes(args[1] ?? ""))
  );
}

export const commandReadTimeoutMs = 120_000;
export const commandCompleteCaptureBytes = 32 * 1024 * 1024;
export const commandTailCaptureBytes = 1024 * 1024;
