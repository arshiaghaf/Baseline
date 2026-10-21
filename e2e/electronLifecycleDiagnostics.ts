// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { ElectronApplication, Page, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { observeApplicationCleanup } from "./applicationCleanup";

const recordings = new WeakMap<TestInfo, Array<() => Promise<void>>>();
const lifecycleLogs = new WeakMap<object, LifecycleLog>();
const maximumEvents = 96;
const maximumTailCharacters = 16_384;

export class LifecycleLog {
  private readonly started = performance.now();
  private readonly events: Array<{ elapsedMs: number; phase: string; detail?: unknown }> = [];
  private stdout = "";
  private stderr = "";
  private droppedEvents = 0;

  constructor(private readonly secret: string | undefined) {}

  private redact(value: string): string {
    return this.secret ? value.replaceAll(this.secret, "[redacted]") : value;
  }

  event(phase: string, detail?: unknown): void {
    if (this.events.length === maximumEvents) {
      this.events.shift();
      this.droppedEvents++;
    }
    this.events.push({ elapsedMs: Math.round(performance.now() - this.started), phase, detail });
  }

  output(stream: "stdout" | "stderr", chunk: string): void {
    this[stream] = this.redact(this[stream] + chunk).slice(-maximumTailCharacters);
  }

  snapshot(): string {
    return this.redact(
      JSON.stringify(
        {
          droppedEvents: this.droppedEvents,
          events: this.events,
          stdout: this.stdout,
          stderr: this.stderr
        },
        null,
        2
      )
    );
  }
}

// Playwright's internal close handler swallows app.quit() evaluation errors.
// Dispatch quit outside the inspector evaluation stack, then wait for the
// owned app to close before Playwright starts its own close handler. The caller
// includes both phases in cleanupApplications' existing deadline.
export async function requestElectronQuit(
  application: Pick<ElectronApplication, "evaluate"> & {
    waitForEvent(event: "close"): Promise<unknown>;
  }
): Promise<void> {
  const log = lifecycleLogs.get(application);
  log?.event("quit-request-start");
  const closed = application.waitForEvent("close");
  try {
    await application.evaluate(({ app }) => {
      setImmediate(() => {
        process.stderr.write(`E2E quit callback entered ${Date.now()}\n`);
        app.quit();
        process.stderr.write(`E2E quit call returned ${Date.now()}\n`);
      });
    });
    log?.event("quit-request-dispatched");
  } catch (error) {
    if (
      error instanceof Error &&
      /Execution context was destroyed|Target page, context or browser has been closed/u.test(
        error.message
      )
    ) {
      log?.event("quit-request-disconnected", error.message.slice(-2000));
    } else {
      log?.event("quit-request-failed", String(error).slice(-2000));
      throw error;
    }
  }
  await closed;
  log?.event("quit-request-complete");
}

export function recordElectronLaunch(testInfo: TestInfo, executable: string): void {
  // This line also survives failures before electron.launch() returns a child.
  console.log(`Electron launch requested: ${executable}`);
  console.log(`Electron test: ${testInfo.title}`);
}

export function trackElectronLifecycle(
  application: ElectronApplication,
  testInfo: TestInfo,
  secret: string
): void {
  const child = application.process();
  const log = new LifecycleLog(secret);
  lifecycleLogs.set(application, log);
  log.event("launch-resolved", { pid: child.pid, executable: child.spawnfile });
  const onStdout = (chunk: Buffer | string) => log.output("stdout", chunk.toString());
  const onStderr = (chunk: Buffer | string) => log.output("stderr", chunk.toString());
  const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
    log.event("child-exit", { code, signal });
  const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
    log.event("child-close", { code, signal });
  const onError = (error: Error) => log.event("child-error", error.message.slice(-2000));
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.on("exit", onExit);
  child.on("close", onClose);
  child.on("error", onError);
  const stopObservingCleanup = observeApplicationCleanup(application, (event) =>
    log.event(event.phase, event)
  );
  const pages = new Map<Page, () => void>();
  const onWindow = (page: Page) => {
    if (pages.has(page)) return;
    log.event("window-observed");
    const loaded = () => log.event("window-loaded");
    const crashed = () => log.event("renderer-crashed");
    const closed = () => log.event("window-closed");
    page.on("load", loaded);
    page.on("crash", crashed);
    page.on("close", closed);
    pages.set(page, () => {
      page.off("load", loaded);
      page.off("crash", crashed);
      page.off("close", closed);
    });
  };
  application.windows().forEach(onWindow);
  application.on("window", onWindow);
  const onApplicationClose = () => log.event("application-close");
  application.on("close", onApplicationClose);
  // Listener installation is best effort and does not delay the test or quit.
  // Native event messages enter the bounded stderr tail, not production code.
  void application
    .evaluate(({ app, BrowserWindow }) => {
      const record = (event: string) => {
        process.stderr.write(
          `E2E lifecycle ${JSON.stringify({ event, windows: BrowserWindow.getAllWindows().length })}\n`
        );
      };
      // The focused comparison omits this timer to check whether it changes
      // the shutdown race. It never keeps the app alive when enabled.
      if (process.env.BASELINE_E2E_HEARTBEAT !== "0") {
        const heartbeat = setInterval(() => {
          process.stderr.write(`E2E main heartbeat ${Date.now()}\n`);
        }, 500);
        heartbeat.unref();
      }
      app.on("before-quit", () => record("before-quit"));
      app.on("will-quit", () => record("will-quit"));
    })
    .then(() => log.event("native-listeners-installed"))
    .catch((error: unknown) =>
      log.event("native-listeners-unavailable", String(error).slice(-2000))
    );

  const flush = async () => {
    log.event("diagnostics-finalized", {
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      windows: application.windows().length
    });
    stopObservingCleanup();
    lifecycleLogs.delete(application);
    child.stdout?.off("data", onStdout);
    child.stderr?.off("data", onStderr);
    child.off("exit", onExit);
    child.off("close", onClose);
    child.off("error", onError);
    application.off("window", onWindow);
    application.off("close", onApplicationClose);
    pages.forEach((dispose) => dispose());
    const file = testInfo.outputPath(`electron-lifecycle-${child.pid}.json`);
    await writeFile(file, log.snapshot());
    await testInfo.attach("Electron lifecycle", { path: file, contentType: "application/json" });
  };
  const pending = recordings.get(testInfo) ?? [];
  pending.push(flush);
  recordings.set(testInfo, pending);
}

export async function attachElectronDiagnostics(testInfo: TestInfo): Promise<void> {
  const pending = recordings.get(testInfo) ?? [];
  recordings.delete(testInfo);
  // Preserve diagnostics from every owned app if one attachment write fails.
  const results = await Promise.allSettled(pending.map((flush) => flush()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length)
    throw new AggregateError(errors, "Electron diagnostics could not be attached.");
}
