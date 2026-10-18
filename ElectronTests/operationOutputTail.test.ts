// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import { OperationOutputTail, operationTailBytes } from "../src/main/operationOutputTail";
import { runCommand } from "../src/main/commandRunner";
import { redactHomePaths } from "../src/main/redactHomePaths";

it("shares main-process home-path redaction with configuration diagnostics", () => {
  expect(redactHomePaths("/Users/fixture/config/brew.env")).toBe("~/config/brew.env");
  const tail = new OperationOutputTail();
  tail.write("stderr", Buffer.from("/Users/fixture/config/brew.env\n"));
  expect(tail.text()).toBe("~/config/brew.env");
});

const patterns = [
  "ghp_fixtureTOKEN",
  "gho_fixtureTOKEN",
  "github_pat_fixtureTOKEN",
  "ghs_fixtureTOKEN",
  "ghu_fixtureTOKEN",
  "ghr_fixtureTOKEN",
  'HOMEBREW_GITHUB_API_TOKEN="fixtureTOKEN"',
  "HOMEBREW_ARTIFACTORY_API_TOKEN=fixtureTOKEN",
  "HOMEBREW_DOCKER_API_TOKEN=fixtureTOKEN",
  "https://fixture:fixtureTOKEN@example.com/path",
  "ssh://fixture:fixtureTOKEN@example.com/path",
  "Authorization: Basic fixtureTOKEN",
  "Bearer fixtureTOKEN",
  "Bearer\tfixtureTOKEN",
  "/Users/fixtureTOKEN/cache"
];

describe("ephemeral support tail", () => {
  it.each(patterns)(
    "redacts synthetic %s across every byte boundary with interleaved pipes",
    (source) => {
      const bytes = Buffer.from(source + "\n");
      for (let split = 0; split <= bytes.length; split++) {
        const tail = new OperationOutputTail();
        tail.write("stdout", bytes.subarray(0, split));
        tail.write("stderr", Buffer.from("other pipe\n"));
        tail.write("stdout", bytes.subarray(split));
        tail.end("stdout");
        tail.end("stderr");
        expect(tail.text()).not.toContain("fixtureTOKEN");
        expect(tail.text()).toContain("other pipe");
      }
    }
  );

  it("strips chunked CSI, OSC, C1, terminal strings and embedded controls before redaction", () => {
    const tail = new OperationOutputTail();
    const source =
      "🧪 gh\x1b[31mp_\x1b]0;hidden\x07fixture\x00TOKEN\x1b[0m\n/Users/fixture/cache\n\x1bPprivate\x1b\\visible\n\u009dprivate\u009cend";
    for (const byte of Buffer.from(source)) tail.write("stdout", Buffer.from([byte]));
    tail.end("stdout");
    expect(tail.text()).toBe("🧪 [REDACTED]\n~/cache\nvisible\nend");
    expect(
      [...tail.text()!].some((char) => {
        const code = char.codePointAt(0)!;
        return code !== 10 && (code < 32 || (code >= 127 && code <= 159));
      })
    ).toBe(false);
  });

  it.each(["\x1b(B", "\x1b)0", "\x1b#8", "\x1b !0"])(
    "strips full ESC intermediate/final sequence %s before recognizing a token",
    (sequence) => {
      const tail = new OperationOutputTail();
      for (const byte of Buffer.from(`gh${sequence}p_fixtureTOKEN\n`))
        tail.write("stdout", Buffer.from([byte]));
      tail.end("stdout");
      expect(tail.text()).toBe("[REDACTED]");
    }
  );

  it("bounds raw fragments, drops uncertain or overflowing lines, and resumes at safe lines", () => {
    const tail = new OperationOutputTail();
    tail.write("stdout", Buffer.from("ghp_"));
    for (let i = 0; i < 100; i++) tail.write("stdout", Buffer.from("x".repeat(4096)));
    tail.write("stdout", Buffer.from("secretSuffix\nsafe\n"));
    tail.write("stderr", Buffer.from("uncertain\x1b]private"));
    tail.end("stdout");
    tail.end("stderr");
    expect(tail.text()).toBe("safe");
  });

  it("keeps the combined last twenty lines within a UTF-8 byte cap", () => {
    const tail = new OperationOutputTail();
    for (let i = 0; i < 40; i++)
      tail.write(i % 2 ? "stdout" : "stderr", Buffer.from(`${i} ${"🧪".repeat(100)}\n`));
    expect(tail.text()!.split("\n")).toHaveLength(20);
    expect(tail.text()!.startsWith("20 ")).toBe(true);
    expect(Buffer.byteLength(tail.text()!)).toBeLessThanOrEqual(operationTailBytes);
    tail.write("stdout", Buffer.from("🧪".repeat(3000) + "\n"));
    expect(tail.text()).toContain("[Long output line omitted]");
    expect(tail.text()).not.toContain("�");
  });

  it("sanitizes before tiny raw capture truncation while preserving the separate legacy stream", async () => {
    const output = "ghp_" + "x".repeat(1000) + "\n🧪 final\n";
    const lines: string[] = [];
    const result = await runCommand(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(output)}); process.exitCode=1`],
      (line) => lines.push(line),
      { capture: "tail", maxOutputBytes: 100, collectOutputTail: true }
    );
    expect(result.outputTruncated).toBe(true);
    expect(result.outputTail).toBe("[REDACTED]\n🧪 final");
    expect(lines[0]).toContain("ghp_");
    expect(result.output).toContain("xxx");
  });
});
