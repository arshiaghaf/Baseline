// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runCommand, type CommandOptions } from "../src/main/commandRunner";
import { CommandOutputStream } from "../src/main/commandOutput";
import {
  homebrewEnvironment,
  homebrewReadCommand,
  commandCompleteCaptureBytes,
  commandTailCaptureBytes
} from "../src/main/commandEnvironment";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "baseline-runner-"));
  directories.push(dir);
  const file = join(dir, "fixture.cjs");
  await writeFile(file, source);
  return { dir, file };
}

async function node(source: string, options: CommandOptions = {}, onLine?: (line: string) => void) {
  const { file } = await fixture(source);
  return runCommand(process.execPath, [file], onLine, options);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await delay(20);
    }
  }
  throw new Error("Fixture never signalled readiness");
}

describe("command output", () => {
  it("decodes every UTF-8 split, CR/LF and trailing output exactly once", () => {
    const text = "hé🙂漢字\rprogress\r\nlast";
    const bytes = Buffer.from(text);
    for (let split = 0; split <= bytes.length; split++) {
      let captured = "";
      const lines: string[] = [];
      const stream = new CommandOutputStream(
        (part) => {
          captured += part;
        },
        (line) => lines.push(line)
      );
      stream.write(bytes.subarray(0, split));
      stream.write(bytes.subarray(split));
      stream.end();
      expect(captured).toBe(text);
      expect(lines).toEqual(["hé🙂漢字", "progress", "last"]);
    }
  });

  it("bounds a whole oversized progress line without dropping captured text", () => {
    const text = "🙂".repeat(100000) + "\n";
    const lines: string[] = [];
    let captured = "";
    const stream = new CommandOutputStream(
      (part) => {
        captured += part;
      },
      (line) => lines.push(line)
    );
    stream.write(Buffer.from(text));
    stream.end();
    expect(captured).toBe(text);
    expect(lines.join("")).toBe(text.trim());
    expect(lines.every((line) => line.length <= 16_384 && !line.includes("�"))).toBe(true);
  });

  it("handles simultaneous large pipes, split unicode and no trailing newline", async () => {
    const lines: string[] = [];
    const result = await node(
      `
      const bytes = Buffer.from('🙂漢é');
      process.stdout.write(bytes.subarray(0, 1));
      process.stderr.write('err-start\\r');
      setTimeout(() => {
        process.stdout.write(bytes.subarray(1));
        process.stdout.write('\\rnext\\n');
        process.stdout.write('a'.repeat(300000));
        process.stderr.write('b'.repeat(300000));
        process.stdout.write('tail');
        process.stderr.write('end');
      }, 20);
    `,
      {},
      (line) => lines.push(line)
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("🙂漢é\rnext\n" + "a".repeat(300000) + "tail");
    expect(result.stderr).toBe("err-start\r" + "b".repeat(300000) + "end");
    expect(lines).toContain("🙂漢é");
    expect(lines).toContain("next");
    expect(lines).toContain("err-start");
    expect(result.outputTruncated).toBe(false);
  });

  it("emits CR progress before exit and flushes ANSI/trailing lines once", async () => {
    const lines: string[] = [];
    const result = await node(
      `process.stdout.write('first\\r'); setTimeout(() => {
      process.stdout.write('\\x1b[32mlast');
    }, 100);`,
      {},
      (line) => lines.push(line)
    );
    expect(result.success).toBe(true);
    expect(lines).toEqual(["first", "\x1b[32mlast"]);
  });

  it("fails closed on complete capture overflow, even if a tail could be valid JSON", async () => {
    const result = await node(`process.stdout.write(' '.repeat(100000) + '{"valid":true}');`, {
      maxOutputBytes: 1024,
      terminationGraceMs: 20
    });
    expect(result.success).toBe(false);
    expect(result.failure?.kind).toBe("output-limit");
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout).toBe("");
    expect(result.output).toBe("");
  });

  it("bounds tail capture without killing work or corrupting unicode", async () => {
    const result = await node(
      `process.stdout.write('🙂'.repeat(100000));
      process.stderr.write('err'.repeat(50000)); setTimeout(() => process.stdout.write('done'), 100);`,
      {
        capture: "tail",
        maxOutputBytes: 1001
      }
    );
    expect(result.success).toBe(true);
    expect(result.outputTruncated).toBe(true);
    for (const text of [result.stdout!, result.stderr!, result.output]) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1001);
      expect(text).not.toContain("�");
    }
    expect(result.stdout).toMatch(/done$/);
  });
});

