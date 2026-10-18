// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// Ephemeral projections only: never include raw CLI text, environment values,
// paths, URLs, service users, PIDs, or suggested commands in these contracts.
export type HomebrewDiagnosticsRequest = { doctor?: boolean; services?: boolean };
export type DiagnosticSectionStatus =
  "ok" | "findings" | "partial" | "unavailable" | "invalid" | "truncated";
export type DiagnosticFailure =
  | "spawn"
  | "signal"
  | "cancelled"
  | "timeout"
  | "output-limit"
  | "callback"
  | "cleanup"
  | "admin-helper"
  | "configuration-blocked";
export type DiagnosticSection = {
  status: DiagnosticSectionStatus;
  exitStatus: number | null;
  failure?: DiagnosticFailure;
};
export type HomebrewConfigDiagnostics = DiagnosticSection & {
  versions: Partial<Record<"homebrew" | "macOS" | "CLT" | "Xcode" | "curl" | "git", string>>;
  architecture?: "arm64" | "x86_64";
  rosetta?: boolean;
  proxyConfigured: boolean;
  certificateConfigured: boolean;
};
export type DoctorFindingCategory =
  | "permissions"
  | "developer-tools"
  | "deprecated-packages"
  | "unlinked-kegs"
  | "search-path"
  | "network"
  | "unsupported-configuration"
  | "other";
export type HomebrewDoctorDiagnostics = DiagnosticSection & {
  format: "json" | "text";
  findings: Array<{
    category: DoctorFindingCategory;
    supportTier: 1 | 2 | 3 | "unsupported" | "unknown";
  }>;
  omittedFindings: number;
  malformedFindings: number;
};
export type HomebrewServiceDiagnostics = DiagnosticSection & {
  total: number;
  running: number;
  registered: number;
  failed: number;
  unknown: number;
  omittedServices: number;
};
export type HomebrewDiagnosticsReport = {
  status: "complete" | "busy" | "unavailable" | "cancelled";
  config?: HomebrewConfigDiagnostics;
  doctor?: HomebrewDoctorDiagnostics;
  services?: HomebrewServiceDiagnostics;
};
