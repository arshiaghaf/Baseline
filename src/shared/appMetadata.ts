// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

export type AppMetadata = {
  version: string;
  buildNumber?: string;
  displayVersion: string;
};

export function formatAppDisplayVersion(version: string, buildNumber?: string): string {
  const safeVersion = version.trim() || "Unknown";
  const safeBuildNumber = buildNumber?.trim();
  return safeBuildNumber ? `${safeVersion} (${safeBuildNumber})` : safeVersion;
}
