// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

/** Count local calendar dates independently of midnight's UTC offset. */
export function localCalendarDay(date: Date): number {
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  return calendarDate.getTime() / 86_400_000;
}
