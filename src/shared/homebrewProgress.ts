import type { HomebrewManagedItemKind } from "./domain";

export type HomebrewMaintenanceRunEvent =
  | { type: "commandStarted"; command: string[] }
  | { type: "outputLine"; command: string[]; line: string }
  | { type: "commandFinished"; command: string[]; success: boolean };

export const HomebrewMaintenanceProgressStage = {
  queued: 0.0,
  downloading: 0.78,
  installing: 0.83,
  finalizing: 0.92,
  completed: 1.0
} as const;

export type HomebrewMaintenanceProgressEvent = {
  token: string;
  kindHint?: HomebrewManagedItemKind;
  kind: { type: "progress"; progress: number } | { type: "completed" } | { type: "failed" };
};

export class HomebrewMaintenanceOutputParser {
  private readonly knownTokens: Set<string>;

  constructor(knownTokens: Iterable<string>) {
    this.knownTokens = new Set([...knownTokens].map((token) => token.toLowerCase()));
  }

  parse(line: string, command: string[]): HomebrewMaintenanceProgressEvent[] {
    const normalizedLine = line.toLowerCase();
    const matchedTokens = this.extractTokens(normalizedLine);
    if (matchedTokens.length === 0) {
      return [];
    }

    const kindHint = this.kindHint(command);

    if (this.isFailureLine(normalizedLine)) {
      return matchedTokens.map((token) => ({ token, kindHint, kind: { type: "failed" } }));
    }

    if (this.isCompletionLine(normalizedLine)) {
      return matchedTokens.map((token) => ({ token, kindHint, kind: { type: "completed" } }));
    }

    const progress = this.progressStage(normalizedLine);
    if (progress === undefined) {
      return [];
    }

    return matchedTokens.map((token) => ({
      token,
      kindHint,
      kind: { type: "progress", progress }
    }));
  }

  private kindHint(command: string[]): HomebrewManagedItemKind | undefined {
    const normalized = command.map((part) => part.toLowerCase());
    if (normalized[0] !== "upgrade") {
      return undefined;
    }
    return normalized.includes("--cask") || normalized.includes("--casks") ? "cask" : "formula";
  }

  private progressStage(line: string): number | undefined {
    if (this.matchesAny(line, ["fetching", "downloading"])) {
      return HomebrewMaintenanceProgressStage.downloading;
    }
    if (this.matchesAny(line, ["pouring", "installing", "upgrading", "extracting", "linking"])) {
      return HomebrewMaintenanceProgressStage.installing;
    }
    if (this.matchesAny(line, ["purging files", "cleanup", "cleaning"])) {
      return HomebrewMaintenanceProgressStage.finalizing;
    }
    if (this.matchesAny(line, ["queued", "queue", "starting"])) {
      return HomebrewMaintenanceProgressStage.queued;
    }
    return undefined;
  }

  private isCompletionLine(line: string): boolean {
    return this.matchesAny(line, [
      "is up-to-date",
      "already installed",
      "was successfully installed",
      "purging files for version",
      "🍺"
    ]);
  }

  private isFailureLine(line: string): boolean {
    return this.matchesAny(line, ["error:", "failed", "failed!", "failed to"]);
  }

  private matchesAny(line: string, terms: string[]): boolean {
    return terms.some((term) => line.includes(term));
  }

  private extractTokens(line: string): string[] {
    return [...this.knownTokens]
      .filter((token) => this.containsToken(token, line))
      .sort((lhs, rhs) => rhs.length - lhs.length || lhs.localeCompare(rhs));
  }

  private containsToken(token: string, line: string): boolean {
    if (!token) {
      return false;
    }

    let index = line.indexOf(token);
    while (index !== -1) {
      const before = index === 0 ? undefined : line[index - 1];
      const after = line[index + token.length];
      const validLeft = before === undefined || this.isBoundaryCharacter(before);
      let validRight = after === undefined || this.isBoundaryCharacter(after);

      if (!validRight && after === "-" && line[index + token.length + 1] === "-") {
        validRight = true;
      }

      if (validLeft && validRight) {
        return true;
      }

      index = line.indexOf(token, index + token.length);
    }

    return false;
  }

  private isBoundaryCharacter(character: string): boolean {
    if (/^[a-z0-9]$/i.test(character)) {
      return false;
    }
    return !["@", "+", "-", "_", "."].includes(character);
  }
}
