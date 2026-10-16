// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { HomebrewWorkLock } from "../src/main/homebrewWorkLock";
import {
  diagnosticsOutputLimit,
  HomebrewDiagnosticsService,
  parseConfigDiagnostics,
  parseDoctorDiagnostics,
  parseServiceDiagnostics,
  renderHomebrewDiagnostics,
  type DiagnosticCommandOptions,
  type DiagnosticCommandResult
} from "../src/main/homebrewDiagnosticsService";
import type { HomebrewDiagnosticsRequest } from "../src/shared/homebrewDiagnostics";

function result(stdout: string, status = 0, stderr = ""): DiagnosticCommandResult {
  return { success: status === 0, status, stdout, stderr, output: stdout + stderr };
}

function fixture(outputs: DiagnosticCommandResult[] = [result("HOMEBREW_VERSION: 6.0.0")]) {
  const release = vi.fn();
  const runBrew = vi.fn(async () => outputs.shift() ?? result(""));
  const reserveHomebrewWork = vi.fn(() => release);
  const service = new HomebrewDiagnosticsService({ runBrew, reserveHomebrewWork });
  return { service, runBrew, release, reserveHomebrewWork };
}

const privateText = [
  "SECRET_value+&=",
  "/Users/private Person/Library/secret key.pem",
  "https://user:password@private.example/api?token=SECRET_value+&=",
  "private-user@example.com",
  "Bearer x.y.z",
  "-----BEGIN PRIVATE KEY-----\nprivate key body"
].join("\n");

