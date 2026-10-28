// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { _electron as electron, expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sendCLIRequest } from "../src/cli/client";
import { cliEndpoint } from "../src/cli/endpoint";
import { cleanupApplications } from "./applicationCleanup";

async function stopOwnedCLIBackend(executable: string): Promise<void> {
  const expected = await realpath(executable);
  const processList = (await promisify(execFile)("/bin/ps", ["-axo", "pid=,comm="])).stdout;
  const pids = processList.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    return match && match[2] === expected ? [Number(match[1])] : [];
  });
  for (const pid of pids) {
    const current = await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "comm="]).then(
      (result) => result.stdout.trim(),
      () => ""
    );
    if (current !== expected) continue;
    process.kill(pid, "SIGTERM");
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw error;
        }
      })
      .toBe(false);
  }
}

test("packaged CLI works with no user Node, no windows, concurrent GUI-backend reads and relocated bundles", async () => {
  const executable = process.env.BASELINE_E2E_EXECUTABLE;
  if (!executable) throw new Error("Use the isolated E2E setup.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-cli-e2e-"));
  const profile = path.join(directory, "profile");
  const sourceApp = path.resolve(executable, "../../..");
  const movedApp = path.join(directory, "Relocated Baseline.app");
  const movedExe = path.join(movedApp, "Contents/MacOS/Baseline");
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    // A real signed bundle in a different path, including spaces. It is never
    // installed in /Applications and only the isolated test providers can run.
    await cp(sourceApp, movedApp, { recursive: true, verbatimSymlinks: true });
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        PATH: "/usr/bin:/bin",
        BASELINE_USER_DATA_DIR: profile,
        BASELINE_SKIP_INITIAL_REFRESH: "1",
        BASELINE_E2E_PROFILE_SECRET: randomBytes(32).toString("base64url")
      }).filter(([, value]) => value !== undefined)
    ) as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const launcher = path.join(movedApp, "Contents/Resources/cli/bin/baseline");
    const alias = path.join(directory, "baseline alias");
    await symlink(launcher, alias);
    expect((await promisify(execFile)(alias, ["--version"], { env })).stdout.trim()).toMatch(
      /^\d+\.\d+\.\d+$/u
    );
    const help = await promisify(execFile)(alias, ["--help", "--json"], { env });
    expect(JSON.parse(help.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      data: { help: expect.stringContaining("--dry-run") }
    });
    expect(
      JSON.parse((await promisify(execFile)(alias, ["--version", "--json"], { env })).stdout)
    ).toMatchObject({ ok: true, data: { version: expect.any(String) } });
    // Playwright owns the child lifecycle while the CLI connects to this exact
    // single store. This avoids orphaning a detached app during fixture teardown.
    app = await electron.launch({
      executablePath: movedExe,
      args: ["--baseline-cli-background"],
      env
    });
    await expect
      .poll(async () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0);
    const run = (args: string[]) => promisify(execFile)(alias, args, { env, timeout: 20_000 });
    const mainErrors: string[] = [];
    app.process().stderr?.on("data", (chunk: Buffer) => mainErrors.push(chunk.toString()));
    await expect
      .poll(async () => {
        try {
          return await sendCLIRequest(profile, { schemaVersion: 1, command: "status" });
        } catch (error) {
          return {
            error: String(error),
            mainErrors,
            profile: await app!.evaluate(({ app }) => ({
              path: app.getPath("userData"),
              appPath: app.getAppPath(),
              ready: app.isReady(),
              locked: app.hasSingleInstanceLock(),
              argv: process.argv
            }))
          };
        }
      })
      .toMatchObject({ ok: true });
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        run(["status", "--json"]).catch(
          (error: { code: number; stdout: string; stderr: string; signal: string }) => {
            throw new Error(
              JSON.stringify({
                code: error.code,
                stdout: error.stdout,
                stderr: error.stderr,
                signal: error.signal,
                mainErrors
              })
            );
          }
        )
      )
    );
    const parsed = responses.map((response) => JSON.parse(response.stdout));
    expect(parsed.every((response) => response.schemaVersion === 1 && response.ok)).toBe(true);
    expect(new Set(parsed.map((response) => response.sessionID)).size).toBe(1);
    const list = JSON.parse((await run(["list", "--json"])).stdout);
    expect(list).toMatchObject({ ok: true, data: { targets: [], checkedThisSession: false } });
    const doctor = JSON.parse((await run(["doctor", "--json"])).stdout);
    expect(doctor.data.capabilities.directUpdates).toEqual(["homebrew"]);
    const bad = await run(["inspect", "missing", "--json"]).then(
      () => {
        throw new Error("Expected failure");
      },
      (error: { code: number; stdout: string }) => error
    );
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, error: { code: "unknown-target" } });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(profile);
    await cleanupApplications([app], async (owned) => {
      await owned
        .evaluate(({ app }) => {
          app.quit();
        })
        .catch(() => undefined);
    });
    app = undefined;
    // Exercise cold start, including a leftover stale socket. The unique
    // relocated executable identifies every detached test process for cleanup.
    const cold = JSON.parse((await run(["status", "--json"])).stdout);
    expect(cold).toMatchObject({
      ok: true,
      data: { checkedThisSession: false, refreshing: false, backendPID: expect.any(Number) }
    });
    expect(cold.sessionID).not.toBe(parsed[0].sessionID);
    expect(JSON.parse((await run(["list", "--json"])).stdout)).toMatchObject({
      sessionID: cold.sessionID,
      data: { targets: [] }
    });
  } finally {
    if (app)
      await cleanupApplications([app], async (owned) => {
        await owned
          .evaluate(({ app }) => {
            app.quit();
          })
          .catch(() => undefined);
      });
    await stopOwnedCLIBackend(movedExe);
    await rm(cliEndpoint(profile).directory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
