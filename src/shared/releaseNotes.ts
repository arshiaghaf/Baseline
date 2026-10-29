// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

export type ReleaseNotesTarget = {
  kind: "app" | "homebrew";
  id: string;
  version: string;
  buildVersion?: string;
};

export type ReleaseNotesRequest = {
  requestID: string;
  target: ReleaseNotesTarget;
  force?: boolean;
};

export type ReleaseNotesBlock = {
  type: "heading" | "paragraph" | "list-item";
  text: string;
};

export type ReleaseNotesResult = {
  status: "available" | "unavailable" | "error";
  title: string;
  version: string;
  source?: "App Store" | "Sparkle" | "GitHub" | "Publisher";
  sourceURL?: string;
  websiteURL?: string;
  message?: string;
  blocks?: ReleaseNotesBlock[];
  /** A stale target is not proof that publisher notes are absent. */
  retryable?: boolean;
};

export type ReleaseNotesFormat = "html" | "plain-text" | "markdown";
