// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BundleScannerClient, testingExports } from "../src/main/bundleScanner";
import { macOSManagedPath } from "../src/main/macOSManagedApps";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import { testingExports as reconciliationTestingExports } from "../src/main/scanReconciliation";
import { trayUpdateTitle } from "../src/main/trayStatus";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type AppRecord,
  type PersistedSnapshot
} from "../src/shared/domain";

vi.mock("electron", () => ({
  app: { getFileIcon: async () => ({ isEmpty: () => true }) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}));
const owned: { root: string; stores: UpdateStore[] }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { root, stores } of owned.splice(0)) {
    for (const store of stores) await store.prepareToQuit();
    await rm(root, { recursive: true, force: true });
  }
});

const systemPaths = [
  "/System/Applications/Utility.app",
  "/System/Library/CoreServices/Applications/Utility.app",
  "/System/Cryptexes/App/System/Applications/Utility.app",
  "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Utility.app"
];
describe("macOS-serviced locations", () => {
  it.each(systemPaths)("recognizes the canonical system location %s", (value) =>
    expect(macOSManagedPath(value)).toBe(value)
  );
  it.each([
    undefined,
    true,
    "/Applications/Utility.app",
    "/tmp/System/Applications/Utility.app",
    "/System/ApplicationsExtra/Utility.app",
    "/System/Applications/../../Applications/Utility.app",
    "/System/Applications/Utility.app/Contents",
    "/System/Applications/Utility.app\0",
    "/System/Volumes/Preboot/Other/System/Applications/Utility.app"
  ])("does not invent system management from %s", (value) =>
    expect(macOSManagedPath(value)).toBeUndefined()
  );
});

async function app(path: string, id = "org.example.utility", receipt = false) {
  await mkdir(`${path}/Contents`, { recursive: true });
  await writeFile(
    `${path}/Contents/Info.plist`,
    `<plist version="1.0"><dict><key>CFBundleName</key><string>System Utility</string><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>1</string></dict></plist>`
  );
  if (receipt) {
    await mkdir(`${path}/Contents/_MASReceipt`);
    await writeFile(`${path}/Contents/_MASReceipt/receipt`, "fixture");
  }
}
async function fixture() {
  const root = await mkdtemp("/tmp/baseline-system-management-");
  const entry = { root, stores: [] as UpdateStore[] };
  owned.push(entry);
  const apps = `${root}/Apps`;
  await mkdir(apps);
  const canonical = new Map<string, string>();
  // The real scanner traverses actual bundles and aliases. Only the canonical
  // namespace is virtualized because tests cannot write the protected OS volume.
  const resolve = async (value: Parameters<typeof realpath>[0]) => {
    const resolved = await realpath(value);
    return canonical.get(resolved) ?? resolved;
  };
  vi.spyOn(testingExports.directoryRuntime, "realpath").mockImplementation(resolve);
  vi.spyOn(reconciliationTestingExports.identityRuntime, "realpath").mockImplementation(resolve);
  const lookup = vi.fn(async (id: string) =>
    id === "com.apple.example.editor"
      ? {
          type: "completed" as const,
          providerFound: true,
          checkedAt: "2026-10-19T00:00:00Z",
          value: {
            remoteVersion: { raw: "2" },
            updateURL: "https://example.org/update",
            appStoreItemID: 123
          }
        }
      : { type: "completed" as const, providerFound: false, checkedAt: "2026-10-19T00:00:00Z" }
  );
  const brew = vi.fn(async () => ({ success: true, status: 0, output: "" }));
  const mas = vi.fn(async () => ({ success: true, status: 0, output: "" }));
  const open = vi.fn(async () => {});
  const persistence = new SnapshotPersistence(`${root}/State`);
  const create = (persisted: PersistedSnapshot = defaultPersistedSnapshot()) => {
    const store = new UpdateStore({
      persistence,
      persisted: { ...persisted, autoRefreshEnabled: false },
      openExternalURL: async () => false,
      openAppBundle: open,
      profileStatsIntegrity: { verifyOrInitialize: async (s) => s, seal: async (s) => s },
      runBrewCommand: brew,
      runMasCommand: mas,
      clients: {
        scanner: new BundleScannerClient(),
        appStore: { lookupOutcome: lookup },
        sparkle: { lookupOutcome: async () => ({ type: "completed" }) },
        homebrew: {
          fetchIndex: async () => emptyHomebrewCaskIndex,
          lookupUpdate: () => undefined,
          searchCasks: () => []
        },
        homebrewFormula: {
          fetchIndex: async () => emptyHomebrewFormulaIndex,
          searchFormulae: () => []
        },
        homebrewInventory: {
          fetchInventory: async () => ({
            items: [],
            outdatedDetectionSucceeded: true,
            outdatedDetectionSucceededByKind: { formula: true, cask: true },
            inventoryReadSucceededByKind: { formula: true, cask: true }
          })
        },
        selfUpdate: {
          lookup: async (currentVersion, checkedAt) => ({
            available: false,
            currentVersion,
            checkedAt
          })
        }
      }
    });
    (store as unknown as { scanDirectories(): string[] }).scanDirectories = () => [apps];
    entry.stores.push(store);
    return store;
  };
  return { root, apps, canonical, lookup, brew, mas, open, persistence, create };
}
function oldApp(path: string): AppRecord {
  return {
    id: "saved:utility",
    bundlePath: path,
    displayName: "System Utility",
    bundleIdentifier: "org.example.utility",
    sourceHint: "unknown",
    localVersion: { raw: "1" }
  };
}

