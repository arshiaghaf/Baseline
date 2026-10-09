// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export type IconLoadResult = { dataURL?: string };

export class IconCache {
  private readonly entries = new Map<
    string,
    {
      fingerprint: string;
      result: IconLoadResult;
      expiresAt: number;
      bytes: number;
    }
  >();
  private readonly tasks = new Map<string, Promise<IconLoadResult>>();
  private bytes = 0;

  constructor(
    private readonly load: (iconPath: string) => Promise<IconLoadResult>,
    private readonly maxEntries = 512,
    private readonly maxBytes = 16 * 1024 * 1024
  ) {}

  async get(iconPath: string): Promise<IconLoadResult> {
    try {
      const canonicalPath = await realpath(iconPath);
      const info = await stat(canonicalPath);
      if (!info.isFile()) return {};
      // Generic Electron icons have a separate padding policy, even if a
      // symlink makes them share a file with an otherwise unpadded icon.
      const key = `${canonicalPath}:${path.basename(iconPath).toLowerCase() === "electron.icns"}`;
      const fingerprint = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
      const cached = this.entries.get(key);
      if (cached?.fingerprint === fingerprint && Date.now() < cached.expiresAt) {
        this.entries.delete(key);
        this.entries.set(key, cached);
        return cached.result;
      }
      const taskKey = `${key}:${fingerprint}`;
      const pending = this.tasks.get(taskKey);
      if (pending) return pending;
      const task = this.load(iconPath);
      if (this.tasks.size < this.maxEntries) this.tasks.set(taskKey, task);
      try {
        const result = await task;
        const bytes = (result.dataURL?.length ?? 0) * 2;
        const previous = this.entries.get(key);
        if (previous) {
          this.bytes -= previous.bytes;
          this.entries.delete(key);
        }
        if (bytes <= this.maxBytes) {
          this.entries.set(key, {
            fingerprint,
            result,
            bytes,
            expiresAt: result.dataURL ? Infinity : Date.now() + 30_000
          });
          this.bytes += bytes;
          while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
            const oldest = this.entries.keys().next().value!;
            this.bytes -= this.entries.get(oldest)!.bytes;
            this.entries.delete(oldest);
          }
        }
        return result;
      } finally {
        if (this.tasks.get(taskKey) === task) this.tasks.delete(taskKey);
      }
    } catch {
      // Missing files and thrown conversion failures are retried next scan.
      return {};
    }
  }
}
