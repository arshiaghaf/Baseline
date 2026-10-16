// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const homebrewConfigurationBlockedMessage =
  "Homebrew configuration could not be used safely. Check brew.env for SUDO_ASKPASS or HOMEBREW_BASELINE_ASKPASS_ settings, and ensure its files are readable regular files, then refresh Baseline.";

type BlockReason = "conflict" | "unsupported" | "unreadable" | "changed";
export type HomebrewConfigurationCheck =
  { supported: false; reason: BlockReason } | { supported: true; revalidate(): Promise<boolean> };

class UnsupportedConfiguration extends Error {
  constructor(readonly reason: BlockReason) {
    super("Unsupported Homebrew configuration.");
  }
}

const maxConfigurationBytes = 64 * 1024;
const protectedKeys = new Set([
  "HOMEBREW_BREW_FILE",
  "HOMEBREW_PREFIX",
  "HOMEBREW_REPOSITORY",
  "HOMEBREW_LIBRARY",
  "HOMEBREW_USER_CONFIG_HOME"
]);

/** Literal bin/brew read -r semantics only. Never source/evaluate configuration.
 * Unsupported accepted export syntax fails closed; unrelated ignored lines stay ignored. */
function assignments(content: Buffer): Map<string, string> {
  if ([...content].some((byte) => byte !== 9 && byte !== 10 && (byte < 32 || byte > 126)))
    throw new UnsupportedConfiguration("unsupported");
  const entries = new Map<string, string>();
  // Bash's `while read -r line` does not process an unterminated final record.
  const lines = content.toString("utf8").split("\n").slice(0, -1);
  for (const raw of lines) {
    const line = raw.replace(/^[ \t]+|[ \t]+$/gu, "");
    if (!/^(HOMEBREW_|SUDO_ASKPASS=|(all|no|ftp|https?)_proxy=)/u.test(line)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new UnsupportedConfiguration("unsupported");
    const key = match[1]!,
      value = match[2]!;
    if (protectedKeys.has(key) || key === "HOMEBREW_EXPERIMENTAL_RUST_FRONTEND") continue;
    if (key === "SUDO_ASKPASS" || key.startsWith("HOMEBREW_BASELINE_ASKPASS_"))
      throw new UnsupportedConfiguration("conflict");
    entries.set(key, value);
  }
  return entries;
}

function absolute(value: string | undefined): string {
  if (
    !value ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    value.split(path.sep).some((component) => component === "." || component === "..")
  )
    throw new UnsupportedConfiguration("unsupported");
  return value;
}

async function symbolic(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function validateMissingAncestors(file: string): Promise<void> {
  let directory = path.dirname(file);
  for (;;) {
    try {
      const entry = await lstat(directory);
      if (entry.isSymbolicLink()) await realpath(directory);
      else if (!entry.isDirectory()) throw new UnsupportedConfiguration("unsupported");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling parent link is ambiguous, not a missing ordinary directory.
      if (await symbolic(directory)) throw new UnsupportedConfiguration("unsupported");
      const parent = path.dirname(directory);
      if (parent === directory) throw new UnsupportedConfiguration("unsupported");
      directory = parent;
    }
  }
}

async function linkRepository(file: string): Promise<string> {
  const directory = await realpath(path.dirname(file));
  const target = await readlink(file);
  // The launcher resolves the first link's directory, not an arbitrary final
  // executable realpath. Match that distinction for /usr/local/bin/brew.
  const targetDirectory = path.dirname(target);
  // Preserve kernel symlink/.. traversal; path.resolve would normalize first.
  return path.dirname(
    await realpath(
      path.isAbsolute(targetDirectory) ? targetDirectory : `${directory}/${targetDirectory}`
    )
  );
}

async function launcherPrefix(executable: string): Promise<string> {
  absolute(executable);
  if (path.basename(executable) !== "brew" || path.basename(path.dirname(executable)) !== "bin")
    throw new UnsupportedConfiguration("unsupported");
  const directory = await realpath(path.dirname(executable));
  const file = path.join(directory, "brew");
  const prefix = path.dirname(directory);
  const repository = (await symbolic(file)) ? await linkRepository(file) : prefix;
  let compatibilityLink = false;
  let compatibilityRepository: string | undefined;
  try {
    compatibilityLink = await symbolic("/usr/local/bin/brew");
    if (compatibilityLink) compatibilityRepository = await linkRepository("/usr/local/bin/brew");
  } catch {
    // The launcher's optional /usr/local compatibility lookup is a non-match
    // when its target cannot be entered. Selected-prefix checks remain strict.
  }
  if (
    compatibilityLink &&
    !(await symbolic(path.join(prefix, "Cellar"))) &&
    repository === compatibilityRepository
  )
    return "/usr/local";
  return prefix;
}

async function inspect(
  executable: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  const prefix = await launcherPrefix(executable);
  const effective = { ...environment };
  const load = async (file: string) => {
    signal?.throwIfAborted();
    hash.update(file).update("\0");
    let handle;
    try {
      // O_NONBLOCK precedes fstat: opening a FIFO must never wait for its writer.
      // Refuse final-component symlinks rather than following an ambiguous file.
      handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A dangling symlink is unsupported, not an absent configuration file.
        if (await symbolic(file)) throw new UnsupportedConfiguration("unsupported");
        await validateMissingAncestors(file);
        hash.update("absent\0");
        return;
      }
      throw new UnsupportedConfiguration("unreadable");
    }
    try {
      signal?.throwIfAborted();
      const before = await handle.stat({ bigint: true });
      signal?.throwIfAborted();
      if (!before.isFile() || before.size > BigInt(maxConfigurationBytes))
        throw new UnsupportedConfiguration("unsupported");
      const bytes = Buffer.alloc(maxConfigurationBytes + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      signal?.throwIfAborted();
      const after = await handle.stat({ bigint: true });
      if (
        bytesRead > maxConfigurationBytes ||
        before.size !== BigInt(bytesRead) ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new UnsupportedConfiguration("changed");
      const content = bytes.subarray(0, bytesRead);
      hash.update([before.dev, before.ino, before.mode, before.mtimeNs, before.ctimeNs].join(":"));
      hash.update(content).update("\0");
      for (const [key, value] of assignments(content)) effective[key] = value;
    } finally {
      await handle.close();
    }
  };
  await load("/etc/homebrew/brew.env");
  const systemPriority = Boolean(effective.HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY);
  await load(path.join(prefix, "etc/homebrew/brew.env"));
  const userDirectory = effective.XDG_CONFIG_HOME
    ? path.join(absolute(effective.XDG_CONFIG_HOME), "homebrew")
    : effective.HOMEBREW_XDG_CONFIG_HOME
      ? path.join(absolute(effective.HOMEBREW_XDG_CONFIG_HOME), "homebrew")
      : path.join(absolute(effective.HOME), ".homebrew");
  await load(path.join(userDirectory, "brew.env"));
  if (systemPriority) await load("/etc/homebrew/brew.env");
  return hash.digest("hex");
}

/** Assumes ordinary stable user configuration. Fingerprint revalidation reduces
 * races; it cannot enforce atomicity against malicious same-user replacement.
 * Refusal applies to reads as well as mutations; it never edits configuration. */
export async function checkHomebrewConfiguration(
  executable: string,
  inherited: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<HomebrewConfigurationCheck> {
  const environment = { ...inherited };
  try {
    const fingerprint = await inspect(executable, environment, signal);
    return {
      supported: true,
      revalidate: async () => {
        try {
          return (await inspect(executable, environment, signal)) === fingerprint;
        } catch {
          return false;
        }
      }
    };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof UnsupportedConfiguration ? error.reason : "unreadable"
    };
  }
}
