import type {
  AppRecord,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem,
  UpdateRecord
} from "./domain";

export function homebrewItemHasAppRepresentation(
  item: Pick<HomebrewManagedItem, "kind" | "token"> &
    Partial<Pick<HomebrewManagedItem, "name"> & Pick<HomebrewCaskDiscoveryItem, "displayName">>,
  apps: AppRecord[],
  updatesByAppID: Map<string, UpdateRecord>
): boolean {
  if (!isCask(item.kind)) {
    return false;
  }

  const identifiers = homebrewItemIdentifiers(item);
  return apps.some((app) => {
    const update = updatesByAppID.get(app.id);
    if (update?.homebrewToken && identifiers.has(normalizedHomebrewAppName(update.homebrewToken))) {
      return true;
    }

    const appCandidates = normalizedAppCandidates(app);
    return [...identifiers].some((identifier) => appCandidates.has(identifier));
  });
}

export function homebrewItemMatchesApp(
  item: Pick<HomebrewManagedItem, "kind" | "token"> &
    Partial<Pick<HomebrewManagedItem, "name"> & Pick<HomebrewCaskDiscoveryItem, "displayName">>,
  apps: AppRecord[]
): boolean {
  if (!isCask(item.kind)) {
    return false;
  }

  const identifiers = homebrewItemIdentifiers(item);
  return apps.some((app) =>
    [...identifiers].some((identifier) => normalizedAppCandidates(app).has(identifier))
  );
}

export function homebrewItemIdentifiers(
  item: Pick<HomebrewManagedItem, "token"> &
    Partial<Pick<HomebrewManagedItem, "name"> & Pick<HomebrewCaskDiscoveryItem, "displayName">>
): Set<string> {
  return new Set(
    [item.token, item.name, item.displayName]
      .filter((value): value is string => Boolean(value))
      .map(normalizedHomebrewAppName)
  );
}

export function normalizedAppCandidates(app: AppRecord): Set<string> {
  const fileName = app.bundlePath
    .split("/")
    .pop()
    ?.replace(/\.app$/iu, "");
  const candidates = [app.displayName, app.bundleIdentifier, fileName]
    .filter((value): value is string => Boolean(value))
    .map(normalizedHomebrewAppName);
  return new Set(candidates.flatMap((value) => [value, value.replace(/^com/u, "")]));
}

export function normalizedHomebrewAppName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function isCask(kind: string): boolean {
  return kind.toLowerCase() === "cask";
}
