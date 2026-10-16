// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { HomebrewMaintenanceProgressStage } from "../../shared/homebrewProgress";

export type SyntheticProgressTarget = {
  cap: number;
  speedMs: number;
};

export const syntheticProgressRanges = {
  starting: { cap: 0.28, speedMs: 5000 },
  downloading: { cap: 0.58, speedMs: 9000 },
  installing: { cap: 0.84, speedMs: 6500 },
  finalizing: { cap: 0.96, speedMs: 3500 }
} as const;

export function syntheticProgressTarget(value: number): SyntheticProgressTarget {
  const clamped = clampProgress(value);
  if (clamped >= HomebrewMaintenanceProgressStage.completed) {
    return { cap: 1, speedMs: 1 };
  }
  if (clamped >= HomebrewMaintenanceProgressStage.finalizing) {
    return syntheticProgressRanges.finalizing;
  }
  if (clamped >= HomebrewMaintenanceProgressStage.installing) {
    return syntheticProgressRanges.installing;
  }
  if (clamped >= HomebrewMaintenanceProgressStage.downloading) {
    return syntheticProgressRanges.downloading;
  }
  return syntheticProgressRanges.starting;
}

export function clampProgress(value: number): number {
  return Math.max(0, Math.min(value, 1));
}

export function easedProgress(
  start: number,
  target: SyntheticProgressTarget,
  elapsedMs: number
): number {
  if (target.cap <= start) {
    return start;
  }
  return start + (target.cap - start) * (1 - Math.exp(-elapsedMs / target.speedMs));
}
