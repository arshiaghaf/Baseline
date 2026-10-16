// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

// Disposable catalogue data only. Payload and HTTP metadata are one atomic record.
export interface CatalogueStorage {
  load(maxBytes: number): Promise<Buffer | undefined>;
  save(record: Buffer): Promise<void>;
  clear(): Promise<void>;
}

export class FileCatalogueStorage implements CatalogueStorage {
  private readonly file: string;

  constructor(
    private readonly root: string,
    kind: "formula" | "cask"
  ) {
    this.file = path.join(root, `${kind}-catalogue-v1.cache`);
  }

  async load(maxBytes: number): Promise<Buffer | undefined> {
    const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    );
    if (!handle) return undefined;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error("Invalid catalogue cache size");
      const chunks: Buffer[] = [];
      let size = 0;
      // Bound actual reads too: the file may grow after stat().
      while (true) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - size + 1));
        const { bytesRead } = await handle.read(chunk);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > maxBytes) throw new Error("Catalogue cache too large");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, size);
    } finally {
      await handle.close();
    }
  }

  async save(record: Buffer): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(record);
      await handle.sync();
      await handle.close();
      await rename(temporary, this.file);
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async clear(): Promise<void> {
    await unlink(this.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
