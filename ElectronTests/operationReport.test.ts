// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { expect, it } from "vitest";
import { operationIssueReport, operationReportURLLimit } from "../src/shared/operationReport";

const failure = {
  id: "update:item",
  entityID: "item",
  operation: "update" as const,
  reason: "command" as const,
  status: 1,
  occurredAt: "2026-10-16T12:00:00.000Z"
};

it.each([undefined, "short fixture", "🧪&?#%+\n".repeat(2000), "x".repeat(8192)])(
  "uses exact preview text in the final encoded, bounded issue form URL",
  (tail) => {
    const report = operationIssueReport(failure, tail);
    const url = new URL(report.url);
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    expect(url.searchParams.get("logs")).toBe(report.text);
    expect(Buffer.byteLength(report.url)).toBeLessThanOrEqual(operationReportURLLimit);
    expect(report.text).toContain("Baseline update failure");
    expect(report.text).not.toContain("�");
    if (tail && tail.length > 6000)
      expect(report.text).toContain("[Earlier output omitted for report size]");
  }
);