it.each([systemPaths[0]!, systemPaths[1]!, systemPaths[3]!])(
  "migrates real scanner results at %s without losing saved identity or history",
  async (systemPath) => {
    const f = await fixture();
    const target = `${f.root}/Bundle.app`,
      alias = `${f.apps}/Utility.app`;
    await app(target);
    await symlink(target, alias);
    f.canonical.set(await realpath(target), systemPath);
    const previous = oldApp(alias);
    const saved = {
      ...defaultPersistedSnapshot(),
      apps: [previous],
      updates: [
        {
          id: previous.id,
          appID: previous.id,
          source: "appStore" as const,
          supportLevel: "supported" as const,
          localVersion: { raw: "1" },
          remoteVersion: { raw: "2" },
          appStoreItemID: 123,
          checkedAt: "2026-10-18T00:00:00Z"
        }
      ],
      ignoredIDs: [previous.id],
      appProviderChecks: { [previous.id]: { fingerprint: "old", status: "unresolved" as const } },
      recentlyUpdated: [
        {
          appID: previous.id,
          displayName: previous.displayName,
          source: "appStore" as const,
          id: "history:utility",
          fromVersion: { raw: "0" },
          toVersion: { raw: "1" },
          updatedAt: "2026-10-18T00:00:00Z"
        }
      ]
    };
    saved.profileStats.events = [
      {
        id: "event:history",
        type: "appUpdate",
        targetID: previous.id,
        displayName: previous.displayName,
        channel: "appStore",
        occurredAt: "2026-10-18T00:00:00Z"
      }
    ];
    const store = f.create(saved);
    const observed = [] as ReturnType<UpdateStore["getSnapshot"]>[];
    store.on("snapshot", (snapshot) => observed.push(snapshot));
    await store.refresh(false);
    const state = store.getSnapshot();
    expect(state.apps).toHaveLength(1);
    expect(state.apps[0]).toMatchObject({
      id: previous.id,
      bundlePath: alias,
      macOSManagedPath: systemPath
    });
    expect(f.lookup).not.toHaveBeenCalled();
    expect(state.appProviderChecks).toEqual({});
    expect(state.updates).toEqual([]);
    for (const snapshot of observed.filter((s) => s.apps.some((a) => a.macOSManagedPath))) {
      expect(snapshot.updates.some((u) => u.appID === previous.id)).toBe(false);
      expect(snapshot.appProviderChecks?.[previous.id]).toBeUndefined();
    }
    expect(state.ignoredIDs).toEqual([previous.id]);
    expect(state.profileStats).toEqual(saved.profileStats);
    expect(state.recentlyUpdated).toEqual(saved.recentlyUpdated);
    const reloaded = await f.persistence.load();
    expect(reloaded.apps[0]?.macOSManagedPath).toBe(systemPath);
    expect(reloaded.recentlyUpdated).toEqual(saved.recentlyUpdated);
    const restarted = f.create(reloaded);
    expect(restarted.getSnapshot().apps[0]?.id).toBe(previous.id);
    expect(restarted.getSnapshot().profileStats.events).toEqual(saved.profileStats.events);
    await restarted.refresh(false);
    expect(f.lookup).not.toHaveBeenCalled();
    expect(restarted.getSnapshot().ignoredIDs).toEqual([previous.id]);
    expect(trayUpdateTitle(restarted.getSnapshot())).toBe("✓");
  }
);

