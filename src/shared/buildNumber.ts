// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

const buildNumberPattern = /^[0-9][0-9.]*$/u;
const appVersionPattern = /^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9._-]+)?$/u;

export function validBuildNumber(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && buildNumberPattern.test(trimmed) ? trimmed : undefined;
}

export function buildNumberForAppVersion(value: string): string | undefined {
  const match = appVersionPattern.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  const patch = Number.parseInt(match[3] ?? "", 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }

  const buildNumber = major * 1_000_000 + minor * 10_000 + patch * 100;
  return buildNumber > 0 ? String(buildNumber) : undefined;
}
