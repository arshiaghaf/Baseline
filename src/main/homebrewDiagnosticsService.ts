// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { CommandResult } from "./commandRunner";
import type {
  DiagnosticFailure,
  DiagnosticSection,
  DoctorFindingCategory,
  HomebrewConfigDiagnostics,
  HomebrewDiagnosticsReport,
  HomebrewDiagnosticsRequest,
  HomebrewDoctorDiagnostics,
  HomebrewServiceDiagnostics
} from "../shared/homebrewDiagnostics";

export const diagnosticsOutputLimit = 128 * 1024;
const findingLimit = 64;
const serviceLimit = 256;

// Structurally compatible with the bounded command runner. Injection is required:
// importing this service alone must never launch a process or acquire a lock.
export type DiagnosticCommandOptions = {
  signal?: AbortSignal;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  maxOutputBytes: number;
  capture: "complete";
};
// Raw runner failure messages are intentionally outside this privacy boundary.
export type DiagnosticCommandResult = Omit<CommandResult, "failure"> & {
  failure?: { kind: DiagnosticFailure };
  outputTruncated?: boolean;
};
export type DiagnosticEnvironmentPresence = {
  proxyConfigured: boolean;
  certificateConfigured: boolean;
};
export type HomebrewDiagnosticsDependencies = {
  // Inject presence booleans only; never inject or retain raw environment values.
  environmentPresence?(): DiagnosticEnvironmentPresence;
  runBrew(
    args: string[],
    onOutputLine: undefined,
    options: DiagnosticCommandOptions
  ): Promise<DiagnosticCommandResult>;
  // Acquire the existing shared reservation synchronously; do not replace it
  // with a service-local busy flag. Hold it until runner teardown has settled.
  reserveHomebrewWork(): (() => void) | undefined;
};

export class HomebrewDiagnosticsService {
  constructor(private readonly dependencies: HomebrewDiagnosticsDependencies) {}

  async collect(
    request: HomebrewDiagnosticsRequest = {},
    signal?: AbortSignal
  ): Promise<HomebrewDiagnosticsReport> {
    if (!validRequest(request)) throw new TypeError("Invalid diagnostics request");
    if (signal?.aborted) return { status: "cancelled" };
    const release = this.dependencies.reserveHomebrewWork();
    if (!release) return { status: "busy" };
    try {
      const environment = (this.dependencies.environmentPresence ?? inheritedEnvironmentPresence)();
      const configResult = await this.run(["config"], signal);
      const report: HomebrewDiagnosticsReport = {
        status: "complete",
        config: parseConfigDiagnostics(configResult, environment)
      };
      if (cancelled(configResult, signal)) return { ...report, status: "cancelled" };
      if (configResult.failure?.kind === "cleanup") return { ...report, status: "unavailable" };
      if (request.doctor) {
        const structured = await this.run(["doctor", "--json"], signal);
        report.doctor = parseDoctorDiagnostics(structured, "json");
        if (cancelled(structured, signal)) return { ...report, status: "cancelled" };
        if (structured.failure?.kind === "cleanup") return { ...report, status: "unavailable" };
        // Only retry schema/option incompatibility. Never retry a deadline,
        // launch failure or overflow, and never run a second successful doctor.
        if (report.doctor.status === "invalid") {
          const text = await this.run(["doctor"], signal);
          report.doctor = parseDoctorDiagnostics(text, "text");
          if (cancelled(text, signal)) return { ...report, status: "cancelled" };
          if (text.failure?.kind === "cleanup") return { ...report, status: "unavailable" };
        }
      }
      if (request.services) {
        const services = await this.run(["services", "info", "--all", "--json"], signal);
        report.services = parseServiceDiagnostics(services);
        if (cancelled(services, signal)) return { ...report, status: "cancelled" };
        if (services.failure?.kind === "cleanup") return { ...report, status: "unavailable" };
      }
      const sections = [report.config, report.doctor, report.services].filter(Boolean);
      if (sections.every((section) => section?.status === "unavailable")) {
        report.status = "unavailable";
      }
      return report;
    } finally {
      release();
    }
  }