it("keeps a saved ignored identity when healthy aliases resolve to the same managed bundle", async () => {
  const f = await fixture();
  const target = `${f.root}/Bundle.app`;
  await app(target);
  const aliases = [`${f.apps}/First.app`, `${f.apps}/Second.app`];
  for (const alias of aliases) await symlink(target, alias);
  f.canonical.set(await realpath(target), systemPaths[1]!);
  const previous = oldApp(aliases[1]!);
  const store = f.create({
    ...defaultPersistedSnapshot(),
    apps: [previous],
    ignoredIDs: [previous.id]
  });
  await store.refresh(false);
  expect(store.getSnapshot().apps).toHaveLength(1);
  expect(store.getSnapshot().apps[0]).toMatchObject({
    id: previous.id,
    macOSManagedPath: systemPaths[1]
  });
  expect(store.getSnapshot().ignoredIDs).toEqual([previous.id]);
  expect(f.lookup).not.toHaveBeenCalled();
});

it("keeps standalone Apple-ID App Store apps actionable and misleading names unresolved", async () => {
  const f = await fixture();
  await app(`${f.apps}/Editor.app`, "com.apple.example.editor", true);
  await app(`${f.apps}/Utility.app`, "com.apple.example.utility");
  const store = f.create();
  await store.refresh(false);
  const s = store.getSnapshot();
  expect(s.apps.every((a) => !a.macOSManagedPath)).toBe(true);
  expect(f.lookup).toHaveBeenCalledTimes(2);
  expect(s.updates).toHaveLength(1);
  expect(s.updates[0]?.source).toBe("appStore");
  expect(s.appProviderChecks?.[`${f.apps}/Utility.app`]?.status).toBe("unresolved");
  expect(trayUpdateTitle({ ...s, updates: [] })).toBe("");
});

it("retains evidence through a broken alias, then rechecks a recovered standalone source", async () => {
  const f = await fixture();
  const target = `${f.root}/Managed.app`,
    standalone = `${f.root}/Standalone.app`,
    alias = `${f.apps}/Utility.app`;
  await app(target);
  await app(standalone, "com.apple.example.editor", true);
  await symlink(target, alias);
  f.canonical.set(await realpath(target), systemPaths[1]!);
  const saved = {
    ...defaultPersistedSnapshot(),
    apps: [oldApp(alias)],
    ignoredIDs: ["saved:utility"]
  };
  const store = f.create(saved);
  await store.refresh(false);
  const first = store.getSnapshot().apps[0]!;
  expect(first.macOSManagedPath).toBe(systemPaths[1]);
  await unlink(alias);
  await symlink(`${f.root}/Missing.app`, alias);
  await store.refresh(false);
  const unavailable = store.getSnapshot();
  expect(unavailable.apps[0]).toEqual(first);
  expect(unavailable.lastRefreshNoticeMessage).toContain("could not");
  expect(unavailable.ignoredIDs).toEqual([first.id]);
  expect(trayUpdateTitle(unavailable)).toBe("");
  expect(f.lookup).not.toHaveBeenCalled();
  await unlink(alias);
  await symlink(standalone, alias);
  await store.refresh(false);
  const recovered = store.getSnapshot();
  expect(recovered.apps[0]).toMatchObject({
    id: first.id,
    bundlePath: alias,
    sourceHint: "appStore"
  });
  expect(recovered.apps[0]?.macOSManagedPath).toBeUndefined();
  expect(recovered.apps[0]?.providerFingerprint).not.toBe(first.providerFingerprint);
  expect(recovered.appProviderChecks?.[first.id]?.status).toBe("checked");
  expect(recovered.updates[0]?.appID).toBe(first.id);
  expect(recovered.ignoredIDs).toEqual([first.id]);
  expect(f.lookup).toHaveBeenCalledTimes(1);
});