describe("on-demand Homebrew diagnostics", () => {
  it("has no constructor work and runs only config by default", async () => {
    const { service, runBrew, release, reserveHomebrewWork } = fixture();
    expect(runBrew).not.toHaveBeenCalled();
    expect(reserveHomebrewWork).not.toHaveBeenCalled();
    const report = await service.collect();
    expect(report).toEqual({
      status: "complete",
      config: {
        status: "ok",
        exitStatus: 0,
        versions: { homebrew: "6.0.0" },
        proxyConfigured: false,
        certificateConfigured: false
      }
    });
    expect(runBrew.mock.calls).toHaveLength(1);
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses an inherited-environment overlay, deadlines and complete bounded capture", async () => {
    const calls: { args: string[]; options: DiagnosticCommandOptions }[] = [];
    const before = process.env.HTTPS_PROXY;
    const service = new HomebrewDiagnosticsService({
      reserveHomebrewWork: () => () => undefined,
      runBrew: async (args, callback, options) => {
        expect(callback).toBeUndefined();
        calls.push({ args, options });
        if (args[0] === "doctor") return result('{"findings":[]}');
        if (args[0] === "services") return result("[]");
        return result("HOMEBREW_VERSION: 6.0.0");
      }
    });
    await service.collect({ doctor: true, services: true });
    expect(calls.map((call) => call.args)).toEqual([
      ["config"],
      ["doctor", "--json"],
      ["services", "info", "--all", "--json"]
    ]);
    expect(calls.map((call) => call.options.timeoutMs)).toEqual([15_000, 60_000, 15_000]);
    for (const { options } of calls) {
      expect(options.capture).toBe("complete");
      expect(options.maxOutputBytes).toBe(diagnosticsOutputLimit);
      expect(options.env).toEqual({
        NONINTERACTIVE: "1",
        HOMEBREW_NO_AUTO_UPDATE: "1",
        HOMEBREW_NO_ANALYTICS: "1",
        HOMEBREW_NO_ENV_HINTS: "1"
      });
    }
    expect(process.env.HTTPS_PROXY).toBe(before);
  });

  it("holds the real shared reservation until runner settlement, blocking overlap", async () => {
    const lock = new HomebrewWorkLock<string>({
      hasOtherMutation: () => false,
      onLockStateChange: () => undefined,
      onCommandReleased: () => undefined
    });
    let finish!: (output: DiagnosticCommandResult) => void;
    const runBrew = vi.fn(
      () => new Promise<DiagnosticCommandResult>((resolve) => (finish = resolve))
    );
    const service = new HomebrewDiagnosticsService({
      runBrew,
      reserveHomebrewWork: () => lock.reserveCommand()
    });
    const pending = service.collect();
    expect(lock.isCommandLocked).toBe(true);
    expect(lock.reserveCommand()).toBeUndefined();
    expect(await service.collect()).toEqual({ status: "busy" });
    expect(runBrew).toHaveBeenCalledOnce();
    finish(result("HOMEBREW_VERSION: 6.0.0"));
    await pending;
    expect(lock.isCommandLocked).toBe(false);
  });

  it("does not acquire during a refresh or existing mutation", async () => {
    const lock = new HomebrewWorkLock<string>({
      hasOtherMutation: () => false,
      onLockStateChange: () => undefined,
      onCommandReleased: () => undefined
    });
    const runBrew = vi.fn(async () => result(""));
    const service = new HomebrewDiagnosticsService({
      runBrew,
      reserveHomebrewWork: () => lock.reserveCommand()
    });
    lock.beginRefresh(1);
    expect(await service.collect({ doctor: true })).toEqual({ status: "busy" });
    lock.endRefresh(1);
    const release = lock.reserveCommand();
    expect(await service.collect({ services: true })).toEqual({ status: "busy" });
    release?.();
    expect(runBrew).not.toHaveBeenCalled();
  });

  it("uses one sequential text fallback for unsupported structured output", async () => {
    const { service, runBrew } = fixture([
      result("HOMEBREW_VERSION: 6.0.0"),
      result("", 2, "Error: invalid option: --json"),
      result("", 1, "Warning: Your Command Line Tools are too outdated.\n" + privateText)
    ]);
    const report = await service.collect({ doctor: true });
    expect(runBrew).toHaveBeenCalledTimes(3);
    expect(report.doctor).toMatchObject({
      format: "text",
      status: "findings",
      findings: [{ category: "developer-tools", supportTier: "unknown" }]
    });
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it.each(["spawn", "timeout", "output-limit", "cleanup"] as const)(
    "does not retry structured doctor after %s failure",
    async (kind) => {
      const { service, runBrew, release } = fixture([
        result("HOMEBREW_VERSION: 6.0.0"),
        { ...result(privateText, 1), failure: { kind } }
      ]);
      await service.collect({ doctor: true });
      expect(runBrew).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledOnce();
    }
  );

  it("stops all optional commands on uncertain process-group cleanup", async () => {
    const { service, runBrew, release } = fixture([
      { ...result("", 1), failure: { kind: "cleanup" } }
    ]);
    const report = await service.collect({ doctor: true, services: true });
    expect(report.status).toBe("unavailable");
    expect(report.config?.failure).toBe("cleanup");
    expect(runBrew).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the reservation and drops exception messages", async () => {
    const release = vi.fn();
    const service = new HomebrewDiagnosticsService({
      reserveHomebrewWork: () => release,
      runBrew: async () => {
        throw new Error(privateText);
      }
    });
    const report = await service.collect();
    expect(report.status).toBe("unavailable");
    expect(report.config?.failure).toBe("spawn");
    expect(JSON.stringify(report)).not.toContain("private");
    expect(release).toHaveBeenCalledOnce();
  });

  it("honors pre-abort without reserving or running", async () => {
    const { service, reserveHomebrewWork, runBrew } = fixture();
    expect(await service.collect({}, AbortSignal.abort())).toEqual({ status: "cancelled" });
    expect(reserveHomebrewWork).not.toHaveBeenCalled();
    expect(runBrew).not.toHaveBeenCalled();
  });

  it("awaits cancellation teardown before releasing and skips optional commands", async () => {
    const controller = new AbortController();
    const release = vi.fn();
    let finish!: (output: DiagnosticCommandResult) => void;
    const runBrew = vi.fn(
      () => new Promise<DiagnosticCommandResult>((resolve) => (finish = resolve))
    );
    const service = new HomebrewDiagnosticsService({ runBrew, reserveHomebrewWork: () => release });
    const pending = service.collect({ doctor: true, services: true }, controller.signal);
    controller.abort();
    expect(release).not.toHaveBeenCalled();
    finish({ ...result("", 1), failure: { kind: "cancelled" } });
    expect((await pending).status).toBe("cancelled");
    expect(runBrew).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    [],
    "doctor",
    Object.create({ doctor: true }),
    { doctor: "yes" },
    { command: ["upgrade"] },
    { services: 1 }
  ])("rejects malformed or arbitrary command requests: %j", async (request) => {
    const { service, runBrew, reserveHomebrewWork } = fixture();
    await expect(service.collect(request as HomebrewDiagnosticsRequest)).rejects.toThrow(
      "Invalid diagnostics request"
    );
    expect(runBrew).not.toHaveBeenCalled();
    expect(reserveHomebrewWork).not.toHaveBeenCalled();
  });
});

describe("private bounded diagnostic projections", () => {
  it("exposes only known numeric config versions, architecture and network setting presence", () => {
    const report = parseConfigDiagnostics(
      result(
        [
          "HOMEBREW_VERSION: 6.0.22-123-privatehost",
          "macOS: 26.0-arm64",
          "CLT: 17.0.0.0.1.123",
          "Xcode: 27.0 => /Users/private Person/Xcode",
          "Curl: 8.0.1 => https://user:password@private.example",
          "Git: 2.50.0 => /private/git",
          "HOMEBREW_PROCESSOR: arm64",
          "Rosetta 2: false",
          "HTTPS_PROXY: https://user:password@private.example/api?token=SECRET",
          "SSL_CERT_FILE: /Users/private Person/cert.pem",
          "HOMEBREW_PREFIX: /private/prefix",
          "ORIGIN: ssh://git@private.example/repo",
          "HOMEBREW_GITHUB_API_TOKEN: SECRET",
          privateText
        ].join("\n")
      )
    );
    expect(report).toMatchObject({
      status: "ok",
      versions: {
        homebrew: "6.0.22",
        macOS: "26.0",
        CLT: "17.0.0.0.1.123",
        Xcode: "27.0",
        curl: "8.0.1",
        git: "2.50.0"
      },
      architecture: "arm64",
      rosetta: false,
      proxyConfigured: true,
      certificateConfigured: true
    });
    expect(JSON.stringify(report)).not.toMatch(/private|SECRET|password|https|ssh|Bearer/u);
  });

  it("rejects unknown config schemas and secrets under known keys", () => {
    const report = parseConfigDiagnostics(result(`Xcode: ${privateText}\nUnknown: whatever`));
    expect(report.status).toBe("invalid");
    expect(report.versions).toEqual({});
  });

  it("keeps doctor warning exits as findings and discards every free-form field", () => {
    const report = parseDoctorDiagnostics(
      result(
        JSON.stringify({
          tier: "unsupported",
          findings: [
            {
              text: `Not writable: ${privateText}`,
              tier: 3,
              remediation: { commands: ["sudo rm -rf /"] },
              affects: [privateText],
              links: [privateText]
            },
            { text: privateText, tier: privateText }
          ],
          [privateText]: privateText
        }),
        1
      ),
      "json"
    );
    expect(report.status).toBe("findings");
    expect(report.findings).toEqual([
      { category: "permissions", supportTier: 3 },
      { category: "other", supportTier: "unknown" }
    ]);
    expect(JSON.stringify(report)).not.toMatch(/private|SECRET|sudo|Bearer/u);
    expect(renderHomebrewDiagnostics({ status: "complete", doctor: report })).not.toMatch(
      /private Person|SECRET|sudo|Bearer/u
    );
  });

  it.each(["{}", "null", "[]", '{"findings":{}}', "{bad json", '{"warnings":[]}'])(
    "does not mistake malformed structured doctor output for a healthy system: %s",
    (text) => {
      expect(parseDoctorDiagnostics(result(text), "json").status).toBe("invalid");
    }
  );

  it("keeps malformed entries visible as partial and caps the finding count", () => {
    const report = parseDoctorDiagnostics(
      result(
        JSON.stringify({
          findings: [
            null,
            {},
            { text: "" },
            ...Array.from({ length: 100 }, () => ({ text: "Unlinked kegs" }))
          ]
        })
      ),
      "json"
    );
    expect(report.status).toBe("partial");
    expect(report.malformedFindings).toBe(3);
    expect(report.findings).toHaveLength(61);
    expect(report.omittedFindings).toBe(39);
  });

  it("parses stderr-only text and ANSI warnings without exposing transcripts", () => {
    const report = parseDoctorDiagnostics(
      result(
        "",
        1,
        `\u001b[33mWarning: Deprecated packages.\u001b[0m\r\n${privateText}\nError: Connection failure.`
      ),
      "text"
    );
    expect(report.status).toBe("findings");
    expect(report.findings.map((finding) => finding.category)).toEqual([
      "deprecated-packages",
      "network"
    ]);
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("requires positive healthy evidence for text and zero exit for empty JSON findings", () => {
    expect(parseDoctorDiagnostics(result(""), "text").status).toBe("invalid");
    expect(parseDoctorDiagnostics(result("Your system is ready to brew."), "text").status).toBe(
      "ok"
    );
    expect(parseDoctorDiagnostics(result('{"findings":[]}', 1), "json").status).toBe("invalid");
    expect(parseDoctorDiagnostics(result('{"findings":[]}'), "json").status).toBe("ok");
    expect(parseDoctorDiagnostics(result("Warning: Something", 127), "text").status).toBe(
      "unavailable"
    );
  });

  it("never mixes stderr into structured JSON", () => {
    const report = parseDoctorDiagnostics(result('{"findings":[]}', 0, privateText), "json");
    expect(report.status).toBe("ok");
    expect(report.findings).toEqual([]);
  });

  it("returns aggregate service diagnostics without names, user/PID/path/log fields", () => {
    const report = parseServiceDiagnostics(
      result(
        JSON.stringify([
          {
            name: privateText,
            status: privateText,
            running: true,
            registered: true,
            pid: 12345,
            user: privateText,
            file: privateText,
            log_path: privateText,
            exit_code: 0
          },
          { name: "postgresql", running: false, registered: false, exit_code: 256 },
          { name: privateText, running: false, exit_code: "SECRET" }
        ])
      )
    );
    expect(report).toEqual({
      status: "findings",
      exitStatus: 0,
      total: 3,
      running: 1,
      registered: 1,
      failed: 1,
      unknown: 0,
      omittedServices: 0
    });
    expect(JSON.stringify(report)).not.toMatch(/private|SECRET|12345|postgresql/u);
  });

  it("retains cleanup uncertainty even if the runner also truncated output", () => {
    const report = parseConfigDiagnostics({
      ...result(""),
      outputTruncated: true,
      failure: { kind: "cleanup" }
    });
    expect(report).toMatchObject({ status: "unavailable", failure: "cleanup" });
  });

  it("counts an explicit service error when no exit code was reported", () => {
    const report = parseServiceDiagnostics(
      result(JSON.stringify([{ status: "error", running: false }]))
    );
    expect(report).toMatchObject({ status: "findings", failed: 1 });
  });

  it("distinguishes empty services, command failure, malformed data and capped counts", () => {
    expect(parseServiceDiagnostics(result("")).status).toBe("ok");
    expect(parseServiceDiagnostics(result("[]")).total).toBe(0);
    expect(parseServiceDiagnostics(result("{} ")).status).toBe("invalid");
    expect(parseServiceDiagnostics(result("not JSON")).status).toBe("invalid");
    expect(parseServiceDiagnostics(result("[]", 1)).status).toBe("unavailable");
    const report = parseServiceDiagnostics(
      result(JSON.stringify([null, {}, ...Array.from({ length: 300 }, () => ({ running: true }))]))
    );
    expect(report).toMatchObject({
      status: "partial",
      total: 302,
      running: 254,
      unknown: 2,
      omittedServices: 46
    });
  });

  it.each([
    parseConfigDiagnostics,
    (value: DiagnosticCommandResult) => parseDoctorDiagnostics(value, "json"),
    parseServiceDiagnostics
  ])("rejects oversized UTF-8 or truncated output before parsing", (parse) => {
    expect(parse(result("🦀".repeat(diagnosticsOutputLimit / 4 + 1))).status).toBe("truncated");
    expect(parse({ ...result("[]"), outputTruncated: true }).status).toBe("truncated");
    expect(
      parse(
        result(
          "x".repeat(diagnosticsOutputLimit / 2 + 1),
          0,
          "y".repeat(diagnosticsOutputLimit / 2)
        )
      ).status
    ).toBe("truncated");
  });
});
