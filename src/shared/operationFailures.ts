// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

const reasons = [
  "network",
  "permission",
  "integrity",
  "unavailable",
  "locked",
  "command",
  "interrupted"
] as const;
export type OperationFailure = {
  id: string;
  entityID: string;
  operation: "update" | "install" | "uninstall";
  reason: (typeof reasons)[number];
  status: number | null;
  occurredAt: string;
};

export function failureReason(output: string): OperationFailure["reason"] {
  // Classify a bounded tail; never publish or persist raw command output,
  // paths, URLs, environment values, tokens, or credentials.
  const tail = output.slice(-4096).toLowerCase();
  if (/could not resolve|network|connection|timed? out|download failed/.test(tail))
    return "network";
  if (/permission denied|operation not permitted|not writable|access denied/.test(tail))
    return "permission";
  if (/checksum|sha256|hash mismatch|integrity check/.test(tail)) return "integrity";
  if (/no available formula|no cask with|not available|unavailable/.test(tail))
    return "unavailable";
  if (/already locked|another.*running|could not.*lock/.test(tail)) return "locked";
  return "command";
}

export function operationFailureDescription(
  failure: Pick<OperationFailure, "reason" | "status">
): string {
  const messages: Record<OperationFailure["reason"], string> = {
    network: "The download could not reach its server. Check your connection and retry.",
    permission: "The command did not have permission to complete.",
    integrity: "The downloaded file failed its integrity check.",
    unavailable: "The package is unavailable in the current metadata.",
    locked: "Another package operation holds the lock. Retry after it finishes.",
    interrupted: "The update sequence stopped before this item completed. Retry the item.",
    command:
      failure.status === null
        ? "The command could not be started or completed."
        : "The command did not complete."
  };
  return `${messages[failure.reason]}${failure.status === null ? "" : ` Exit status: ${failure.status}.`}`;
}

export function normalizeOperationFailures(input: unknown): OperationFailure[] {
  if (!Array.isArray(input)) return [];
  const records = new Map<string, OperationFailure>();
  for (const value of input.slice(0, 20)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Partial<OperationFailure>;
    if (
      typeof record.entityID !== "string" ||
      !record.entityID ||
      record.entityID.length > 2048 ||
      [...record.entityID].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    )
      continue;
    if (
      record.operation !== "update" &&
      record.operation !== "install" &&
      record.operation !== "uninstall"
    )
      continue;
    if (!reasons.includes(record.reason!)) continue;
    if (typeof record.occurredAt !== "string" || !Number.isFinite(Date.parse(record.occurredAt)))
      continue;
    const id = `${record.operation}:${record.entityID}`;
    if (records.has(id)) continue;
    records.set(id, {
      id,
      entityID: record.entityID,
      operation: record.operation,
      reason: record.reason!,
      status:
        typeof record.status === "number" &&
        Number.isInteger(record.status) &&
        record.status >= 0 &&
        record.status <= 255
          ? record.status
          : null,
      occurredAt: new Date(record.occurredAt).toISOString()
    });
  }
  return [...records.values()];
}
