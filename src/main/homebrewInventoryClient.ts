// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { realpath } from "node:fs/promises";
import type { HomebrewManagedItem, HomebrewManagedItemKind } from "../shared/domain";
import { homebrewItemID } from "../shared/domain";
import { maxVersion, version } from "../shared/version";
import { runBrewCommand, type CommandResult } from "./commandRunner";
import { HomebrewCaskClient } from "./homebrewCaskClient";
import { homebrewCommandToken } from "../shared/homebrewIdentity";

type OutdatedMetadata = {
  latestVersion: ReturnType<typeof version>;
  releaseDate?: string;
  pinned?: boolean;
};

export type HomebrewInventoryOptions = {
  updateMetadata?: boolean;
};

export type HomebrewInventoryResult = {
  items: HomebrewManagedItem[];
  outdatedDetectionSucceeded: boolean;
  outdatedDetectionSucceededByKind: Record<HomebrewManagedItemKind, boolean>;
  inventoryReadSucceededByKind?: Record<HomebrewManagedItemKind, boolean>;
  warning?: string;
};

export class HomebrewInventoryClient {
  private readonly parser = new HomebrewInventoryParser();

  async fetchInventory(options: HomebrewInventoryOptions = {}): Promise<HomebrewInventoryResult> {
    const updateResult = options.updateMetadata ? await runBrewCommand(["update"]) : undefined;
    const [formulaVersions, caskVersions] = await Promise.all([
      runBrewCommand(["list", "--formula", "--versions"]),
      runBrewCommand(["list", "--cask", "--versions"])
    ]);
    const [formulaOutdated, caskOutdated, caskInfo, formulaInfo] = await Promise.all([
      runBrewCommand(["outdated", "--formula", "--json=v2"]),
      runBrewCommand(["outdated", "--cask", "--greedy", "--json=v2"]),
      runBrewCommand(["info", "--cask", "--installed", "--json=v2"]),
      runBrewCommand(["info", "--formula", "--installed", "--json=v2"])
    ]);

    const metadataReady = !updateResult || updateResult.success;
    const parsed = this.parser.buildInventoryWithStatus(
      commandStdout(formulaVersions),
      commandStdout(caskVersions),
      metadataReady && formulaOutdated.success ? commandStdout(formulaOutdated) || "{}" : "{}",
      metadataReady && caskOutdated.success ? commandStdout(caskOutdated) || "{}" : "{}"
    );
    const formulaMetadataReady = applyInstalledFormulaMetadata(
      parsed.items,
      formulaInfo,
      metadataReady && formulaOutdated.success ? commandStdout(formulaOutdated) : "{}"
    );
    const caskMetadataReady = await applyInstalledCaskMetadata(parsed.items, caskInfo);
    const commandSucceeded =
      metadataReady &&
      formulaVersions.success &&
      caskVersions.success &&
      formulaOutdated.success &&
      caskOutdated.success;

    return {
      items: parsed.items,
      inventoryReadSucceededByKind: {
        formula: formulaVersions.success,
        cask: caskVersions.success
      },
      outdatedDetectionSucceeded: commandSucceeded && parsed.outdatedDetectionSucceeded,
      outdatedDetectionSucceededByKind: {
        formula:
          metadataReady &&
          formulaVersions.success &&
          formulaOutdated.success &&
          parsed.outdatedDetectionSucceededByKind.formula,
        cask:
          metadataReady &&
          caskVersions.success &&
          caskOutdated.success &&
          parsed.outdatedDetectionSucceededByKind.cask
      },
      warning:
        [
          !formulaMetadataReady ? "Installed formula identity could not be verified." : undefined,
          !caskMetadataReady ? "Installed cask identity could not be verified." : undefined,
          inventoryWarning({
            updateResult,
            formulaVersions,
            caskVersions,
            formulaOutdated,
            caskOutdated,
            parsedSucceeded: parsed.outdatedDetectionSucceeded
          })
        ]
          .filter(Boolean)
          .join(" ") || undefined
    };
  }
}

function commandStdout(result: CommandResult): string {
  return result.stdout ?? result.output;
}

export class HomebrewInventoryParser {
  buildInventoryWithStatus(
    formulaVersionsOutput: string,
    caskVersionsOutput: string,
    formulaOutdatedJSON: string,
    caskOutdatedJSON: string
  ): HomebrewInventoryResult {
    const formulaInstalled = this.parseInstalledVersions(formulaVersionsOutput);
    const caskInstalled = this.parseInstalledVersions(caskVersionsOutput, "cask");
    const formulaOutdated = this.parseOutdatedMetadata(formulaOutdatedJSON, "formula");
    const caskOutdated = this.parseOutdatedMetadata(caskOutdatedJSON, "cask");
    const items = this.buildItems(
      formulaInstalled,
      caskInstalled,
      formulaOutdated.metadata,
      caskOutdated.metadata
    );

    return {
      items,
      outdatedDetectionSucceeded: formulaOutdated.valid && caskOutdated.valid,
      outdatedDetectionSucceededByKind: {
        formula: formulaOutdated.valid,
        cask: caskOutdated.valid
      },
      warning:
        formulaOutdated.valid && caskOutdated.valid
          ? undefined
          : "Homebrew outdated status could not be read reliably."
    };
  }