describe("command lifecycle", () => {
  it("reports missing and non-executable launch categories without private args", async () => {
    const { file } = await fixture("not executable");
    for (const [path, code] of [
      [file + "-missing", "ENOENT"],
      [file, "EACCES"]
    ]) {
      const result = await runCommand(path!, ["private-value"]);
      expect(result.success).toBe(false);
      expect(result.status).toBeNull();
      expect(result.failure).toMatchObject({ kind: "spawn", code });
      expect(JSON.stringify(result)).not.toContain("private-value");
    }
  });

  it("reports signal termination", async () => {
    const result = await node(`process.kill(process.pid, 'SIGTERM')`);
    expect(result.success).toBe(false);
    expect(result.signal).toBe("SIGTERM");
    expect(result.failure?.kind).toBe("signal");
  });

  it("does not launch an already-cancelled command", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCommand("/missing", [], undefined, { signal: controller.signal });
    expect(result.failure?.kind).toBe("cancelled");
    expect(result.status).toBeNull();
  });

  it("handles cancellation immediately after spawn without losing the abort", async () => {
    const controller = new AbortController();
    const { file } = await fixture("setInterval(() => {}, 1000);");
    const pending = runCommand(process.execPath, [file], undefined, {
      signal: controller.signal,
      terminationGraceMs: 20
    });
    controller.abort();
    const result = await pending;
    expect(result.failure?.kind).toBe("cancelled");
    expect(result.success).toBe(false);
  });

  it("times out a command before it produces output", async () => {
    const result = await node("setInterval(() => {}, 1000);", {
      timeoutMs: 1,
      terminationGraceMs: 20
    });
    expect(result.failure?.kind).toBe("timeout");
    expect(result.stdout).toBe("");
  });

  it("rejects invalid capture and overflowing Node timer values", async () => {
    for (const options of [{ maxOutputBytes: 0 }, { timeoutMs: -1 }, { timeoutMs: 2 ** 32 }]) {
      await expect(runCommand(process.execPath, [], undefined, options)).rejects.toThrow(
        RangeError
      );
    }
  });

  it("cleans a child when an output callback throws", async () => {
    let pid = 0;
    const result = await node(
      `console.log(process.pid); setInterval(() => {}, 1000);`,
      {
        terminationGraceMs: 20
      },
      (line) => {
        pid = Number(line);
        throw new Error("private callback error");
      }
    );
    expect(result.failure?.kind).toBe("callback");
    expect(alive(pid)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private callback error");
  });

  it("has no automatic deadline for generic commands", async () => {
    const result = await node(`setTimeout(() => console.log('done'), 150);`);
    expect(result.success).toBe(true);
  });

  it.each(["timeout", "cancelled", "parent-exit"] as const)(
    "awaits child and grandchild cleanup on %s, escalating ignored TERM",
    async (mode) => {
      const { dir, file } = await fixture("");
      const grandchild = join(dir, "grandchild.cjs");
      const child = join(dir, "child.cjs");
      const ready = join(dir, "ready");
      await writeFile(
        grandchild,
        `process.on('SIGTERM', () => {});
        require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
        setInterval(() => {}, 1000);`
      );
      await writeFile(
        child,
        `process.on('SIGTERM', () => {});
        require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchild)}], {stdio:'inherit'});
        setInterval(() => {}, 1000);`
      );
      await writeFile(
        file,
        `const c = require('node:child_process').spawn(process.execPath,
        [${JSON.stringify(child)}], {stdio:'inherit'});
        console.log(process.pid + ',' + c.pid);
        ${
          mode === "parent-exit"
            ? `const ready = setInterval(() => {
          if (require('node:fs').existsSync(${JSON.stringify(ready)})) {
            clearInterval(ready); process.exit(0);
          }
        }, 20);`
            : "setInterval(() => {}, 1000);"
        }`
      );
      const controller = new AbortController();
      let pids: number[] = [];
      const resultPromise = runCommand(
        process.execPath,
        [file],
        (line) => {
          pids = line.split(",").map(Number);
        },
        {
          signal: controller.signal,
          timeoutMs: mode === "timeout" ? 2_000 : 0,
          terminationGraceMs: 40
        }
      );
      const grandchildPid = Number(await waitForFile(ready));
      if (mode === "cancelled") controller.abort();
      const result = await resultPromise;
      expect(result.failure?.kind).toBe(mode === "parent-exit" ? undefined : mode);
      expect(result.success).toBe(mode === "parent-exit");
      expect(pids).toHaveLength(2);
      for (const pid of [...pids, grandchildPid]) expect(alive(pid)).toBe(false);
    },
    10_000
  );

  it("applies environment overlays without logging their values", async () => {
    const result = await node(`console.log(process.env.BASELINE_RUNNER_TEST);`, {
      env: { BASELINE_RUNNER_TEST: "fixture-value" }
    });
    expect(result.stdout).toBe("fixture-value\n");
  });
});

describe("Homebrew policy", () => {
  it("preserves proxy/cert/custom settings, fills Finder PATH/locale and disables interaction", () => {
    const env = homebrewEnvironment("/custom/bin/brew", {
      HTTPS_PROXY: "fixture-proxy",
      SSL_CERT_FILE: "/fixture/cert",
      HOMEBREW_CURLRC: "1",
      HOMEBREW_COLOR: "1",
      CLICOLOR_FORCE: "1"
    });
    expect(env).toMatchObject({
      HTTPS_PROXY: "fixture-proxy",
      SSL_CERT_FILE: "/fixture/cert",
      HOMEBREW_CURLRC: "1",
      LANG: "en_US.UTF-8",
      NONINTERACTIVE: "1",
      HOMEBREW_NO_AUTO_UPDATE: "1",
      HOMEBREW_NO_ANALYTICS: "1",
      NO_COLOR: "1"
    });
    expect(env.PATH).toBe("/custom/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(env.HOMEBREW_COLOR).toBeUndefined();
    expect(env.CLICOLOR_FORCE).toBeUndefined();
    expect(homebrewEnvironment("/brew", { LANG: "de_DE.UTF-8", PATH: "/custom/bin" }).LANG).toBe(
      "de_DE.UTF-8"
    );
  });

  it("limits only known reads, leaving valid long mutations unrestricted", () => {
    for (const args of [
      ["info"],
      ["list"],
      ["outdated"],
      ["--version"],
      ["doctor"],
      ["services", "info"]
    ])
      expect(homebrewReadCommand(args)).toBe(true);
    for (const args of [
      ["upgrade"],
      ["install"],
      ["update"],
      ["cleanup"],
      ["services", "start"],
      []
    ])
      expect(homebrewReadCommand(args)).toBe(false);
    expect(commandCompleteCaptureBytes).toBe(32 * 1024 * 1024);
    expect(commandTailCaptureBytes).toBe(1024 * 1024);
  });
});
