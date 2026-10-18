// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { HomebrewConfigurationReason, HomebrewConfigurationSetting } from "../shared/domain";
import { redactHomePaths } from "./redactHomePaths";

export const homebrewConfigurationBlockedMessage =
  "Homebrew configuration needs attention. Open Settings for details.";

type BlockReason = "conflict" | "unsupported" | "unreadable" | "changed";
export type HomebrewConfigurationCheck =
  | { supported: false; reason: BlockReason; detail: HomebrewConfigurationReason }
  | {
      supported: true;
      revalidate(): Promise<boolean>;
      revalidateDetailed(): Promise<HomebrewRevalidation>;
    };
export type HomebrewRevalidation =
  { valid: true } | { valid: false; detail: HomebrewConfigurationReason };

class UnsupportedConfiguration extends Error {
  constructor(
    readonly reason: BlockReason,
    readonly detail: HomebrewConfigurationReason = { kind: "unknown" }
  ) {
    super("Unsupported Homebrew configuration.");
  }
}

function safePath(value: string): string | undefined {
  if (
    !path.isAbsolute(value) ||
    value.length > 1024 ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return (
        code < 32 ||
        (code >= 127 && code <= 159) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    }) ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    return undefined;
  return redactHomePaths(value);
}

const reasonKinds = new Set<HomebrewConfigurationReason["kind"]>([
  "sudo-askpass",
  "reserved-askpass",
  "unsupported-content",
  "invalid-assignment",
  "unreadable",
  "non-regular",
  "oversize",
  "invalid-setting-path",
  "invalid-folder",
  "invalid-executable",
  "changed",
  "incomplete-read",
  "unknown"
]);
const settingNames = new Set<HomebrewConfigurationSetting>([
  "HOME",
  "XDG_CONFIG_HOME",
  "HOMEBREW_XDG_CONFIG_HOME"
]);

/** Rebuild the IPC diagnostic from a fixed vocabulary, including injected runners. */
export function safeConfigurationReason(value: unknown): HomebrewConfigurationReason {
  if (!value || typeof value !== "object") return { kind: "unknown" };
  const input = value as Record<string, unknown>;
  const kind = reasonKinds.has(input.kind as HomebrewConfigurationReason["kind"])
    ? (input.kind as HomebrewConfigurationReason["kind"])
    : "unknown";
  const displayPath = (candidate: unknown) => {
    if (typeof candidate !== "string") return undefined;
    if (candidate.startsWith("~/")) return safePath(`/Users/redacted/${candidate.slice(2)}`);
    return safePath(candidate);
  };
  return {
    kind,
    file: kind === "invalid-executable" ? undefined : displayPath(input.file),
    path: kind === "invalid-executable" ? displayPath(input.path) : undefined,
    line:
      kind === "invalid-assignment" &&
      Number.isSafeInteger(input.line) &&
      (input.line as number) > 0 &&
      (input.line as number) <= maxConfigurationBytes
        ? (input.line as number)
        : undefined,
    setting:
      kind === "invalid-setting-path" &&
      settingNames.has(input.setting as HomebrewConfigurationSetting)
        ? (input.setting as HomebrewConfigurationSetting)
        : undefined
  };
}

