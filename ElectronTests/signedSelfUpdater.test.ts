// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignedSelfUpdater } from "../src/main/signedSelfUpdater";
import { releaseSelfUpdateConfiguration, selfUpdateInfo } from "../selfUpdatePackaging.config";
import { signedSelfUpdateConfiguration, signedUpdateFeedURL } from "../src/shared/signedSelfUpdate";
import { SelfUpdateScheduler } from "../src/main/selfUpdateScheduler";

// Existing public documentation key, used only as public parsing fixture data.
// No publisher or fixture private key is generated or used in these tests.
const publicKey = "pfIShU4dEXqPd5ObYNfDBiQWcXozk7estwzTnF9BamQ=";
const configuration = { enabled: true, publicKey, feedURL: signedUpdateFeedURL };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("signed update configuration", () => {
  it("pins the approved publisher and refuses missing keys in enabled builds", () => {
    expect(releaseSelfUpdateConfiguration({})?.publicKey).toBe(
      "rNuQOC7meq9/i04UNpK1sO+mJinvTPuMmMdp6pZg80E="
    );
    expect(releaseSelfUpdateConfiguration({ BASELINE_ENABLE_SIGNED_UPDATES: "0" })).toBeUndefined();
    vi.stubEnv("BASELINE_ENABLE_SIGNED_UPDATES", "0");
    expect(selfUpdateInfo(undefined)).toEqual({});
    expect(() =>
      releaseSelfUpdateConfiguration({
        BASELINE_ENABLE_SIGNED_UPDATES: "1",
        BASELINE_SELF_UPDATE_PUBLIC_KEY: ""
      })
    ).toThrow(/approved/);
  });
  it.each([
    null,
    {},
    { ...configuration, publicKey: "" },
    { ...configuration, publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    { ...configuration, publicKey: "x".repeat(43) + "=" },
    { ...configuration, enabled: false },
    { ...configuration, feedURL: "http://example.com/appcast.xml" },
    { ...configuration, feedURL: "https://example.com/appcast.xml" }
  ])("rejects incomplete or unapproved configuration %j", (input) => {
    expect(signedSelfUpdateConfiguration(input)).toBeUndefined();
  });
  it("requires archive and feed authentication without automatic installation", () => {
    const parsed = signedSelfUpdateConfiguration(configuration);
    expect(parsed).toEqual(configuration);
    expect(selfUpdateInfo(parsed)).toMatchObject({
      SUPublicEDKey: publicKey,
      SUVerifyUpdateBeforeExtraction: true,
      SURequireSignedFeed: true,
      SUSignedFeedFailureExpirationInterval: 0,
      SUAutomaticallyUpdate: false,
      SUAllowsAutomaticUpdates: false
    });
  });
});

function fixture(available = true) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.emit("close", 1);
    return true;
  });
  const spawn = vi.fn(() => child);
  const updater = new SignedSelfUpdater(
    {
      bundlePath: "/Applications/Baseline.app",
      resourcesPath: "/fixture/resources",
      home: "/fixture/home",
      packaged: true,
      isolatedProfile: false
    },
    { available: vi.fn(async () => available), spawn }
  );
  const command: string[] = [];
  child.stdin.on("data", (data) => {
    command.push(String(data));
    if (String(data) === "cancel\n") queueMicrotask(() => child.emit("close", 0));
  });
  const event = (value: string) =>
    child.stdout.emit("data", Buffer.from(JSON.stringify({ event: value }) + "\n"));
  return { updater, spawn, child, event, command };
}

