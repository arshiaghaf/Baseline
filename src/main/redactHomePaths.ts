// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

/** Shared main-process home-directory redaction for user-visible diagnostics. */
export function redactHomePaths(value: string): string {
  return value.replace(/\/Users\/[^/\s]+/gu, "~");
}