  private async run(args: string[], signal?: AbortSignal): Promise<DiagnosticCommandResult> {
    if (signal?.aborted) return unavailable("cancelled");
    try {
      return await this.dependencies.runBrew(args, undefined, {
        signal,
        timeoutMs: args[0] === "doctor" ? 60_000 : 15_000,
        maxOutputBytes: diagnosticsOutputLimit,
        capture: "complete",
        // Overlay only. The runner must retain inherited proxy/certificate and
        // Homebrew configuration; diagnostics must not rewrite process.env.
        env: {
          NONINTERACTIVE: "1",
          HOMEBREW_NO_AUTO_UPDATE: "1",
          HOMEBREW_NO_ANALYTICS: "1",
          HOMEBREW_NO_ENV_HINTS: "1"
        }
      });
    } catch {
      // Exceptions may contain private launch paths or environment values.
      return unavailable("spawn");
    }
  }
}

function inheritedEnvironmentPresence(): DiagnosticEnvironmentPresence {
  return {
    proxyConfigured: [
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY"
    ].some((name) => Boolean(process.env[name])),
    certificateConfigured: [
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "CURL_CA_BUNDLE",
      "NODE_EXTRA_CA_CERTS"
    ].some((name) => Boolean(process.env[name]))
  };
}

function validRequest(request: HomebrewDiagnosticsRequest): boolean {
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const prototype = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(request).every(
    ([key, value]) => (key === "doctor" || key === "services") && typeof value === "boolean"
  );
}

function unavailable(failure: DiagnosticFailure): DiagnosticCommandResult {
  return { success: false, status: null, output: "", failure: { kind: failure } };
}

function cancelled(result: DiagnosticCommandResult, signal?: AbortSignal): boolean {
  return signal?.aborted === true || result.failure?.kind === "cancelled";
}

function baseSection(result: DiagnosticCommandResult): DiagnosticSection {
  const exitStatus = Number.isSafeInteger(result.status) ? result.status : null;
  // Cleanup uncertainty must remain visible even when capture also overflowed.
  if (result.failure?.kind === "cleanup") {
    return { status: "unavailable", exitStatus, failure: "cleanup" };
  }
  if (
    result.outputTruncated ||
    result.failure?.kind === "output-limit" ||
    [result.stdout ?? "", result.stderr ?? "", result.output].some(
      (text) => Buffer.byteLength(text, "utf8") > diagnosticsOutputLimit
    ) ||
    Buffer.byteLength(result.stdout ?? "", "utf8") +
      Buffer.byteLength(result.stderr ?? "", "utf8") >
      diagnosticsOutputLimit
  ) {
    return { status: "truncated", exitStatus, failure: "output-limit" };
  }
  if (result.failure || exitStatus === null) {
    return { status: "unavailable", exitStatus, failure: result.failure?.kind };
  }
  return { status: "ok", exitStatus };
}

function stdout(result: DiagnosticCommandResult): string {
  // Never combine stderr into structured JSON. Legacy fake runners can provide
  // output only, but real runner stdout always wins, even when empty.
  return result.stdout ?? result.output;
}

function plainText(text: string): string {
  // Only parsed values/categories leave this module, so unknown escape/control
  // sequences cannot become an export channel.
  // eslint-disable-next-line no-control-regex -- Match only ANSI CSI escape sequences.
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").replace(/\r/gu, "");
}

