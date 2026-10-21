// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { execFile } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { runWithCleanup } from "./applicationCleanup";

const execute = promisify(execFile);
const maximumSampleBytes = 256 * 1024;

// Only sample a child owned by the test. No shell, privilege change or GUI action.
// The diagnostic subprocess cannot extend the application's graceful deadline.
export async function captureProcessSample(pid: number, file: string): Promise<void> {
  await runWithCleanup(
    async () => {
      await execute("/usr/bin/sample", [String(pid), "1", "10", "-mayDie", "-file", file], {
        timeout: 4000,
        killSignal: "SIGKILL",
        maxBuffer: 4096
      });
    },
    async () => {
      let handle;
      try {
        handle = await open(file, "r");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      let bounded: Buffer;
      try {
        const buffer = Buffer.alloc(maximumSampleBytes);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        bounded = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      await writeFile(file, bounded);
    }
  );
}
