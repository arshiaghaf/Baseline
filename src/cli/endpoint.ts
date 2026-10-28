// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function cliUserData(): string {
  return (
    process.env.BASELINE_USER_DATA_DIR ??
    path.join(os.homedir(), "Library", "Application Support", "baseline")
  );
}

export function cliEndpoint(userData: string): { directory: string; socket: string } {
  const digest = createHash("sha256").update(path.resolve(userData)).digest("hex").slice(0, 20);
  // A short path avoids macOS's 104-byte Unix socket path limit, even with long
  // user-data locations. No TCP port, network binding or persistent credential.
  const directory = `/tmp/baseline-cli-${process.getuid!()}-${digest}`;
  return { directory, socket: path.join(directory, "ipc") };
}

export async function verifyCLIEndpointDirectory(directory: string, create = false): Promise<void> {
  if (create)
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  const entry = await lstat(directory);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    entry.uid !== process.getuid!() ||
    (entry.mode & 0o777) !== 0o700
  )
    throw new Error("The local CLI directory is not private and owned by this user.");
}
