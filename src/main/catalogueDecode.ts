// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

export type CatalogueDecodeStatus = {
  totalEntries: number;
  skippedEntries: number;
  schemaWarnings: number;
};

const maxEntries = 100_000;

export function decodeCatalogue(data: Buffer): unknown[] {
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  if (!Array.isArray(raw) || raw.length > maxEntries) throw new Error("Invalid catalogue schema");
  return raw;
}

// Count only; never retain error strings, field values, or rejected payloads.
export function catalogueEntryIsBounded(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = [{ value: value as unknown, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 20_000 || current.depth > 32) return false;
    if (typeof current.value === "string" && current.value.length > 256 * 1024) return false;
    if (current.value && typeof current.value === "object") {
      const children = Object.values(current.value);
      if (children.length > 2048) return false;
      for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

export function decodeStatus(totalEntries: number): CatalogueDecodeStatus {
  return { totalEntries, skippedEntries: 0, schemaWarnings: 0 };
}

export function requireUsableCatalogue(status: CatalogueDecodeStatus): void {
  if (status.totalEntries > 0 && status.totalEntries === status.skippedEntries) {
    throw new Error("Catalogue has no valid entries");
  }
}