export function parseConfigDiagnostics(
  result: DiagnosticCommandResult,
  environment?: DiagnosticEnvironmentPresence
): HomebrewConfigDiagnostics {
  const base = baseSection(result);
  const report: HomebrewConfigDiagnostics = {
    ...base,
    versions: {},
    proxyConfigured: environment?.proxyConfigured === true,
    certificateConfigured: environment?.certificateConfigured === true
  };
  if (base.status !== "ok") return report;
  if (!result.success) return { ...report, status: "unavailable" };
  let recognized = false;
  const versionKeys = {
    HOMEBREW_VERSION: "homebrew",
    macOS: "macOS",
    CLT: "CLT",
    Xcode: "Xcode",
    Curl: "curl",
    Git: "git"
  } as const;
  for (const line of plainText(stdout(result)).split("\n")) {
    const match = /^([^:]+):\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1]!.trim();
    const value = match[2]!.trim();
    if (Object.hasOwn(versionKeys, key)) {
      const versionKey = versionKeys[key as keyof typeof versionKeys];
      // Discard suffixes containing locations, remotes, build hostnames, etc.
      const numeric = /^(\d+(?:\.\d+){0,5})(?:\s|$|[-_])/u.exec(value)?.[1];
      if (numeric && numeric.length <= 48) {
        report.versions[versionKey] = numeric;
        recognized = true;
      }
    }
    if (key === "Rosetta 2" && /^(true|false)$/u.test(value)) {
      report.rosetta = value === "true";
      recognized = true;
    }
    if (key === "macOS") {
      // SystemConfig.macos_config emits full_version-kernel, including Rosetta's
      // process architecture. HOMEBREW_PROCESSOR is not a printed config key.
      const architecture = /^\d+(?:\.\d+){0,5}-(arm64|x86_64)$/u.exec(value)?.[1];
      if (architecture) report.architecture = architecture as "arm64" | "x86_64";
    }
    if (/^(?:https?|all)_proxy$/iu.test(key)) {
      report.proxyConfigured ||= value.length > 0;
      recognized = true;
    }
  }
  return { ...report, status: recognized ? "ok" : "invalid" };
}

function category(text: string): DoctorFindingCategory {
  if (/not writable|permission|ownership/iu.test(text)) return "permissions";
  if (/command line tools|xcode|developer tools/iu.test(text)) return "developer-tools";
  if (/deprecated|disabled/iu.test(text)) return "deprecated-packages";
  if (/unlinked keg/iu.test(text)) return "unlinked-kegs";
  if (/\bPATH\b|search path/iu.test(text)) return "search-path";
  if (/certificate|proxy|network|connection/iu.test(text)) return "network";
  if (/unsupported|support tier/iu.test(text)) return "unsupported-configuration";
  return "other";
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDoctorDiagnostics(
  result: DiagnosticCommandResult,
  format: "json" | "text"
): HomebrewDoctorDiagnostics {
  const base = baseSection(result);
  const report: HomebrewDoctorDiagnostics = {
    ...base,
    format,
    findings: [],
    omittedFindings: 0,
    malformedFindings: 0
  };
  if (base.status !== "ok") return report;
  // Doctor exit 1 represents findings. Other statuses are execution failures.
  if (result.status !== 0 && result.status !== 1) {
    const unsupportedOption = /^Error: (?:invalid|unknown|unrecognized) option: --json\s*$/mu.test(
      plainText(`${stdout(result)}\n${result.stderr ?? ""}`)
    );
    return {
      ...report,
      status: format === "json" && unsupportedOption ? "invalid" : "unavailable"
    };
  }
  if (format === "json") {
    let raw: unknown;
    try {
      raw = JSON.parse(stdout(result));
    } catch {
      return { ...report, status: "invalid" };
    }
    if (!object(raw) || !Array.isArray(raw.findings)) return { ...report, status: "invalid" };
    report.omittedFindings = Math.max(0, raw.findings.length - findingLimit);
    for (const finding of raw.findings.slice(0, findingLimit)) {
      if (!object(finding) || typeof finding.text !== "string" || !finding.text.trim()) {
        report.malformedFindings += 1;
        continue;
      }
      const tier = finding.tier;
      report.findings.push({
        category: category(finding.text),
        supportTier:
          tier === 1 || tier === 2 || tier === 3 || tier === "unsupported" ? tier : "unknown"
      });
    }
  } else {
    const text = plainText(`${stdout(result)}\n${result.stderr ?? ""}`);
    const warnings = text.split("\n").filter((line) => /^(Warning|Error):\s*\S/u.test(line));
    report.omittedFindings = Math.max(0, warnings.length - findingLimit);
    report.findings = warnings.slice(0, findingLimit).map((line) => ({
      category: category(line),
      supportTier: "unknown"
    }));
    if (!warnings.length && !/^Your system is ready to brew\.$/mu.test(text)) {
      return { ...report, status: "invalid" };
    }
  }
  if (report.malformedFindings || report.omittedFindings) return { ...report, status: "partial" };
  if (report.findings.length) return { ...report, status: "findings" };
  // A warning exit with no readable findings is never a clean bill of health.
  return { ...report, status: result.success ? "ok" : "invalid" };
}

export function parseServiceDiagnostics(
  result: DiagnosticCommandResult
): HomebrewServiceDiagnostics {
  const base = baseSection(result);
  const report: HomebrewServiceDiagnostics = {
    ...base,
    total: 0,
    running: 0,
    registered: 0,
    failed: 0,
    unknown: 0,
    omittedServices: 0
  };
  if (base.status !== "ok") return report;
  if (!result.success) return { ...report, status: "unavailable" };
  const text = stdout(result).trim();
  // --json always prints an array, including [] when there are no targets.
  if (!text) return { ...report, status: "invalid" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...report, status: "invalid" };
  }
  if (!Array.isArray(raw)) return { ...report, status: "invalid" };
  report.total = raw.length;
  report.omittedServices = Math.max(0, raw.length - serviceLimit);
  for (const service of raw.slice(0, serviceLimit)) {
    if (!object(service) || typeof service.running !== "boolean") {
      report.unknown += 1;
      continue;
    }
    if (service.running) report.running += 1;
    if (service.registered === true) report.registered += 1;
    // Homebrew prioritizes a live PID over its historical exit code. A
    // simultaneous error status contradicts running and is schema uncertainty.
    if (service.running && service.status === "error") report.unknown += 1;
    if (
      !service.running &&
      (service.status === "error" ||
        (Number.isSafeInteger(service.exit_code) && service.exit_code !== 0))
    ) {
      report.failed += 1;
    }
  }
  report.status =
    report.unknown || report.omittedServices ? "partial" : report.failed ? "findings" : "ok";
  return report;
}