  buildInventory(
    formulaVersionsOutput: string,
    caskVersionsOutput: string,
    formulaOutdatedJSON: string,
    caskOutdatedJSON: string
  ): HomebrewManagedItem[] {
    return this.buildInventoryWithStatus(
      formulaVersionsOutput,
      caskVersionsOutput,
      formulaOutdatedJSON,
      caskOutdatedJSON
    ).items;
  }

  private buildItems(
    formulaInstalled: Map<string, ReturnType<typeof version>>,
    caskInstalled: Map<string, ReturnType<typeof version>>,
    formulaOutdated: Map<string, OutdatedMetadata>,
    caskOutdated: Map<string, OutdatedMetadata>
  ): HomebrewManagedItem[] {
    const items: HomebrewManagedItem[] = [];

    for (const [token, installedVersion] of formulaInstalled.entries()) {
      const metadata = formulaOutdated.get(key("formula", token));
      items.push({
        id: homebrewItemID("formula", token),
        token,
        name: token,
        kind: "formula",
        presentation: "formula",
        installedVersion,
        latestVersion: metadata?.latestVersion,
        isOutdated: Boolean(metadata),
        pinned: metadata?.pinned,
        releaseDate: metadata?.releaseDate
      });
    }

    for (const [token, installedVersion] of caskInstalled.entries()) {
      const metadata = caskOutdated.get(key("cask", token));
      items.push({
        id: homebrewItemID("cask", token),
        token,
        name: token,
        kind: "cask",
        presentation: "cask",
        installedVersion,
        latestVersion: metadata?.latestVersion,
        isOutdated: Boolean(metadata),
        pinned: metadata?.pinned,
        releaseDate: metadata?.releaseDate
      });
    }

    return items.sort(
      (lhs, rhs) => lhs.kind.localeCompare(rhs.kind) || lhs.name.localeCompare(rhs.name)
    );
  }

  parseInstalledVersions(
    output: string,
    kindValue: HomebrewManagedItemKind = "formula"
  ): Map<string, ReturnType<typeof version>> {
    const result = new Map<string, ReturnType<typeof version>>();
    for (const line of output.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [token, ...versions] = trimmed.split(/\s+/u);
      const parsedVersions = versions
        .map((candidate) => version(displayVersion(candidate, kindValue)))
        .filter((candidate) => candidate.raw.length > 0);
      if (token && parsedVersions.length > 0) {
        result.set(
          token,
          parsedVersions.reduce((latest, candidate) => maxVersion(latest, candidate))
        );
      }
    }
    return result;
  }

  private parseOutdatedMetadata(
    raw: string,
    kindValue: HomebrewManagedItemKind
  ): {
    metadata: Map<string, OutdatedMetadata>;
    valid: boolean;
  } {
    const result = new Map<string, OutdatedMetadata>();
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { metadata: result, valid: false };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { metadata: result, valid: false };
    }

    const items = parsed?.[outdatedMetadataKey(kindValue)] ?? [];
    if (!Array.isArray(items)) {
      return { metadata: result, valid: false };
    }

    this.populateOutdatedMetadata(result, items, kindValue);
    return { metadata: result, valid: true };
  }

  private populateOutdatedMetadata(
    result: Map<string, OutdatedMetadata>,
    items: any[],
    kindValue: HomebrewManagedItemKind
  ): void {
    for (const item of items) {
      const token = item?.full_name ?? item?.name ?? item?.token;
      if (typeof token !== "string") {
        continue;
      }
      result.set(key(kindValue, token), {
        latestVersion: version(currentVersion(item, kindValue)),
        releaseDate: parseReleaseDate(item),
        pinned: typeof item?.pinned === "boolean" ? item.pinned : undefined
      });
    }
  }
}

function key(kindValue: HomebrewManagedItemKind, token: string): string {
  return `${kindValue}:${token.toLowerCase()}`;
}

function outdatedMetadataKey(kindValue: HomebrewManagedItemKind): "formulae" | "casks" {
  return kindValue === "formula" ? "formulae" : "casks";
}

function currentVersion(item: any, kindValue: HomebrewManagedItemKind): string {
  const current = item?.current_version ?? item?.current_versions?.[0];
  return displayVersion(current, kindValue);
}

function displayVersion(raw: unknown, kindValue: HomebrewManagedItemKind): string {
  if (typeof raw !== "string") {
    return "";
  }
  if (kindValue !== "cask") {
    return raw;
  }
  return raw.split(",")[0]?.trim() ?? "";
}