function fileReason(kind: HomebrewConfigurationReason["kind"], file: string, line?: number) {
  return { kind, file: safePath(file), line } satisfies HomebrewConfigurationReason;
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
function assignments(content: Buffer, file: string): Map<string, string> {
  const entries = new Map<string, string>();
  // Bash's `while read -r line` does not process an unterminated final record.
  const lines = content.toString("utf8").split("\n").slice(0, -1);
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/^[ \t]+|[ \t]+$/gu, "");
    if (!/^(HOMEBREW_|SUDO_ASKPASS=|(all|no|ftp|https?)_proxy=)/u.test(line)) continue;
    if (
      [...protectedKeys].some((key) => line === key || line.startsWith(`${key}=`)) ||
      line.startsWith("HOMEBREW_EXPERIMENTAL_RUST_FRONTEND=")
    )
      continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match)
      throw new UnsupportedConfiguration(
        "unsupported",
        fileReason("invalid-assignment", file, index + 1)
      );
    const key = match[1]!,
      value = match[2]!;
    if (key === "SUDO_ASKPASS" || key.startsWith("HOMEBREW_BASELINE_ASKPASS_"))
      throw new UnsupportedConfiguration(
        "conflict",
        fileReason(key === "SUDO_ASKPASS" ? "sudo-askpass" : "reserved-askpass", file)
      );
    // The launcher skips unrelated records before exporting anything. Bytes in
    // those records have no effect, including comments with UTF-8 or CRLF.
    if ([...Buffer.from(raw)].some((byte) => byte !== 9 && (byte < 32 || byte > 126)))
      throw new UnsupportedConfiguration("unsupported", fileReason("unsupported-content", file));
    entries.set(key, value);
  }
  return entries;
}

