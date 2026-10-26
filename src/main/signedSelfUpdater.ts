// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { signedSelfUpdateConfiguration } from "../shared/signedSelfUpdate";

type UpdaterOptions = {
  bundlePath: string;
  resourcesPath: string;
  home: string;
  packaged: boolean;
  isolatedProfile: boolean;
  platform?: string;
  architecture?: string;
  environment?: NodeJS.ProcessEnv;
};

/** Missing, damaged or unapproved configuration always leaves the manual route available. */
export async function signedUpdaterIsAvailable(options: UpdaterOptions): Promise<boolean> {
  if (
    !options.packaged ||
    options.isolatedProfile ||
    (options.platform ?? process.platform) !== "darwin" ||
    (options.architecture ?? process.arch) !== "arm64"
  )
    return false;
  try {
    const configuration = signedSelfUpdateConfiguration(
      JSON.parse(await readFile(path.join(options.resourcesPath, "self-update.json"), "utf8"))
    );
    if (!configuration) return false;
    const canonical = await realpath(options.bundlePath);
    if (
      canonical !== options.bundlePath ||
      ![
        "/Applications/Baseline.app",
        path.join(options.home, "Applications/Baseline.app")
      ].includes(canonical)
    )
      return false;
    // Until receipt-backed provenance is available, do not replace installations
    // on Macs with a detectable package manager, including ambiguous manual copies.
    const environment = options.environment ?? process.env;
    if (environment.HOMEBREW_PREFIX || environment.HOMEBREW_CELLAR) return false;
    const candidates = new Set([
      "/opt/homebrew/bin/brew",
      "/usr/local/bin/brew",
      "/opt/homebrew/Caskroom",
      "/usr/local/Caskroom",
      ...(environment.PATH ?? "")
        .split(path.delimiter)
        .filter(path.isAbsolute)
        .map((directory) => path.join(directory, "brew"))
    ]);
    for (const candidate of candidates) if (!(await definitelyAbsent(candidate))) return false;
    return true;
  } catch {
    return false;
  }
}

async function definitelyAbsent(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    let parent = path.dirname(candidate);
    for (;;) {
      try {
        const entry = await lstat(parent);
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
        await access(parent, constants.R_OK | constants.X_OK);
        return true;
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") return false;
        const next = path.dirname(parent);
        if (next === parent) return false;
        parent = next;
      }
    }
  }
}

/** Sparkle owns all download verification, staging, replacement and relaunch. */
export class SignedSelfUpdater {
  private task?: Promise<void>;
  private child?: ChildProcessWithoutNullStreams;
  private authorized = false;
  private cleanupUnconfirmed = false;

  constructor(
    private readonly options: UpdaterOptions,
    private readonly dependencies = {
      available: signedUpdaterIsAvailable,
      spawn: (file: string, args: string[]) => spawn(file, args, { stdio: "pipe" })
    }
  ) {}

  available(): Promise<boolean> {
    return this.cleanupUnconfirmed
      ? Promise.resolve(false)
      : this.dependencies.available(this.options);
  }

  check(prepareToQuit: () => Promise<boolean>, quit: () => void): Promise<void> {
    if (this.task) return this.task;
    const task = this.run(prepareToQuit, quit);
    this.task = task;
    void task
      .finally(() => {
        if (this.task === task) this.task = undefined;
      })
      .catch(() => undefined);
    return task;
  }

  dispose(): void {
    if (!this.authorized) this.child?.stdin.end();
  }

  private async run(prepareToQuit: () => Promise<boolean>, quit: () => void): Promise<void> {
    if (!(await this.available()))
      throw new Error("In-app updating is unavailable for this installation.");
    const executable = path.join(
      this.options.bundlePath,
      "Contents/Helpers/Baseline Updater.app/Contents/MacOS/Baseline Updater"
    );
    const child = this.dependencies.spawn(executable, ["--check"]);
    this.child = child;
    this.authorized = false;
    let restartTask: Promise<void> | undefined;
    let acknowledgeInstallation: (() => void) | undefined;
    let exited = false;
    try {
      await new Promise<void>((resolve, reject) => {
        let buffer = "";
        let total = 0;
        let stderrBytes = 0;
        let finished = false;
        let failed = false;
        let closed = false;
        let settled = false;
        let failureMessage: string | undefined;
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        const startup = setTimeout(
          () => fail("The updater did not start. Try again or download the release manually."),
          10000
        );
        const fail = (message: string, cancelInstallation = false) => {
          if (settled || failed) return;
          clearTimeout(startup);
          failed = true;
          failureMessage = message;
          cleanupTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            this.cleanupUnconfirmed = true;
            child.kill();
            reject(
              new Error(
                "The updater could not be confirmed stopped. Reopen Baseline before trying in-app updating again."
              )
            );
          }, 5000);
          if (cancelInstallation) child.stdin.write("cancel\n");
          child.stdin.end();
          if (!cancelInstallation) child.kill();
        };
        child.on("error", () => fail("The updater could not be started."));
        child.stdin.on("error", () => {
          /* Exit/error below determines the outcome. */
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes > 8192) fail("The updater stopped unexpectedly.");
        });
        child.stdout.on("data", (chunk: Buffer) => {
          if (failed || settled) return;
          total += chunk.length;
          buffer += chunk.toString("utf8");
          if (total > 8192 || buffer.length > 1024) {
            fail("The updater returned an invalid response.");
            return;
          }
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            let event: unknown;
            try {
              event = JSON.parse(line)?.event;
            } catch {
              fail("The updater returned an invalid response.");
              return;
            }
            if (event === "checking") clearTimeout(startup);
            else if (event === "finished") finished = true;
            else if (event === "installing" && this.authorized) acknowledgeInstallation?.();
            else if (event === "restart-request" && !restartTask) {
              restartTask = (async () => {
                let ready = false;
                try {
                  ready = await prepareToQuit();
                } catch {
                  /* Persistence restored admission. */
                }
                if (!ready) {
                  fail(
                    "Finish active operations and save Baseline before trying the update again.",
                    true
                  );
                  return;
                }
                // prepareToQuit has fenced producers and durably saved. Once prepared,
                // finish quitting even if the helper died; never leave a disposed store running.
                try {
                  if (!closed && !failed) {
                    this.authorized = true;
                    await new Promise<void>((done) => {
                      const deadline = setTimeout(done, 5000);
                      acknowledgeInstallation = () => {
                        clearTimeout(deadline);
                        acknowledgeInstallation = undefined;
                        done();
                      };
                      child.stdin.write("install\n");
                    });
                  }
                } finally {
                  quit();
                }
              })();
            } else {
              fail(
                "The update could not be completed. Download the release manually or try again."
              );
              return;
            }
          }
        });
        child.on("close", (code) => {
          exited = true;
          closed = true;
          acknowledgeInstallation?.();
          this.cleanupUnconfirmed = false;
          clearTimeout(startup);
          if (cleanupTimer) clearTimeout(cleanupTimer);
          if (this.child === child) this.child = undefined;
          if (settled) return;
          settled = true;
          if (!failed && code === 0 && (finished || this.authorized)) resolve();
          else
            reject(
              new Error(
                failureMessage ??
                  "The update did not complete. Try again or download the release manually."
              )
            );
        });
      });
    } finally {
      if (restartTask) await restartTask;
      if (exited && this.child === child) this.child = undefined;
    }
  }
}
