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
  /** Formula spec of the installed keg/current declaration, when recognizable. */
  spec?: "stable" | "head";
  /** Installed keg whose receipt supplied this historical runtime reference. */
  receiptVersion?: string;
  declarationSource?: "stable" | "head" | "shared";
  version?: string;
  pkgVersion?: string;
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
  /** Direct Cask info fields, not formula-style keg receipts. */
  caskVersion?: string;
  caskInstalledVersion?: string;
  caskInstalledTime?: number;
  /** Any observed true; false only when all keg records explicitly report false.
   * Homebrew can default old/missing Tab intent to false: this is not a cause. */
  installedOnRequest?: boolean;
  installedReceipts: {
    version: string;
    spec?: "stable" | "head";
    installedOnRequest?: boolean;
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
          raw.name === item.formulaIdentity?.name &&
          raw.tap === item.formulaIdentity?.tap
        : raw.token === item.token && raw.full_token === item.fullToken && raw.tap === item.tap
    );
    if (matches.length !== 1) continue;
    const raw = matches[0];
    const installedReceipts: HomebrewInstalledMetadata["installedReceipts"] =
      item.kind === "formula" && Array.isArray(raw.installed)
        ? raw.installed.flatMap((receipt: unknown) => {
            if (!object(receipt)) return [];
            const installedVersion = versionText(receipt.version);
            if (!installedVersion) return [];
            const spec = formulaSpec(installedVersion);
            return [
              {
                version: installedVersion,
                spec,
                installedOnRequest: boolean(receipt.installed_on_request),
                time: integer(receipt.time),
                runtimeDependencies: runtimeDependencies(
                  receipt.runtime_dependencies,
                  installedVersion,
                  spec
                )
              }
            ];
          })
        : [];
    const metadata: HomebrewInstalledMetadata = {
      identity,
      kind: item.kind,
      caveats: string(raw.caveats),
      deprecated: boolean(raw.deprecated),
      deprecationDate: calendarDate(raw.deprecation_date),
      deprecationReason: string(raw.deprecation_reason),
      disabled: boolean(raw.disabled),
      disableDate: calendarDate(raw.disable_date),
      disableReason: string(raw.disable_reason),
      stableVersion: item.kind === "formula" ? versionText(raw.versions?.stable) : undefined,
      revision: item.kind === "formula" ? integer(raw.revision) : undefined,
      versionScheme: item.kind === "formula" ? integer(raw.version_scheme) : undefined,
      headVersion: item.kind === "formula" ? versionText(raw.versions?.head) : undefined,
      autoUpdates: item.kind === "cask" ? boolean(raw.auto_updates) : undefined,
      caskVersion: item.kind === "cask" ? versionText(raw.version) : undefined,
      caskInstalledVersion: item.kind === "cask" ? versionText(raw.installed) : undefined,
      caskInstalledTime: item.kind === "cask" ? integer(raw.installed_time) : undefined,
      // Preserve per-keg intent; aggregate only the observed booleans.
      installedOnRequest: observedBoolean(installedReceipts.map((r) => r.installedOnRequest)),
      installedReceipts,
      dependencies: declaredDependencies(raw, item.kind, installedReceipts),
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
    return Array.isArray(raw?.[key]) ? raw[key].filter(object) : [];
  } catch {
    return [];
  }
}

function runtimeDependencies(
  raw: unknown,
  receiptVersion: string,
  spec: "stable" | "head" | undefined
): HomebrewInstalledDependency[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((dep: unknown) =>
    object(dep) && typeof dep.full_name === "string" && isValidHomebrewToken(dep.full_name)
      ? [
          {
            kind: "formula" as const,
            token: dep.full_name,
            scope: "runtime" as const,
            source: "receipt" as const,
            spec,
            receiptVersion,
            version: versionText(dep.version),
            pkgVersion: versionText(dep.pkg_version),
            revision: integer(dep.revision),
            declaredDirectly: boolean(dep.declared_directly)
          }
        ]
      : []
  );
}

function declaredDependencies(
  raw: Record<string, any>,
  kind: HomebrewManagedItemKind,
  receipts: HomebrewInstalledMetadata["installedReceipts"]
): HomebrewInstalledDependency[] {
  const result: HomebrewInstalledDependency[] = [];
  const add = (
    values: unknown,
    dependencyKind: HomebrewManagedItemKind,
    scope: HomebrewInstalledDependency["scope"],
    provenance: Pick<HomebrewInstalledDependency, "spec" | "declarationSource"> = {}
  ) => {
    // Formula dependencies_hash and Cask depends_on serialize token arrays.
    // Missing or malformed declarations remain unknown; retain only observed entries.
    for (const token of Array.isArray(values) ? values : []) {
      if (typeof token === "string" && isValidHomebrewToken(token))
        result.push({ kind: dependencyKind, token, scope, source: "declaration", ...provenance });
    }
  };
  if (kind === "formula") {
    const specs = new Set(receipts.map((receipt) => receipt.spec));
    for (const spec of ["stable", "head"] as const) {
      if (!specs.has(spec)) continue;
      let declarations: Record<string, any> = raw;
      let declarationSource: "stable" | "head" | "shared" = "stable";
      if (spec === "head") {
        if (Object.hasOwn(raw, "head_dependencies")) {
          if (!object(raw.head_dependencies)) continue;
          declarations = raw.head_dependencies;
          declarationSource = "head";
        } else {
          // Formula omits head_dependencies only when equal to stable. If HEAD
          // is no longer available, equality cannot be established from omission.
          if (!versionText(raw.versions?.head)) continue;
          declarationSource = "shared";
        }
      }
      const provenance = { spec, declarationSource };
      add(declarations.dependencies, "formula", "runtime", provenance);
      add(declarations.build_dependencies, "formula", "build", provenance);
      add(declarations.test_dependencies, "formula", "test", provenance);
      add(declarations.recommended_dependencies, "formula", "recommended", provenance);
      add(declarations.optional_dependencies, "formula", "optional", provenance);
    }
  } else if (object(raw.depends_on)) {
    add(raw.depends_on.formula, "formula", "runtime");
    add(raw.depends_on.cask, "cask", "runtime");
  }
  return result;
}

function object(raw: unknown): raw is Record<string, any> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

function versionText(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 && !/\s/u.test(raw) ? raw : undefined;
}

function formulaSpec(installedVersion: string): "stable" | "head" {
  // Match PkgVersion's revision suffix and Version#head? rather than guessing
  // commit syntax: Homebrew accepts non-hex HEAD commit strings too.
  const underlyingVersion = installedVersion.replace(/_\d+$/u, "");
  return /^HEAD(?:-.*)?$/u.test(underlyingVersion) ? "head" : "stable";
}

function calendarDate(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(raw)) return undefined;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw
    ? raw
    : undefined;
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
