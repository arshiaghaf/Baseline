// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// An explicit, ephemeral explanation of observed installed metadata. Counts do
// not assert a complete dependency graph or authorize removal or updates.
export type HomebrewInstalledContext = {
  deprecated?: boolean;
  disabled?: boolean;
  autoUpdates?: boolean;
  /** Observed Homebrew flag; false does not prove a historical dependency cause. */
  installedOnRequest?: boolean;
  caveatsAvailable: boolean;
  /** Formula installed-keg records; cask info is not a formula receipt. */
  installedReceiptCount: number;
  declaredDependencyCount: number;
  observedRuntimeDependencyCount: number;
  observedInstalledDependentCount: number;
};
