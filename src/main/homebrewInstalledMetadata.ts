// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { HomebrewManagedItem, HomebrewManagedItemKind } from "../shared/domain";
import { homebrewCommandToken } from "../shared/homebrewIdentity";
import { isValidHomebrewToken } from "../shared/security";
import type { CommandResult } from "./commandRunner";

export type HomebrewInstalledDependency = {
  kind: HomebrewManagedItemKind;
  token: string;
  scope: "runtime" | "build" | "test" | "recommended" | "optional";
  source: "receipt" | "declaration";
  version?: string;
  revision?: number;
  declaredDirectly?: boolean;
  /** Only exact, unambiguous installed identity matches are resolved. */
  installedItemID?: string;
};

export type HomebrewInstalledMetadata = {
  identity: string;
  kind: HomebrewManagedItemKind;
  caveats?: string;
  deprecated?: boolean;
  deprecationDate?: string;
  deprecationReason?: string;
  disabled?: boolean;
  disableDate?: string;
  disableReason?: string;
  stableVersion?: string;
  revision?: number;
  versionScheme?: number;
  headVersion?: string;
  autoUpdates?: boolean;
  installedOnRequest?: boolean;
  installedAsDependency?: boolean;
  installedReceipts: {
    version: string;
    revision?: number;
    installedOnRequest?: boolean;
    installedAsDependency?: boolean;
    time?: number;
    runtimeDependencies: HomebrewInstalledDependency[];
  }[];
  dependencies: HomebrewInstalledDependency[];
  /** Observed runtime edges only; never an uninstall-safety/complete-graph claim. */
  installedDependents: string[];
};

/** Installed evidence only, deliberately separate from the persisted/UI item contract. */
export function buildInstalledMetadata(
  items: HomebrewManagedItem[],
  formulaInfo: CommandResult,
  caskInfo: CommandResult
): Record<string, HomebrewInstalledMetadata> {
  const formulae = entries(formulaInfo, "formulae");
  const casks = entries(caskInfo, "casks");
  const result: Record<string, HomebrewInstalledMetadata> = {};
  for (const item of items) {
    const identity = homebrewCommandToken(item);
    if (!identity) continue;
    const matches = (item.kind === "formula" ? formulae : casks).filter((raw) =>
      item.kind === "formula"
        ? raw.full_name === item.formulaIdentity?.fullName &&
          raw.name === item.formulaIdentity?.name
        : raw.token === item.token && raw.full_token === item.fullToken && raw.tap === item.tap
    );
    if (matches.length !== 1) continue;
    const raw = matches[0];
    const installedReceipts: HomebrewInstalledMetadata["installedReceipts"] =
      item.kind === "formula" && Array.isArray(raw.installed)
        ? raw.installed
            .filter((receipt: any) => typeof receipt?.version === "string")
            .map((receipt: any) => ({
              version: receipt.version,
              revision: integer(receipt.revision),
              installedOnRequest: boolean(receipt.installed_on_request),
              installedAsDependency: boolean(receipt.installed_as_dependency),
              time: integer(receipt.time),
              runtimeDependencies: runtimeDependencies(receipt.runtime_dependencies)
            }))
        : [
            { version: string(raw.installed) ?? item.installedVersion.raw, runtimeDependencies: [] }
          ];
    const metadata: HomebrewInstalledMetadata = {
      identity,
      kind: item.kind,
      caveats: string(raw.caveats),
      deprecated: boolean(raw.deprecated),
      deprecationDate: string(raw.deprecation_date),
      deprecationReason: string(raw.deprecation_reason),
      disabled: boolean(raw.disabled),
      disableDate: string(raw.disable_date),
      disableReason: string(raw.disable_reason),
      stableVersion: string(item.kind === "formula" ? raw.versions?.stable : raw.version),
      revision: integer(raw.revision),
      versionScheme: integer(raw.version_scheme),
      headVersion: string(raw.versions?.head),
      autoUpdates: boolean(raw.auto_updates),
      // Preserve per-keg reasons above; aggregate true if observed, unknown otherwise.
      installedOnRequest: observedBoolean(installedReceipts.map((r) => r.installedOnRequest)),
      installedAsDependency: observedBoolean(installedReceipts.map((r) => r.installedAsDependency)),
      installedReceipts,
      dependencies: declaredDependencies(raw, item.kind),
      installedDependents: []
    };
    metadata.dependencies.push(...installedReceipts.flatMap((r) => r.runtimeDependencies));
    result[item.id] = metadata;
  }

  const identities = new Map<string, string[]>();
  for (const [id, metadata] of Object.entries(result)) {
    const key = `${metadata.kind}:${metadata.identity}`;
    identities.set(key, [...(identities.get(key) ?? []), id]);
  }
  for (const [id, metadata] of Object.entries(result)) {
    for (const dependency of metadata.dependencies) {
      // Declarations are resolution hints, not proof of installed runtime edges.
      // Receipt full_name is the canonical identity observed at installation time.
      if (dependency.source !== "receipt") continue;
      const matches = identities.get(`${dependency.kind}:${dependency.token}`);
      if (matches?.length !== 1 || matches[0] === id) continue;
      const target = matches[0]!;
      dependency.installedItemID = target;
      if (dependency.scope === "runtime") result[target]!.installedDependents.push(id);
    }
  }
  for (const metadata of Object.values(result)) {
    metadata.installedDependents = [...new Set(metadata.installedDependents)].sort();
  }
  return result;
}

function entries(result: CommandResult, key: string): any[] {
  if (!result.success) return [];
  try {
    const raw = JSON.parse(result.stdout ?? result.output);
    return Array.isArray(raw?.[key])
      ? raw[key].filter((entry: any) => entry && typeof entry === "object")
      : [];
  } catch {
    return [];
  }
}

function runtimeDependencies(raw: unknown): HomebrewInstalledDependency[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((dep: any) =>
    typeof dep?.full_name === "string" && isValidHomebrewToken(dep.full_name)
      ? [
          {
            kind: "formula" as const,
            token: dep.full_name,
            scope: "runtime" as const,
            source: "receipt" as const,
            version: string(dep.pkg_version ?? dep.version),
            revision: integer(dep.revision),
            declaredDirectly: boolean(dep.declared_directly)
          }
        ]
      : []
  );
}

function declaredDependencies(
  raw: any,
  kind: HomebrewManagedItemKind
): HomebrewInstalledDependency[] {
  const result: HomebrewInstalledDependency[] = [];
  const add = (
    values: unknown,
    dependencyKind: HomebrewManagedItemKind,
    scope: HomebrewInstalledDependency["scope"]
  ) => {
    for (const token of Array.isArray(values)
      ? values
      : typeof values === "string"
        ? [values]
        : []) {
      if (typeof token === "string" && isValidHomebrewToken(token))
        result.push({ kind: dependencyKind, token, scope, source: "declaration" });
    }
  };
  if (kind === "formula") {
    add(raw.dependencies, "formula", "runtime");
    add(raw.build_dependencies, "formula", "build");
    add(raw.test_dependencies, "formula", "test");
    add(raw.recommended_dependencies, "formula", "recommended");
    add(raw.optional_dependencies, "formula", "optional");
  } else {
    add(raw.depends_on?.formula, "formula", "runtime");
    add(raw.depends_on?.cask, "cask", "runtime");
  }
  return result;
}

function string(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

function boolean(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

function integer(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
}

function observedBoolean(values: (boolean | undefined)[]): boolean | undefined {
  return values.includes(true)
    ? true
    : values.length > 0 && values.every((value) => value === false)
      ? false
      : undefined;
}
