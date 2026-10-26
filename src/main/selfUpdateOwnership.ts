// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { CommandResult } from "./commandRunner";
import { installedInfoSection } from "./homebrewInstalledInfo";
import { HomebrewCaskClient } from "./homebrewCaskClient";
import { homebrewCommandToken } from "../shared/homebrewIdentity";
import { isValidHomebrewToken } from "../shared/security";
import { version } from "../shared/version";

type Run = (args: string[]) => Promise<CommandResult>;
const clean = (result: CommandResult) =>
  result.success &&
  result.status === 0 &&
  !result.failure &&
  !result.cancelled &&
  !result.signal &&
  !result.outputTruncated;
const output = (result: CommandResult) => result.stdout ?? result.output;
const absent = (result: CommandResult) =>
  !result.success && result.failure?.kind === "spawn" && result.failure.code === "ENOENT";

function versions(result: CommandResult): Map<string, string> | undefined {
  if (!clean(result)) return;
  const entries = new Map<string, string>();
  for (const line of output(result)
    .split(/\r?\n/u)
    .filter((line) => line.trim())) {
    const fields = line.trim().split(/\s+/u);
    const [token, installed] = fields;
    if (
      fields.length !== 2 ||
      !token ||
      !installed ||
      !isValidHomebrewToken(token) ||
      token.includes("/") ||
      entries.has(token) ||
      installed === "." ||
      installed === ".." ||
      /[/\\\0]/u.test(installed)
    )
      return;
    entries.set(token, installed);
  }
  return entries;
}

/** Called only while UpdateStore owns its Homebrew command reservation. No cached
 * catalogue or snapshot can prove absence of ownership. Cask app relocation leaves
 * a symlink in Caskroom; resolve those actual installed artifacts, including renames
 * and custom target directories, rather than guessing from a cask/app name. */
export async function directSelfInstallIsVerified(
  run: Run,
  host: { bundlePath?: string; bundleIdentifier?: string },
  files: {
    lstat: (file: string) => Promise<{ isSymbolicLink(): boolean }>;
    realpath: (file: string) => Promise<string>;
  } = { lstat, realpath },
  environment: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!host.bundlePath || !host.bundleIdentifier) return false;
  const [listed, info, prefixResult] = await Promise.all([
    run(["list", "--cask", "--versions"]),
    run(["info", "--cask", "--installed", "--json=v2"]),
    run(["--prefix"])
  ]);
  if ([listed, info, prefixResult].every(absent))
    return knownHomebrewScope(undefined, files, environment);
  const installed = versions(listed);
  const casks = clean(info) ? installedInfoSection(info, "cask") : undefined;
  if (!installed || !casks || casks.length !== installed.size || !clean(prefixResult)) return false;
  const prefix = output(prefixResult).trim();
  if (!path.isAbsolute(prefix) || prefix.includes("\n") || path.normalize(prefix) !== prefix)
    return false;
  const canonicalPrefix = await files.realpath(prefix);
  if (!(await knownHomebrewScope(canonicalPrefix, files, environment))) return false;
  const canonicalHost = await files.realpath(host.bundlePath);
  const records: { root: string; sources: string[]; command: string }[] = [];
  const parser = new HomebrewCaskClient();
  for (const raw of casks) {
    if (installed.get(raw.token) !== raw.installed || !Array.isArray(raw.artifacts)) return false;
    const entry = parser.parseIndex(Buffer.from(JSON.stringify([raw]))).byToken[raw.token];
    if (!entry) return false;
    const command = homebrewCommandToken({
      id: "ownership",
      token: raw.token,
      name: raw.token,
      kind: "cask",
      installedVersion: version(raw.installed),
      isOutdated: false,
      fullToken: raw.full_token,
      tap: raw.tap,
      caskMetadata: entry
    });
    if (!command) return false;
    if (
      entry.bundleIdentifiers.some(
        (id) => id.toLowerCase() === host.bundleIdentifier!.toLowerCase()
      )
    )
      return false;
    const sources: string[] = [];
    for (const artifact of raw.artifacts) {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false;
      // Package/flight installers do not provide a complete app-file ownership map.
      if (
        Object.keys(artifact).some(
          (key) =>
            ![
              "app",
              "binary",
              "font",
              "manpage",
              "uninstall",
              "zap",
              "bash_completion",
              "zsh_completion",
              "fish_completion"
            ].includes(key)
        )
      )
        return false;
      if (artifact.app !== undefined) {
        const source = Array.isArray(artifact.app) ? artifact.app[0] : undefined;
        if (
          typeof source !== "string" ||
          !source.endsWith(".app") ||
          path.isAbsolute(source) ||
          source.split("/").some((part) => !part || part === ".." || part === ".") ||
          /[\0\r\n]/u.test(source)
        )
          return false;
        sources.push(source);
      }
    }
    records.push({
      root: path.join(canonicalPrefix, "Caskroom", raw.token, raw.installed),
      sources,
      command
    });
  }
  // Bound argv size. Huge or unfamiliar inventories retain the manual route.
  if (records.length > 512) return false;
  if (records.length) {
    const artifacts = await run([
      "list",
      "--cask",
      "--",
      ...records.map((record) => record.command)
    ]);
    if (!clean(artifacts)) return false;
    const paths = output(artifacts).split(/\r?\n/u).filter(Boolean);
    if (paths.some((file) => !path.isAbsolute(file) || path.normalize(file) !== file)) return false;
    for (const record of records) {
      for (const source of record.sources) {
        const matches = paths.filter(
          (file) => file.startsWith(record.root + "/") && file.endsWith("/" + source)
        );
        if (matches.length !== 1 || !(await files.lstat(matches[0]!)).isSymbolicLink())
          return false;
        if ((await files.realpath(matches[0]!)) === canonicalHost) return false;
      }
    }
  }
  // Catch external inventory changes during the read, even outside our own lock.
  const after = versions(await run(["list", "--cask", "--versions"]));
  return Boolean(
    after &&
    after.size === installed.size &&
    [...installed].every(([token, value]) => after.get(token) === value)
  );
}

async function knownHomebrewScope(
  prefix: string | undefined,
  files: { lstat: (file: string) => Promise<unknown>; realpath: (file: string) => Promise<string> },
  environment: NodeJS.ProcessEnv
): Promise<boolean> {
  if (environment.HOMEBREW_PREFIX && environment.HOMEBREW_PREFIX !== prefix) return false;
  if (
    environment.HOMEBREW_CELLAR &&
    environment.HOMEBREW_CELLAR !== (prefix ? path.join(prefix, "Cellar") : undefined)
  )
    return false;
  const candidates = new Set([
    "/opt/homebrew/bin/brew",
    "/usr/local/bin/brew",
    ...(environment.PATH ?? "")
      .split(path.delimiter)
      .filter(path.isAbsolute)
      .map((dir) => path.join(dir, "brew"))
  ]);
  const expected = prefix ? await files.realpath(path.join(prefix, "bin/brew")) : undefined;
  for (const candidate of candidates) {
    try {
      await files.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return false;
    }
    try {
      if (!expected || (await files.realpath(candidate)) !== expected) return false;
    } catch {
      return false;
    }
  }
  for (const root of ["/opt/homebrew", "/usr/local"]) {
    if (root === prefix) continue;
    try {
      await files.lstat(path.join(root, "Caskroom"));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return true;
}
