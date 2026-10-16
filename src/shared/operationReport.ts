// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { operationFailureDescription, type OperationFailure } from "./operationFailures";

export const operationReportURLLimit = 6 * 1024;

export function operationDetailsText(failure: OperationFailure, outputTail?: string): string {
  return `Baseline ${failure.operation} failure\n${operationFailureDescription(failure)}\n${failure.occurredAt}\n\n${outputTail || "No command output is available for this attempt."}`;
}

/** The preview is the exact decoded logs form field, including any URL-budget trimming.
 * Build the whole encoded URL every time; never slice percent-encoded bytes. */
export function operationIssueReport(
  failure: OperationFailure,
  outputTail?: string
): { text: string; url: string } {
  const urlFor = (text: string) => {
    const url = new URL("https://github.com/arshiaghaf/Baseline/issues/new");
    url.searchParams.set("template", "bug_report.yml");
    url.searchParams.set("logs", text);
    return url.href;
  };
  const full = operationDetailsText(failure, outputTail);
  const fullURL = urlFor(full);
  if (fullURL.length <= operationReportURLLimit) return { text: full, url: fullURL };
  const points = Array.from(outputTail ?? "");
  let low = 0;
  let high = points.length;
  let text = "";
  let url = "";
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = operationDetailsText(
      failure,
      `[Earlier output omitted for report size]\n${points.slice(points.length - count).join("")}`
    );
    const candidateURL = urlFor(candidate);
    if (candidateURL.length <= operationReportURLLimit) {
      text = candidate;
      url = candidateURL;
      low = count + 1;
    } else high = count - 1;
  }
  return { text, url };
}
