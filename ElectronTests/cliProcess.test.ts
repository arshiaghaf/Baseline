// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { packageCLI } from "../cliPackaging.config";
import { CLIService } from "../src/main/cliService";
import { startCLIServer } from "../src/main/cliServer";
import { cliEndpoint } from "../src/cli/endpoint";
import { defaultPersistedSnapshot, type BaselineSnapshot } from "../src/shared/domain";
import type { CLIOperation } from "../src/shared/cli";

let directory: string;
let cli: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "baseline-cli-process-"));
  await packageCLI(path.join(directory, "Contents/Resources/app"));
  cli = path.join(directory, "Contents/Resources/cli/cli.cjs");
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("keeps stdout valid JSON for non-TTY errors and local discovery", async () => {
  for (const args of [
    ["--version", "--json"],
    ["--json", "--version"],
    ["--help", "--json"]
  ]) {
    const result = await promisify(execFile)(process.execPath, [cli, ...args]);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, ok: true });
    expect(result.stderr).toBe("");
  }
  const result = await promisify(execFile)(process.execPath, [cli, "update", "--json"]).then(
    () => {
      throw new Error("Expected usage error");
    },
    (error: { code: number; stdout: string; stderr: string }) => error
  );
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exitCode: 2 });
  expect(result.stderr).toBe("");
});

it.each(["timeout", "SIGINT", "SIGTERM"] as const)(
  "stops a %s wait without resending or cancelling backend work",
  async (mode) => {
    const profile = path.join(directory, mode);
    const snapshot = {
      ...defaultPersistedSnapshot(),
      isRefreshing: false,
      defaultScanDirectories: []
    } as unknown as BaselineSnapshot;
    let release!: () => void;
    let entered!: () => void;
    let checks = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const service = new CLIService(
      {
        getSnapshot: () => structuredClone(snapshot),
        hasActiveUpdateOperation: () => false,
        refreshToolStatus: async () => undefined,
        refresh: async () => {
          checks++;
          entered();
          await gate;
          snapshot.lastRefreshDate = new Date().toISOString();
        },
        performHomebrewUpdate: async () => undefined,
        performCLIAppHandoff: async () => undefined
      },
      "1.0.0"
    );
    const close = await startCLIServer(profile, service);
    const child = spawn(process.execPath, [cli, "check", "--json", "--timeout", "1"], {
      env: { ...process.env, BASELINE_USER_DATA_DIR: profile },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = once(child, "close");
    try {
      await started;
      if (mode !== "timeout") child.kill(mode);
      const [code] = await exited;
      expect(code).toBe(mode === "timeout" ? 6 : mode === "SIGINT" ? 130 : 143);
      expect(stdout.trim().split("\n")).toHaveLength(1);
      const response = JSON.parse(stdout);
      const id = response.data.operationID as string;
      expect(stderr).toContain(`Operation: ${id}`);
      expect(checks).toBe(1);
      expect(
        await service.handle({ schemaVersion: 1, command: "operation", operationID: id })
      ).toMatchObject({ data: { operation: { state: "running" } } });
      release();
      for (let n = 0; n < 100; n++) {
        const result = await service.handle({
          schemaVersion: 1,
          command: "operation",
          operationID: id
        });
        if ((result.data as { operation: CLIOperation }).operation.finishedAt) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(
        await service.handle({ schemaVersion: 1, command: "operation", operationID: id })
      ).toMatchObject({ data: { operation: { state: "succeeded" } } });
    } finally {
      release();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await close();
      await rm(cliEndpoint(profile).directory, { recursive: true, force: true });
    }
  }
);