function absolute(
  value: string | undefined,
  setting?: HomebrewConfigurationSetting,
  source?: string
): string {
  if (
    !value ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    value.split(path.sep).some((component) => component === "." || component === "..")
  )
    throw new UnsupportedConfiguration("unsupported", {
      kind: setting ? "invalid-setting-path" : "invalid-executable",
      setting,
      file: source ? safePath(source) : undefined,
      path: setting ? undefined : value ? safePath(value) : undefined
    });
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
      else if (!entry.isDirectory())
        throw new UnsupportedConfiguration("unsupported", fileReason("invalid-folder", file));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling parent link is ambiguous, not a missing ordinary directory.
      if (await symbolic(directory))
        throw new UnsupportedConfiguration("unsupported", fileReason("invalid-folder", file));
      const parent = path.dirname(directory);
      if (parent === directory)
        throw new UnsupportedConfiguration("unsupported", fileReason("invalid-folder", file));
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
    throw new UnsupportedConfiguration("unsupported", {
      kind: "invalid-executable",
      path: safePath(executable)
    });
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
): Promise<{ fingerprint: string; files: { file: string; fingerprint: string }[] }> {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  const files: { file: string; fingerprint: string }[] = [];
  let prefix: string;
  try {
    prefix = await launcherPrefix(executable);
  } catch (error) {
    if (error instanceof UnsupportedConfiguration) throw error;
    throw new UnsupportedConfiguration("unreadable", {
      kind: "invalid-executable",
      path: safePath(executable)
    });
  }
  const effective = { ...environment };
  const sources = new Map<string, string>();
  const load = async (file: string) => {
    signal?.throwIfAborted();
    hash.update(file).update("\0");
    const linkState = async () => {
      try {
        const entry = await lstat(file, { bigint: true });
        if (!entry.isSymbolicLink()) return "regular";
        return `${entry.dev}:${entry.ino}:${entry.mtimeNs}:${entry.ctimeNs}:${await readlink(file)}:${await realpath(file)}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !(await symbolic(file)))
          return "absent";
        throw error;
      }
    };
    let handle;
    let firstLinkState: string;
    try {
      // O_NONBLOCK precedes fstat: opening a FIFO must never wait for its writer.
      // Follow supported configuration links, recording the link as well as the
      // opened target so replacement is detected during and after preflight.
      firstLinkState = await linkState();
      handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A dangling symlink is unsupported, not an absent configuration file.
        if (await symbolic(file))
          throw new UnsupportedConfiguration("unsupported", fileReason("invalid-folder", file));
        try {
          await validateMissingAncestors(file);
        } catch (ancestorError) {
          if (ancestorError instanceof UnsupportedConfiguration) throw ancestorError;
          throw new UnsupportedConfiguration("unreadable", fileReason("unreadable", file));
        }
        hash.update("absent\0");
        files.push({ file, fingerprint: "absent" });
        return;
      }
      throw new UnsupportedConfiguration("unreadable", fileReason("unreadable", file));
    }
    let readError: unknown;
    try {
      signal?.throwIfAborted();
      const before = await handle.stat({ bigint: true });
      signal?.throwIfAborted();
      if (!before.isFile())
        throw new UnsupportedConfiguration("unsupported", fileReason("non-regular", file));
      if (before.size > BigInt(maxConfigurationBytes))
        throw new UnsupportedConfiguration("unsupported", fileReason("oversize", file));
      const bytes = Buffer.alloc(maxConfigurationBytes + 1);
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(bytes, 0, bytes.length, 0));
      } catch {
        throw new UnsupportedConfiguration("unreadable", fileReason("incomplete-read", file));
      }
      signal?.throwIfAborted();
      const after = await handle.stat({ bigint: true });
      if (
        firstLinkState !== (await linkState()) ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new UnsupportedConfiguration("changed", fileReason("changed", file));
      if (bytesRead > maxConfigurationBytes)
        throw new UnsupportedConfiguration("unsupported", fileReason("oversize", file));
      if (before.size !== BigInt(bytesRead))
        throw new UnsupportedConfiguration("changed", fileReason("incomplete-read", file));
      const content = bytes.subarray(0, bytesRead);
      hash.update(firstLinkState);
      const identity = [before.dev, before.ino, before.mode, before.mtimeNs, before.ctimeNs].join(
        ":"
      );
      hash.update(identity);
      hash.update(content).update("\0");
      files.push({
        file,
        fingerprint: createHash("sha256")
          .update(firstLinkState)
          .update(identity)
          .update(content)
          .digest("hex")
      });
      for (const [key, value] of assignments(content, file)) {
        effective[key] = value;
        sources.set(key, file);
      }
    } catch (error) {
      readError =
        error instanceof UnsupportedConfiguration
          ? error
          : new UnsupportedConfiguration("unreadable", fileReason("unreadable", file));
    }
    try {
      await handle.close();
    } catch {
      readError ??= new UnsupportedConfiguration("unreadable", fileReason("unreadable", file));
    }
    if (readError) throw readError;
  };
  await load("/etc/homebrew/brew.env");
  const systemPriority = Boolean(effective.HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY);
  await load(path.join(prefix, "etc/homebrew/brew.env"));
  const userDirectory = effective.XDG_CONFIG_HOME
    ? path.join(
        absolute(effective.XDG_CONFIG_HOME, "XDG_CONFIG_HOME", sources.get("XDG_CONFIG_HOME")),
        "homebrew"
      )
    : effective.HOMEBREW_XDG_CONFIG_HOME
      ? path.join(
          absolute(
            effective.HOMEBREW_XDG_CONFIG_HOME,
            "HOMEBREW_XDG_CONFIG_HOME",
            sources.get("HOMEBREW_XDG_CONFIG_HOME")
          ),
          "homebrew"
        )
      : path.join(absolute(effective.HOME, "HOME", sources.get("HOME")), ".homebrew");
  await load(path.join(userDirectory, "brew.env"));
  if (systemPriority) await load("/etc/homebrew/brew.env");
  return { fingerprint: hash.digest("hex"), files };
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
    const original = await inspect(executable, environment, signal);
    const revalidateDetailed = async (): Promise<HomebrewRevalidation> => {
      try {
        const current = await inspect(executable, environment, signal);
        if (current.fingerprint === original.fingerprint) return { valid: true };
        const changed = current.files.find(
          (entry, index) =>
            original.files[index]?.file === entry.file &&
            original.files[index]?.fingerprint !== entry.fingerprint
        );
        return {
          valid: false,
          detail: { kind: "changed", file: changed && safePath(changed.file) }
        };
      } catch (error) {
        return {
          valid: false,
          detail: error instanceof UnsupportedConfiguration ? error.detail : { kind: "unknown" }
        };
      }
    };
    return {
      supported: true,
      revalidate: async () => (await revalidateDetailed()).valid,
      revalidateDetailed
    };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof UnsupportedConfiguration ? error.reason : "unreadable",
      detail: error instanceof UnsupportedConfiguration ? error.detail : { kind: "unknown" }
    };
  }
}