it("does not turn an unresolved canonical read into new system-management evidence", async () => {
  const f = await fixture();
  const target = `${f.apps}/Utility.app`;
  await app(target);
  const store = f.create({ ...defaultPersistedSnapshot(), apps: [oldApp(target)] });
  testingExports.directoryRuntime.realpath = vi.fn(async () => {
    throw Object.assign(new Error("unavailable"), { code: "EACCES" });
  });
  await store.refresh(false);
  expect(store.getSnapshot().apps).toEqual([oldApp(target)]);
  expect(store.getSnapshot().apps[0]?.macOSManagedPath).toBeUndefined();
  expect(store.getSnapshot().lastRefreshNoticeMessage).toContain("could not");
  expect(f.lookup).not.toHaveBeenCalled();
  expect(trayUpdateTitle(store.getSnapshot())).toBe("");
});

it("drops obsolete cached provider routes after relaunch without deleting history or admitting updates", async () => {
  const f = await fixture();
  const record = { ...oldApp(`${f.apps}/Utility.app`), macOSManagedPath: systemPaths[1] };
  const saved = {
    ...defaultPersistedSnapshot(),
    useMasForAppStoreUpdates: true,
    apps: [record],
    ignoredIDs: [record.id],
    appProviderChecks: { [record.id]: { fingerprint: "old", status: "failed" as const } },
    updates: [
      {
        id: record.id,
        appID: record.id,
        source: "appStore" as const,
        supportLevel: "supported" as const,
        localVersion: { raw: "1" },
        remoteVersion: { raw: "2" },
        appStoreItemID: 123,
        checkedAt: "2026-10-19T00:00:00Z"
      }
    ]
  };
  await f.persistence.save(saved);
  const store = f.create(await f.persistence.load());
  expect(store.getSnapshot().apps).toHaveLength(1);
  expect(store.getSnapshot().updates).toEqual([]);
  expect(store.getSnapshot().appProviderChecks).toEqual({});
  expect(store.getSnapshot().ignoredIDs).toEqual([record.id]);
  await store.performAppUpdate(record.id);
  expect(f.mas).not.toHaveBeenCalled();
  expect(f.brew).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});

it("does not suppress ordinary app checks when cached management evidence is malformed", async () => {
  const f = await fixture();
  const bundle = `${f.apps}/Editor.app`;
  await app(bundle, "com.apple.example.editor", true);
  await mkdir(`${f.root}/State`, { recursive: true });
  await writeFile(
    `${f.root}/State/baseline-snapshot.json`,
    JSON.stringify({
      ...defaultPersistedSnapshot(),
      apps: [{ ...oldApp(bundle), macOSManagedPath: true }]
    })
  );
  const loaded = await f.persistence.load();
  expect(loaded.apps[0]?.macOSManagedPath).toBeUndefined();
  const store = f.create(loaded);
  await store.refresh(false);
  expect(f.lookup).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().updates).toHaveLength(1);
});

it("excludes only the managed app while unresolved ordinary coverage still blocks tray success", async () => {
  const f = await fixture();
  const managed = `${f.apps}/Managed.app`,
    ordinary = `${f.apps}/Ordinary.app`;
  await app(managed);
  await app(ordinary, "com.apple.example.ordinary");
  f.canonical.set(await realpath(managed), systemPaths[0]!);
  const store = f.create();
  await store.refresh(false);
  const s = store.getSnapshot();
  expect(f.lookup).toHaveBeenCalledTimes(1);
  expect(s.appProviderChecks?.[managed]).toBeUndefined();
  expect(s.appProviderChecks?.[ordinary]?.status).toBe("unresolved");
  expect(trayUpdateTitle(s)).toBe("");
});

