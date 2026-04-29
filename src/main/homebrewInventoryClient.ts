import type { HomebrewManagedItem, HomebrewManagedItemKind } from "../shared/domain";
import { homebrewItemID } from "../shared/domain";
import { version } from "../shared/version";
import { runBrewCommand } from "./commandRunner";

type OutdatedMetadata = {
  latestVersion: ReturnType<typeof version>;
  releaseDate?: string;
};

export class HomebrewInventoryClient {
  private readonly parser = new HomebrewInventoryParser();

  async fetchInventory(): Promise<HomebrewManagedItem[]> {
    const [formulaVersions, caskVersions, formulaOutdated, caskOutdated] = await Promise.all([
      runBrewCommand(["list", "--formula", "--versions"]),
      runBrewCommand(["list", "--cask", "--versions"]),
      runBrewCommand(["outdated", "--formula", "--json=v2"]),
      runBrewCommand(["outdated", "--cask", "--greedy", "--json=v2"])
    ]);

    return this.parser.buildInventory(
      formulaVersions.output,
      caskVersions.output,
      formulaOutdated.output || "{}",
      caskOutdated.output || "{}"
    );
  }
}

export class HomebrewInventoryParser {
  buildInventory(
    formulaVersionsOutput: string,
    caskVersionsOutput: string,
    formulaOutdatedJSON: string,
    caskOutdatedJSON: string
  ): HomebrewManagedItem[] {
    const formulaInstalled = this.parseInstalledVersions(formulaVersionsOutput);
    const caskInstalled = this.parseInstalledVersions(caskVersionsOutput);
    const formulaOutdated = this.parseOutdatedMetadata(formulaOutdatedJSON);
    const caskOutdated = this.parseOutdatedMetadata(caskOutdatedJSON);
    const items: HomebrewManagedItem[] = [];

    for (const [token, installedVersion] of formulaInstalled.entries()) {
      const metadata = formulaOutdated.get(key("formula", token));
      items.push({
        id: homebrewItemID("formula", token),
        token,
        name: token,
        kind: "formula",
        installedVersion,
        latestVersion: metadata?.latestVersion,
        isOutdated: Boolean(metadata),
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
        installedVersion,
        latestVersion: metadata?.latestVersion,
        isOutdated: Boolean(metadata),
        releaseDate: metadata?.releaseDate
      });
    }

    return items.sort(
      (lhs, rhs) => lhs.kind.localeCompare(rhs.kind) || lhs.name.localeCompare(rhs.name)
    );
  }

  parseInstalledVersions(output: string): Map<string, ReturnType<typeof version>> {
    const result = new Map<string, ReturnType<typeof version>>();
    for (const line of output.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [token, ...versions] = trimmed.split(/\s+/u);
      if (token) {
        result.set(token, version(versions.at(-1)));
      }
    }
    return result;
  }

  private parseOutdatedMetadata(raw: string): Map<string, OutdatedMetadata> {
    const result = new Map<string, OutdatedMetadata>();
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return result;
    }

    this.populateOutdatedMetadata(result, parsed?.formulae ?? [], "formula");
    this.populateOutdatedMetadata(result, parsed?.casks ?? [], "cask");
    return result;
  }

  private populateOutdatedMetadata(
    result: Map<string, OutdatedMetadata>,
    items: any[],
    kindValue: HomebrewManagedItemKind
  ): void {
    for (const item of items) {
      const token = item?.name ?? item?.token;
      if (typeof token !== "string") {
        continue;
      }
      result.set(key(kindValue, token), {
        latestVersion: version(currentVersion(item)),
        releaseDate: parseReleaseDate(item)
      });
    }
  }
}

function key(kindValue: HomebrewManagedItemKind, token: string): string {
  return `${kindValue}:${token.toLowerCase()}`;
}

function currentVersion(item: any): string {
  const current = item?.current_version ?? item?.current_versions?.[0];
  return typeof current === "string" ? current : "";
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