function parseReleaseDate(item: any): string | undefined {
  const raw = item?.version_latest_commit_date ?? item?.outdated_since;
  if (typeof raw !== "string") {
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function inventoryWarning({
  updateResult,
  formulaVersions,
  caskVersions,
  formulaOutdated,
  caskOutdated,
  parsedSucceeded
}: {
  updateResult?: CommandResult;
  formulaVersions: CommandResult;
  caskVersions: CommandResult;
  formulaOutdated: CommandResult;
  caskOutdated: CommandResult;
  parsedSucceeded: boolean;
}): string | undefined {
  const failed: string[] = [];
  if (updateResult && !updateResult.success) failed.push("brew update");
  if (!formulaVersions.success) failed.push("formula inventory");
  if (!caskVersions.success) failed.push("cask inventory");
  if (!formulaOutdated.success) failed.push("formula outdated");
  if (!caskOutdated.success) failed.push("cask outdated");
  if (!parsedSucceeded) failed.push("outdated JSON parsing");
  if (failed.length === 0) {
    return undefined;
  }
  return `Homebrew outdated status could not be read reliably (${failed.join(", ")}).`;
}

async function applyInstalledCaskMetadata(
  items: HomebrewManagedItem[],
  result: CommandResult
): Promise<boolean> {
  let casks: any[] = [];
  try {
    const raw = JSON.parse(commandStdout(result));
    if (result.success && Array.isArray(raw?.casks)) casks = raw.casks;
  } catch {
    /* Missing metadata must not borrow an unrelated public catalogue entry. */
  }
  const client = new HomebrewCaskClient();
  let verified = true;
  for (const item of items) {
    if (item.kind !== "cask") continue;
    const matches = casks.filter((cask) => cask?.token === item.token && cask.installed != null);
    const raw = matches.length === 1 ? matches[0] : undefined;
    const entry = raw
      ? client.parseIndex(Buffer.from(JSON.stringify([raw]))).byToken[item.token.toLowerCase()]
      : undefined;
    const candidate = { ...item, fullToken: raw?.full_token, tap: raw?.tap, caskMetadata: entry };
    if (
      typeof candidate.fullToken !== "string" ||
      typeof candidate.tap !== "string" ||
      !homebrewCommandToken(candidate)
    ) {
      item.isOutdated = false;
      item.latestVersion = undefined;
      verified = false;
      continue;
    }
    if (!entry) {
      item.isOutdated = false;
      item.latestVersion = undefined;
      verified = false;
      continue;
    }
    if (entry.installedAppPaths) {
      entry.installedAppPaths = await Promise.all(
        entry.installedAppPaths.map(async (target) => realpath(target).catch(() => target))
      );
    }
    item.pinned = typeof raw.pinned === "boolean" ? raw.pinned : item.pinned;
    item.fullToken = candidate.fullToken;
    item.tap = candidate.tap;
    item.caskMetadata = entry;
    if (item.isOutdated) item.latestVersion = entry.version;
  }
  return verified;
}

function applyInstalledFormulaMetadata(
  items: HomebrewManagedItem[],
  result: CommandResult,
  outdatedJSON: string
): boolean {
  let formulae: any[] = [];
  let outdated: any[] = [];
  try {
    const raw = JSON.parse(commandStdout(result));
    if (result.success && Array.isArray(raw?.formulae)) formulae = raw.formulae;
  } catch {
    /* Unverified installed identity must never borrow catalogue identity. */
  }
  try {
    const raw = JSON.parse(outdatedJSON);
    if (Array.isArray(raw?.formulae)) outdated = raw.formulae;
  } catch {
    /* Outdated parsing status is reported separately. */
  }
  let verified = true;
  for (const item of items) {
    if (item.kind !== "formula") continue;
    const matches = formulae.filter(
      (raw) =>
        Array.isArray(raw?.installed) &&
        raw.installed.length > 0 &&
        (raw.name === item.token ||
          (Array.isArray(raw.oldnames) &&
            (raw.oldnames.includes(item.token) ||
              raw.oldnames.includes(`${raw.tap}/${item.token}`))))
    );
    const raw = matches.length === 1 ? matches[0] : undefined;
    const identity =
      raw &&
      typeof raw.name === "string" &&
      typeof raw.full_name === "string" &&
      typeof raw.tap === "string"
        ? {
            name: raw.name,
            fullName: raw.full_name,
            tap: raw.tap,
            oldNames: Array.isArray(raw.oldnames)
              ? raw.oldnames.filter((name: unknown): name is string => typeof name === "string")
              : []
          }
        : undefined;
    if (!identity || !homebrewCommandToken({ ...item, formulaIdentity: identity })) {
      item.isOutdated = false;
      item.latestVersion = undefined;
      verified = false;
      continue;
    }
    item.formulaIdentity = identity;
    item.formulaIdentityVerified = true;
    item.fullToken = identity.fullName;
    item.tap = identity.tap;
    // Match the proven full name, never strip taps from an outdated record.
    const targets = outdated.filter(
      (entry) => (entry?.full_name ?? entry?.name) === identity.fullName
    );
    const target = targets.length === 1 ? targets[0] : undefined;
    item.isOutdated = Boolean(target);
    item.latestVersion = target ? version(currentVersion(target, "formula")) : undefined;
    item.releaseDate = target ? parseReleaseDate(target) : undefined;
    item.pinned =
      typeof raw.pinned === "boolean"
        ? raw.pinned
        : typeof target?.pinned === "boolean"
          ? target.pinned
          : undefined;
  }
  return verified;
}