it("skips an orphan uninstall alias without retaining a deleted sibling or hiding readable additions", async () => {
  const f = await fixture();
  await mkdir(`${f.apps}/Vendor/Tools`, { recursive: true });
  await symlink(`${f.root}/Missing/Uninstall.app`, `${f.apps}/Vendor/Tools/Uninstall.app`);
  const store = f.create({
    ...defaultPersistedSnapshot(),
    apps: [oldApp(`${f.apps}/Deleted.app`)]
  });
  await store.refresh(false);
  expect(store.getSnapshot().apps).toEqual([]);
  expect(store.getSnapshot().lastRefreshNoticeMessage).toBeUndefined();
  expect(trayUpdateTitle(store.getSnapshot())).toBe("✓");
  expect(f.lookup).not.toHaveBeenCalled();
  await app(`${f.apps}/Added.app`, "com.apple.example.editor", true);
  await store.refresh(false);
  const state = store.getSnapshot();
  expect(state.apps.map((a) => a.bundlePath)).toEqual([`${f.apps}/Added.app`]);
  expect(state.updates).toHaveLength(1);
  expect(state.lastRefreshNoticeMessage).toBeUndefined();
  expect(Object.values(state.appProviderChecks ?? {}).map((c) => c.status)).toEqual(["checked"]);
});

it.each([false, true])(
  "retains only a known unavailable alias across sibling changes, relaunch and recovery (managed=%s)",
  async (managed) => {
    const f = await fixture();
    const target = `${f.root}/Bundle.app`,
      alias = `${f.apps}/Known.app`,
      deleted = `${f.apps}/Deleted.app`,
      added = `${f.apps}/Added.app`;
    await app(target, "com.apple.example.editor", true);
    await app(deleted, "com.apple.example.editor", true);
    await symlink(target, alias);
    const resolved = await realpath(target);
    if (managed) f.canonical.set(resolved, systemPaths[1]!);
    const previous = oldApp(alias);
    const store = f.create({
      ...defaultPersistedSnapshot(),
      apps: [previous],
      ignoredIDs: [previous.id]
    });
    await store.refresh(false);
    const known = store.getSnapshot().apps.find((a) => a.bundlePath === alias)!;
    await rm(target, { recursive: true });
    await rm(deleted, { recursive: true });
    await app(added, "com.apple.example.editor", true);
    f.lookup.mockClear();
    const observations: ReturnType<UpdateStore["getSnapshot"]>[] = [];
    store.on("snapshot", (s) => {
      if (s.apps.some((a) => a.bundlePath === added)) observations.push(s);
    });
    await store.refresh(false);
    const unavailable = store.getSnapshot();
    expect(unavailable.apps.map((a) => a.bundlePath).sort()).toEqual([added, alias].sort());
    expect(unavailable.apps.find((a) => a.id === known.id)).toEqual(known);
    expect(unavailable.ignoredIDs).toContain(previous.id);
    expect(unavailable.lastRefreshNoticeMessage).toContain("Previously found apps have been kept");
    expect(trayUpdateTitle({ ...unavailable, updates: [] })).toBe("");
    expect(f.lookup).toHaveBeenCalledTimes(1);
    for (const s of observations) {
      expect(s.updates.some((u) => u.appID === known.id)).toBe(false);
      expect(s.appProviderChecks?.[known.id]?.status).toBe(managed ? undefined : "failed");
    }
    expect(observations.length).toBeGreaterThan(0);
    const restarted = f.create(await f.persistence.load());
    await restarted.refresh(false);
    expect(restarted.getSnapshot().apps.find((a) => a.id === known.id)).toEqual(known);
    expect(restarted.getSnapshot().ignoredIDs).toContain(previous.id);
    expect(restarted.getSnapshot().lastRefreshNoticeMessage).toContain("could not");
    await app(target, "com.apple.example.editor", true);
    // The same advertised version must follow current readable location evidence.
    f.canonical.set(await realpath(target), systemPaths[1]!);
    await restarted.refresh(false);
    expect(restarted.getSnapshot().apps.find((a) => a.id === known.id)?.macOSManagedPath).toBe(
      systemPaths[1]
    );
    expect(restarted.getSnapshot().lastRefreshNoticeMessage).toBeUndefined();
    f.canonical.delete(await realpath(target));
    await restarted.refresh(false);
    const recovered = restarted.getSnapshot();
    expect(recovered.apps.find((a) => a.id === known.id)?.macOSManagedPath).toBeUndefined();
    expect(recovered.appProviderChecks?.[known.id]?.status).toBe("checked");
    expect(recovered.updates.some((u) => u.appID === known.id)).toBe(true);
    expect(recovered.ignoredIDs).toContain(previous.id);
    const reloaded = f.create(await f.persistence.load());
    expect(
      reloaded.getSnapshot().apps.find((a) => a.id === known.id)?.macOSManagedPath
    ).toBeUndefined();
    expect(reloaded.getSnapshot().ignoredIDs).toContain(previous.id);
  }
);