export function renderHomebrewDiagnostics(report: HomebrewDiagnosticsReport): string {
  // Render only the typed safe projection, never the runner result.
  const lines = ["Homebrew diagnostics (private details omitted)", `Status: ${report.status}`];
  if (report.config) {
    lines.push(`Config: ${sectionSummary(report.config)}`);
    for (const [name, value] of Object.entries(report.config.versions))
      lines.push(`${name}: ${value}`);
    if (report.config.architecture) lines.push(`Architecture: ${report.config.architecture}`);
    if (report.config.rosetta !== undefined) lines.push(`Rosetta: ${report.config.rosetta}`);
    lines.push(
      `Proxy configuration detected: ${report.config.proxyConfigured}`,
      `Certificate configuration detected: ${report.config.certificateConfigured}`
    );
  }
  if (report.doctor) {
    const doctor = report.doctor;
    lines.push(`Doctor: ${sectionSummary(doctor)} (${doctor.format})`);
    for (const finding of doctor.findings) {
      lines.push(`- ${finding.category}; support tier: ${finding.supportTier}`);
    }
    lines.push(
      `Omitted findings: ${doctor.omittedFindings}; malformed: ${doctor.malformedFindings}`
    );
  }
  if (report.services) {
    const services = report.services;
    lines.push(
      `Services: ${sectionSummary(services)}`,
      `Total: ${services.total}; running: ${services.running}; registered: ${services.registered}; failed: ${services.failed}; unknown: ${services.unknown}; omitted: ${services.omittedServices}`
    );
  }
  return lines.join("\n");
}

function sectionSummary(section: DiagnosticSection): string {
  return `${section.status}; exit: ${section.exitStatus ?? "unknown"}${
    section.failure ? `; reason: ${section.failure}` : ""
  }`;
}
