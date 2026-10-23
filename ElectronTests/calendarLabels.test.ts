// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { updatedRelativeLabel } from "../src/renderer/helpers/labels";
import { startedUsingSummary } from "../src/renderer/helpers/profile";

describe("local calendar labels", () => {
  it.each([
    ["UTC", "2026-10-22T23:59:00Z", "2026-10-23T00:01:00Z", 1],
    ["Asia/Kolkata", "2026-10-22T23:59:00+05:30", "2026-10-23T00:01:00+05:30", 1],
    ["America/New_York", "2026-03-08T00:00:00-05:00", "2026-03-09T00:00:00-04:00", 1],
    ["America/New_York", "2026-03-07T23:59:00-05:00", "2026-03-09T00:01:00-04:00", 2],
    ["America/New_York", "2026-11-01T00:01:00-04:00", "2026-11-01T23:59:00-05:00", 0],
    ["America/New_York", "2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00", 1],
    ["UTC", "2026-12-31T23:59:00Z", "2027-01-01T00:01:00Z", 1],
    ["UTC", "2028-02-28T23:59:00Z", "2028-03-01T00:01:00Z", 2]
  ])("counts calendar days in %s from %s to %s", (timezone, createdAt, now, days) => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = timezone;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    try {
      expect(new Date(now).getHours()).toBe(Number(now.slice(11, 13)));
      expect
        .soft(updatedRelativeLabel(createdAt))
        .toBe(days === 0 ? "Updated today" : `Updated ${days} ${days === 1 ? "day" : "days"} ago`);
      expect.soft(startedUsingSummary(createdAt)).toEqual({
        relativeLabel: days === 0 ? "Today" : `${days} day${days === 1 ? "" : "s"}`,
        dateLabel: `Since ${new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric"
        }).format(new Date(createdAt))}`
      });
    } finally {
      vi.useRealTimers();
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it("retains invalid-date fallbacks and clamps future dates", () => {
    expect(updatedRelativeLabel("invalid")).toBe("Updated recently");
    expect(startedUsingSummary("invalid")).toEqual({
      relativeLabel: "Today",
      dateLabel: "Since today"
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    try {
      expect(updatedRelativeLabel("2026-10-25T12:00:00Z")).toBe("Updated today");
      expect(startedUsingSummary("2026-10-25T12:00:00Z").relativeLabel).toBe("Today");
    } finally {
      vi.useRealTimers();
    }
  });
});