it("warns for a never-read app entry with denied access without claiming records were retained", async () => {
  const f = await fixture();
  const target = `${f.root}/Bundle.app`,
    alias = `${f.apps}/Uninstall.app`;
  await app(target);
  await symlink(target, alias);
  vi.spyOn(testingExports.directoryRuntime, "stat").mockImplementation(async (value) => {
    if (value === alias) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return stat(value);
  });
  const store = f.create();
  await store.refresh(false);
  expect(store.getSnapshot().apps).toEqual([]);
  expect(store.getSnapshot().lastRefreshNoticeMessage).toContain("could not");
  expect(store.getSnapshot().lastRefreshNoticeMessage).not.toContain("have been kept");
  expect(trayUpdateTitle(store.getSnapshot())).toBe("");
  expect(f.lookup).not.toHaveBeenCalled();
});

it("does not retain a saved app when its alias is proven to target a non-directory replacement", async () => {
  const f = await fixture();
  const target = `${f.root}/Unsupported`,
    alias = `${f.apps}/Utility.app`;
  await writeFile(target, "not an application bundle");
  await symlink(target, alias);
  const store = f.create({ ...defaultPersistedSnapshot(), apps: [oldApp(alias)] });
  await store.refresh(false);
  expect(store.getSnapshot().apps).toEqual([]);
  expect(store.getSnapshot().lastRefreshNoticeMessage).toBeUndefined();
  expect(f.lookup).not.toHaveBeenCalled();
});

it.each(["stat", "realpath"] as const)(
  "keeps %s deadlines local to an app entry and propagates caller cancellation",
  async (operation) => {
    const f = await fixture();
    const target = `${f.root}/Bundle.app`,
      alias = `${f.apps}/A.app`;
    await app(target);
    await symlink(target, alias);
    await app(`${f.apps}/Z.app`);
    for (const cause of ["deadline", "caller"] as const) {
      const caller = new AbortController(),
        deadline = new AbortController();
      let rejectRead!: (error: Error) => void;
      const blocked = new Promise<never>((_, reject) => {
        rejectRead = reject;
      });
      let entered = false,
        deadlineActive = false;
      const block = () => {
        entered = true;
        deadlineActive = true;
        queueMicrotask(() => {
          deadlineActive = false;
        });
        return blocked;
      };
      const runtime = testingExports.directoryRuntime;
      const reader =
        operation === "stat"
          ? vi
              .spyOn(runtime, "stat")
              .mockImplementation((value) => (value === alias && !entered ? block() : stat(value)))
          : vi
              .spyOn(runtime, "realpath")
              .mockImplementation((value) =>
                value === alias && !entered ? block() : realpath(value)
              );
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      const timeoutSpy = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => (deadlineActive ? deadline.signal : timeout(ms)));
      const health = vi.fn();
      const task = new BundleScannerClient().scanApplications([f.apps], {
        signal: caller.signal,
        onRootRead: health
      });
      let records: Awaited<typeof task> | undefined, failure: unknown;
      const observed = task.then(
        (value) => {
          records = value;
        },
        (error: unknown) => {
          failure = error;
        }
      );
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        const reason = Object.assign(new Error(cause), {
          name: cause === "deadline" ? "TimeoutError" : "AbortError"
        });
        (cause === "deadline" ? deadline : caller).abort(reason);
        await vi.waitFor(() => expect(records !== undefined || failure !== undefined).toBe(true));
        if (cause === "caller") {
          expect(failure).toBe(reason);
          expect(health).not.toHaveBeenCalled();
        } else {
          expect(failure).toBeUndefined();
          expect(records?.map((a) => a.bundlePath)).toEqual([`${f.apps}/Z.app`]);
          expect(health).toHaveBeenCalledWith({
            directory: f.apps,
            complete: true,
            unavailableApps: [{ bundlePath: alias, notFound: false }]
          });
        }
      } finally {
        rejectRead(new Error("late app-path read failure"));
        await Promise.allSettled([blocked, task, observed]);
        timeoutSpy.mockRestore();
        reader.mockRestore();
      }
      const recoveredHealth = vi.fn();
      expect(
        await new BundleScannerClient().scanApplications([f.apps], { onRootRead: recoveredHealth })
      ).toHaveLength(2);
      expect(recoveredHealth).toHaveBeenCalledWith({ directory: f.apps, complete: true });
    }
  }
);

