// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { PreferencePatch } from "../shared/ipc";

export type ValueValidator = (value: unknown) => boolean;
export const isString: ValueValidator = (value) => typeof value === "string";
export const isBoolean: ValueValidator = (value) => typeof value === "boolean";
export const isStringArray: ValueValidator = (value) =>
  Array.isArray(value) && Array.from(value).every(isString);

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

const preferenceValidators: Record<keyof PreferencePatch, ValueValidator> = {
  collapsedAppSectionIDs: isStringArray,
  collapsedHomebrewSectionIDs: isStringArray,
  updateIntroductionDismissed: isBoolean,
  autoRefreshEnabled: isBoolean,
  refreshIntervalMinutes: (value) => typeof value === "number" && Number.isFinite(value),
  appearancePreference: (value) => value === "system" || value === "light" || value === "dark",
  useMasForAppStoreUpdates: isBoolean,
  showMenuBarIcon: isBoolean,
  showDockIcon: isBoolean
};

export function isPreferencePatch(value: unknown): value is PreferencePatch {
  return (
    isPlainRecord(value) &&
    Object.keys(value).every(
      (key) =>
        Object.hasOwn(preferenceValidators, key) &&
        (value[key] === undefined || preferenceValidators[key as keyof PreferencePatch](value[key]))
    )
  );
}

export function validatedPreferencePatch(value: unknown): PreferencePatch {
  if (!isPreferencePatch(value)) throw new Error("Invalid preference patch");
  // Only declared preferences can enter state, including for callers inside main.
  return Object.fromEntries(
    Object.keys(preferenceValidators)
      .filter(
        (key) => Object.hasOwn(value, key) && value[key as keyof PreferencePatch] !== undefined
      )
      .map((key) => {
        const entry = value[key as keyof PreferencePatch];
        return [key, Array.isArray(entry) ? [...entry] : entry];
      })
  );
}
