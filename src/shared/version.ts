export type VersionValue = {
  raw: string;
};

export function version(raw?: string | null): VersionValue {
  return {
    raw: (raw ?? "").trim()
  };
}

function components(value: VersionValue | string | null | undefined): number[] {
  const raw = typeof value === "string" ? value : (value?.raw ?? "");
  const sanitized = raw.trim().replace(/[^0-9]+/g, ".");
  const parsed = sanitized
    .split(".")
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));

  while (parsed.at(-1) === 0) {
    parsed.pop();
  }

  return parsed;
}

export function compareVersions(lhs: VersionValue | string, rhs: VersionValue | string): number {
  const left = components(lhs);
  const right = components(rhs);
  const count = Math.max(left.length, right.length);

  for (let index = 0; index < count; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue < rightValue ? -1 : 1;
    }
  }

  return 0;
}

export function isVersionGreater(lhs: VersionValue | string, rhs: VersionValue | string): boolean {
  return compareVersions(lhs, rhs) > 0;
}

export function isVersionEmpty(value: VersionValue | string | null | undefined): boolean {
  const raw = typeof value === "string" ? value : (value?.raw ?? "");
  return raw.trim().length === 0;
}

export function maxVersion(lhs: VersionValue, rhs: VersionValue): VersionValue {
  return compareVersions(lhs, rhs) >= 0 ? lhs : rhs;
}