it("does not let a cancelled entry read overwrite a successful replacement refresh", async () => {
  const f = await fixture();
  const oldTarget = `${f.root}/Old.app`,
    newTarget = `${f.root}/New.app`,
    alias = `${f.apps}/Utility.app`;
  await app(oldTarget);
  await app(newTarget, "com.apple.example.editor", true);
  await symlink(oldTarget, alias);
  const previous = { ...oldApp(alias), macOSManagedPath: systemPaths[1] };
  const store = f.create({
    ...defaultPersistedSnapshot(),
    apps: [previous],
    ignoredIDs: [previous.id]
  });
  let rejectRead!: (error: Error) => void;
  const blocked = new Promise<never>((_, reject) => {
    rejectRead = reject;
  });
  let entered = false;
  vi.spyOn(testingExports.directoryRuntime, "realpath").mockImplementation((value) => {
    if (value === alias && !entered) {
      entered = true;
      return blocked;
    }
    return realpath(value);
  });
  const first = store.refresh(false);
  const work = [first];
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    await unlink(alias);
    await symlink(newTarget, alias);
    const second = store.refresh(false);
    work.push(second);
    let completed = false;
    const observation = second.then(() => {
      completed = true;
    });
    work.push(observation);
    await vi.waitFor(() => expect(completed).toBe(true));
    const winning = store.getSnapshot();
    expect(winning.apps[0]).toMatchObject({ id: previous.id, sourceHint: "appStore" });
    expect(winning.apps[0]?.macOSManagedPath).toBeUndefined();
    expect(winning.appProviderChecks?.[previous.id]?.status).toBe("checked");
    expect(winning.ignoredIDs).toContain(previous.id);
    expect(winning.lastRefreshNoticeMessage).toBeUndefined();
    rejectRead(new Error("obsolete read failure"));
    await Promise.allSettled(work);
    expect(store.getSnapshot()).toEqual(winning);
  } finally {
    rejectRead(new Error("released during teardown"));
    await Promise.allSettled([blocked, ...work]);
  }
});

it.each([false, true])(
  "reconciles a known unreadable alias through a healthy overlapping root (managed=%s)",
  async (managed) => {
    const f = await fixture();
    const target = `${f.root}/Bundle.app`,
      alias = `${f.apps}/Nested/Known.app`,
      peer = `${f.apps}/Peer.app`,
      removed = `${f.apps}/Nested/Deleted.app`;
    await app(target, "com.apple.example.editor", true);
    await mkdir(`${f.apps}/Nested`);
    await symlink(target, alias);
    await symlink(target, peer);
    if (managed) f.canonical.set(await realpath(target), systemPaths[1]!);
    const previous = oldApp(alias);
    const store = f.create({
      ...defaultPersistedSnapshot(),
      apps: [previous, { ...oldApp(removed), id: "saved:removed" }],
      ignoredIDs: [previous.id]
    });
    (store as unknown as { scanDirectories(): string[] }).scanDirectories = () => [
      f.apps,
      `${f.apps}/Nested`
    ];
    vi.spyOn(testingExports.directoryRuntime, "stat").mockImplementation(async (value) => {
      if (value === alias) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return stat(value);
    });
    await store.refresh(false);
    const state = store.getSnapshot();
    expect(state.apps).toHaveLength(1);
    expect(state.apps[0]).toMatchObject({ id: previous.id, bundlePath: peer });
    expect(Boolean(state.apps[0]?.macOSManagedPath)).toBe(managed);
    expect(state.ignoredIDs).toContain(previous.id);
    expect(state.lastRefreshNoticeMessage).toBeUndefined();
    expect(f.lookup).toHaveBeenCalledTimes(managed ? 0 : 1);
  }
);

