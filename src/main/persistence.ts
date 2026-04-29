import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedSnapshot } from "../shared/domain";
import { defaultPersistedSnapshot } from "../shared/domain";
import { version } from "../shared/version";
export { defaultPersistedSnapshot };

export class SnapshotPersistence {
  private readonly snapshotPath: string;

  constructor(userDataPath: string) {
    this.snapshotPath = path.join(userDataPath, "baseline-snapshot.json");
  }

  async load(): Promise<PersistedSnapshot> {
    try {
      const raw = await readFile(this.snapshotPath, "utf8");
      return normalizeSnapshot(JSON.parse(raw) as Partial<PersistedSnapshot>);
    } catch {
      return defaultPersistedSnapshot();
    }
  }

  async save(snapshot: PersistedSnapshot): Promise<void> {
    await mkdir(path.dirname(this.snapshotPath), { recursive: true });
    await writeFile(this.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
}

function normalizeSnapshot(input: Partial<PersistedSnapshot>): PersistedSnapshot {
  const defaults = defaultPersistedSnapshot();
  return {
    ...defaults,
    ...input,
    apps: (input.apps ?? []).map((app) => ({
      ...app,
      id: app.id ?? app.bundlePath,
      localVersion: version(app.localVersion?.raw)
    })),
    updates: (input.updates ?? []).map((update) => ({
      ...update,
      id: update.id ?? update.appID,
      localVersion: version(update.localVersion?.raw),
      remoteVersion: version(update.remoteVersion?.raw)
    })),
    homebrewItems: (input.homebrewItems ?? []).map((item) => ({
      ...item,
      latestVersion: item.latestVersion ? version(item.latestVersion.raw) : undefined,
      installedVersion: version(item.installedVersion?.raw)
    })),
    refreshIntervalMinutes: clamp(
      input.refreshIntervalMinutes ?? defaults.refreshIntervalMinutes,
      5,
      1440
    )
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
