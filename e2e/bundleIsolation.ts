// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

const keychainCommands = ["find-generic-password", "add-generic-password"];
const testSecretVariable = "BASELINE_E2E_PROFILE_SECRET";

export function assertProductionIntegrityBundle(code: string): void {
  if (
    !keychainCommands.every((command) => code.includes(command)) ||
    code.includes(testSecretVariable)
  ) {
    throw new Error(
      "Expected a production bundle with the Keychain provider and no test provider."
    );
  }
}

export function assertIsolatedIntegrityBundle(code: string): void {
  if (
    keychainCommands.some((command) => code.includes(command)) ||
    !code.includes(testSecretVariable)
  ) {
    throw new Error("Refusing to launch an E2E bundle without proven Keychain isolation.");
  }
}
