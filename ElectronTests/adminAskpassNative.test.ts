// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAdminAskpass } from "../adminAskpass.config";
import { AskpassFrameReader, encodeAskpassFrame } from "../src/main/adminAskpassProtocol";

describe.skipIf(process.platform !== "darwin")(
  "native admin helper without a dialog or real sudo",
  () => {
    let directory: string;
    let fixture: string;
    let sink: string;
    beforeAll(async () => {
      directory = await mkdtemp("/tmp/baseline askpass ");
      fixture = path.join(directory, "fixture helper");
      sink = path.join(directory, "native sink");
      execFileSync("/usr/bin/xcrun", [
        "clang",
        "-fobjc-arc",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-framework",
        "Foundation",
        "native/admin-askpass/main.m",
        "ElectronTests/Fixtures/adminAskpassDialog.m",
        "-o",
        fixture
      ]);
      execFileSync("/usr/bin/xcrun", [
        "clang",
        "-Wall",
        "-Wextra",
        "-Werror",
        "ElectronTests/Fixtures/adminAskpassSink.c",
        "-o",
        sink
      ]);
    }, 30_000);
    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it.each(["arm64", "x64"])(
      "builds executable %s resources with spaces in their paths",
      async (arch) => {
        const output = path.join(directory, arch, "Contents/Resources/admin-askpass");
        await buildAdminAskpass(output, arch);
        expect((await stat(output)).mode & 0o111).toBe(0o111);
        expect(execFileSync("/usr/bin/lipo", ["-archs", output], { encoding: "utf8" }).trim()).toBe(
          arch === "x64" ? "x86_64" : arch
        );
        // Refusal before opening AppKit: no metadata means no dialog or output.
        if (arch === process.arch) {
          const child = spawn(output, [], { env: {}, stdio: "ignore" });
          expect(await new Promise((resolve) => child.once("close", resolve))).toBe(70);
        }
      },
      30_000
    );

    it.each([
      ["answer", [1, 2, 3, 6], 0],
      ["empty", [1, 2, 3, 6], 0],
      ["cancel", [1, 2, 4, 6], 1],
      ["error", [1, 2, 5, 6], 70],
      ["delivery-error", [1, 2, 3, 7], 70],
      ["peer-loss", [1, 2], 70]
    ] as const)(
      "completes %s through a native-only answer pipe",
      async (scenario, expected, exit) => {
        const endpoint = path.join(directory, "status.sock");
        const seen: number[] = [];
        const peers = new Set<Socket>();
        const server = createServer((peer) => {
          peers.add(peer);
          peer.on("close", () => peers.delete(peer));
          peer.on("error", () => undefined);
          const reader = new AskpassFrameReader();
          peer.on("data", (chunk: Buffer) => {
            for (const frame of reader.write(chunk)) {
              seen.push(frame.type);
              peer.write(encodeAskpassFrame({ ...frame, type: frame.type | 128 }), () => {
                if (scenario === "peer-loss" && frame.type === 2) peer.destroy();
              });
            }
          });
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(endpoint, resolve);
        });
        // Shell only joins the two native descriptors. It never reads an answer
        // into a variable, and Node observes only process status and fixed frames.
        const child = spawn(
          "/bin/bash",
          ["-c", 'set -o pipefail; "$1" | "$2"', "fixture", fixture, sink],
          {
            env: {
              HOMEBREW_BASELINE_ASKPASS_SOCKET: endpoint,
              HOMEBREW_BASELINE_ASKPASS_OPERATION: "1".repeat(32),
              HOMEBREW_BASELINE_FIXTURE_CASE: scenario
            },
            stdio: ["ignore", "pipe", "pipe"],
            detached: true
          }
        );
        const output: Buffer[] = [];
        child.stdout.on("data", (bytes: Buffer) => output.push(bytes));
        child.stderr.on("data", (bytes: Buffer) => output.push(bytes));
        const closed = new Promise((resolve) => child.once("close", resolve));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Native fixture did not exit.")), 5000);
          });
          expect(await Promise.race([closed, deadline])).toBe(exit);
          expect(seen).toEqual(expected);
          expect(Buffer.concat(output)).toHaveLength(0);
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) process.kill(-child.pid!, "SIGKILL");
          await closed;
          for (const peer of peers) peer.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rm(endpoint, { force: true });
        }
      },
      10_000
    );
  }
);
