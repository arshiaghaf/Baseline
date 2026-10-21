// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// @vitest-environment node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { captureProcessSample } from "../e2e/processSample";

test.skipIf(process.platform !== "darwin")(
  "samples a blocked owned Node child without terminating it",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-process-sample-"));
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.send('ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);"
      ],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"]
      }
    );
    try {
      await once(child, "message");
      const file = path.join(directory, "sample.txt");
      await captureProcessSample(child.pid!, file);
      const sample = await readFile(file, "utf8");
      expect(sample).toContain(`[${child.pid}]`);
      expect(sample).toContain("Call graph:");
      expect((await stat(file)).size).toBeLessThanOrEqual(256 * 1024);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
  }
);
