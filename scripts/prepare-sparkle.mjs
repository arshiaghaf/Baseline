// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
/* global fetch, AbortSignal, console */

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstream = JSON.parse(
  await readFile(path.join(root, "native/self-updater/upstream.json"), "utf8")
);
const cache = path.join(root, "node_modules/.cache/baseline-sparkle", upstream.version);
await mkdir(cache, { recursive: true });
const archive = path.join(cache, "Sparkle.tar.xz");
let bytes;
try {
  bytes = await readFile(archive);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const response = await fetch(upstream.url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok)
    throw new Error(`Sparkle download failed (${response.status}).`, { cause: error });
  if (!response.body || Number(response.headers.get("content-length")) > 32 * 1024 * 1024)
    throw new Error("Sparkle archive exceeds the download limit.", { cause: error });
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 32 * 1024 * 1024)
        throw new Error("Sparkle archive exceeds the download limit.", { cause: error });
      chunks.push(Buffer.from(value));
    }
    bytes = Buffer.concat(chunks, length);
  } finally {
    await reader.cancel();
  }
}
if (createHash("sha256").update(bytes).digest("hex") !== upstream.sha256) {
  throw new Error("Sparkle archive checksum does not match the pinned upstream release.");
}
await writeFile(archive, bytes);
// Extract only authenticated upstream contents; never modify or patch the framework.
const extracted = path.join(cache, "upstream");
await rm(extracted, { recursive: true, force: true });
await mkdir(extracted);
execFileSync("/usr/bin/tar", ["-xJf", "-", "-C", extracted], {
  input: bytes,
  stdio: ["pipe", "inherit", "inherit"]
});
console.log(`Prepared verified upstream Sparkle ${upstream.version} at ${extracted}`);