describe("upstream updater lifecycle", () => {
  it("never starts the helper without eligible configuration and install location", async () => {
    const f = fixture(false);
    await expect(f.updater.check(vi.fn(), vi.fn())).rejects.toThrow(/unavailable/);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("coalesces checks and grants installation only after the durable quit barrier", async () => {
    const f = fixture();
    let save!: (ready: boolean) => void;
    const prepare = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          save = done;
        })
    );
    const quit = vi.fn();
    const first = f.updater.check(prepare, quit);
    const second = f.updater.check(prepare, quit);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    f.event("checking");
    f.event("restart-request");
    expect(prepare).toHaveBeenCalledOnce();
    expect(f.command).toEqual([]);
    expect(quit).not.toHaveBeenCalled();
    save(true);
    await vi.waitFor(() => expect(f.command).toEqual(["install\n"]));
    expect(quit).not.toHaveBeenCalled();
    f.event("installing");
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(f.command).toEqual(["install\n"]);
    expect(f.spawn).toHaveBeenCalledWith(
      "/Applications/Baseline.app/Contents/Helpers/Baseline Updater.app/Contents/MacOS/Baseline Updater",
      ["--check"]
    );
    f.child.emit("close", 0);
    await first;
  });
  it.each([false, "save failed"])(
    "refuses installation when preparation returns %s",
    async (result) => {
      const f = fixture();
      const prepare = vi.fn(async () => {
        if (typeof result === "string") throw new Error(result);
        return result;
      });
      const quit = vi.fn();
      const task = f.updater.check(prepare, quit);
      const observed = expect(task).rejects.toThrow(/active operations/);
      await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
      f.event("checking");
      f.event("restart-request");
      await observed;
      expect(f.command).toEqual(["cancel\n"]);
      expect(quit).not.toHaveBeenCalled();
    }
  );
  it("handles update cancellation or no new version without requesting a quit", async () => {
    const f = fixture();
    const prepare = vi.fn();
    const task = f.updater.check(prepare, vi.fn());
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    f.event("checking");
    f.event("finished");
    f.child.emit("close", 0);
    await task;
    expect(prepare).not.toHaveBeenCalled();
    expect(f.command).toEqual([]);
  });
  it("rejects malformed helper output and permits retry", async () => {
    const f = fixture();
    const task = f.updater.check(vi.fn(), vi.fn());
    const observed = expect(task).rejects.toThrow(/invalid response/);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    f.child.stdout.emit("data", Buffer.from("not json\n"));
    await observed;
    expect(f.child.kill).toHaveBeenCalledOnce();
    expect(f.command).toEqual([]);
  });
  it("finishes a prepared quit safely if the helper exits during the save", async () => {
    const f = fixture();
    let finish!: (ready: boolean) => void;
    const prepare = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          finish = done;
        })
    );
    const quit = vi.fn();
    const task = f.updater.check(prepare, quit);
    const observed = expect(task).rejects.toThrow(/did not complete/);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    f.event("checking");
    f.event("restart-request");
    f.child.emit("close", 1);
    finish(true);
    await observed;
    expect(quit).toHaveBeenCalledOnce();
    expect(f.command).toEqual([]);
  });

  it("refuses excessive helper output before any install handshake", async () => {
    const f = fixture();
    const prepare = vi.fn();
    const task = f.updater.check(prepare, vi.fn());
    const observed = expect(task).rejects.toThrow(/invalid response/);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    f.child.stdout.emit("data", Buffer.from("x".repeat(8193)));
    await observed;
    expect(prepare).not.toHaveBeenCalled();
    expect(f.command).toEqual([]);
  });

  it("bounds startup waits without admitting an installation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const task = f.updater.check(vi.fn(), vi.fn());
    const observed = expect(task).rejects.toThrow(/did not start/);
    await vi.advanceTimersByTimeAsync(10001);
    await observed;
    expect(f.command).toEqual([]);
  });

  it("retains the manual route until a failed helper's exit is confirmed", async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.child.kill).mockImplementation(() => true);
    const task = f.updater.check(vi.fn(), vi.fn());
    const observed = expect(task).rejects.toThrow(/could not be confirmed stopped/);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.spawn).toHaveBeenCalledOnce();
    f.event("failed");
    await vi.advanceTimersByTimeAsync(5001);
    await observed;
    await expect(f.updater.available()).resolves.toBe(false);
    await expect(f.updater.check(vi.fn(), vi.fn())).rejects.toThrow(/unavailable/);
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.command).toEqual([]);
    f.child.emit("close", 1);
    await expect(f.updater.available()).resolves.toBe(true);
  });
});

it("checks on startup, wake/focus and its own schedule, then stops on quit", async () => {
  vi.useFakeTimers();
  let now = 0;
  const check = vi.fn(async () => undefined);
  const scheduler = new SelfUpdateScheduler(check, () => now);
  scheduler.start();
  scheduler.start();
  scheduler.request();
  expect(check).toHaveBeenCalledTimes(1);
  now = 5 * 60 * 1000;
  scheduler.request();
  expect(check).toHaveBeenCalledTimes(2);
  scheduler.request(true);
  expect(check).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(check).toHaveBeenCalledTimes(4);
  scheduler.dispose();
  scheduler.request(true);
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(check).toHaveBeenCalledTimes(4);
});