it.each(
  ["denied", "deadline"].flatMap((failure) =>
    [false, true].flatMap((peer) => ["1", "2"].map((remote) => ({ failure, peer, remote })))
  )
)(
  "clears an initial $failure after cold overlapping-root recovery (peer=$peer, remote=$remote)",
  async ({ failure, peer, remote }) => {
    const f = await fixture();
    const target = `${f.root}/Bundle.app`,
      nested = `${f.apps}/Nested`,
      alias = `${nested}/Utility.app`,
      other = `${f.apps}/Peer.app`;
    await app(target, "com.apple.example.editor", true);
    await mkdir(nested);
    await symlink(target, alias);
    if (peer) await symlink(target, other);
    f.lookup.mockResolvedValue({
      type: "completed",
      providerFound: true,
      checkedAt: "2026-10-19T00:00:00Z",
      value:
        remote === "2"
          ? {
              remoteVersion: { raw: remote },
              updateURL: "https://example.org/update",
              appStoreItemID: 123
            }
          : undefined
    });
    let attempted = false;
    vi.spyOn(testingExports.directoryRuntime, "stat").mockImplementation(async (value) => {
      if (value === alias && !attempted) {
        attempted = true;
        throw Object.assign(
          new Error("transient app-path read failure"),
          failure === "denied" ? { code: "EACCES" } : { name: "TimeoutError" }
        );
      }
      return stat(value);
    });
    const store = f.create();
    (store as unknown as { scanDirectories(): string[] }).scanDirectories = () => [f.apps, nested];
    await store.refresh(false);
    const state = store.getSnapshot();
    expect(attempted).toBe(true);
    expect(state.apps.map((a) => a.bundlePath)).toEqual([peer ? other : alias]);
    expect(Object.values(state.appProviderChecks ?? {}).map((c) => c.status)).toEqual(["checked"]);
    expect(state.updates).toHaveLength(remote === "2" ? 1 : 0);
    expect(f.lookup).toHaveBeenCalledTimes(1);
    expect(state.lastRefreshNoticeMessage).toBeUndefined();
    expect(trayUpdateTitle(state)).toBe(remote === "2" ? "1\u2009↓" : "✓");
  }
);

it("keeps a cold unreadable alias warning when only a different path can be read", async () => {
  const f = await fixture();
  const target = `${f.root}/Bundle.app`,
    nested = `${f.apps}/Nested`,
    alias = `${nested}/Utility.app`,
    peer = `${f.apps}/Peer.app`;
  await app(target, "com.apple.example.editor", true);
  await mkdir(nested);
  await symlink(target, alias);
  await symlink(target, peer);
  vi.spyOn(testingExports.directoryRuntime, "stat").mockImplementation(async (value) => {
    if (value === alias) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return stat(value);
  });
  const store = f.create();
  (store as unknown as { scanDirectories(): string[] }).scanDirectories = () => [f.apps, nested];
  await store.refresh(false);
  const state = store.getSnapshot();
  expect(state.apps.map((a) => a.bundlePath)).toEqual([peer]);
  expect(state.updates).toHaveLength(1);
  expect(state.lastRefreshNoticeMessage).toContain("could not");
  expect(state.lastRefreshNoticeMessage).not.toContain("have been kept");
  expect(trayUpdateTitle({ ...state, updates: [] })).toBe("");
});
