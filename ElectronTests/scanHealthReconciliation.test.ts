// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// @vitest-environment node
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile, readdir } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { BundleScannerClient, testingExports } from "../src/main/bundleScanner";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import {
  defaultPersistedSnapshot,
  emptyHomebrewCaskIndex,
  emptyHomebrewFormulaIndex,
  type AppRecord
} from "../src/shared/domain";
import { version } from "../src/shared/version";
const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("electron", () => ({
  app: { getFileIcon: async () => ({ isEmpty: () => true }) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}));
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  const homedir = () => fixture.home || original.homedir();
  return { ...original, homedir, default: { ...original, homedir } };
});
const owned: { root: string; store?: UpdateStore }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  fixture.home = "";
  for (const { root, store } of owned.splice(0)) {
    await store?.prepareToQuit();
    await rm(root, { recursive: true, force: true });
  }
});
function record(bundlePath: string): AppRecord {
  return {
    id: bundlePath,
    bundlePath,
    displayName: "Utility",
    localVersion: version("1"),
    sourceHint: "unknown"
  };
}
async function app(bundlePath: string) {
  await mkdir(`${bundlePath}/Contents`, { recursive: true });
  await writeFile(
    `${bundlePath}/Contents/Info.plist`,
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>Utility</string><key>CFBundleIdentifier</key><string>test.utility</string><key>CFBundleShortVersionString</key><string>1</string></dict></plist>'
  );
}
async function storeFixture(
  root: string,
  directories: string[],
  apps: AppRecord[] = [],
  ignore = false
) {
  const store = new UpdateStore({
    persistence: new SnapshotPersistence(`${root}/state`),
    persisted: {
      ...defaultPersistedSnapshot(),
      autoRefreshEnabled: false,
      apps,
      ignoredIDs: ignore ? apps.map((app) => app.id) : []
    },
    openExternalURL: async () => false,
    openAppBundle: async () => {},
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    },
    runBrewCommand: async () => ({ success: false, status: 1, output: "" }),
    runMasCommand: async () => ({ success: false, status: 1, output: "" }),
    clients: {
      scanner: new BundleScannerClient(),
      appStore: { lookupOutcome: async () => ({ type: "completed" }) },
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
          outdatedDetectionSucceededByKind: { formula: true, cask: true }
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
  (store as unknown as { scanDirectories(): string[] }).scanDirectories = () => directories;
  owned.find((item) => item.root === root)!.store = store;
  return store;
}
async function rootFixture() {
  const root = await mkdtemp("/tmp/baseline-scan-health-");
  owned.push({ root });
  return root;
}
it("removes an unrelated absent app despite an unsupported empty .app entry in a readable root", async () => {
  const root = await rootFixture();
  const directory = `${root}/Apps`;
  await app(`${directory}/Good.app`);
  await mkdir(`${directory}/Unsupported.app`);
  const store = await storeFixture(root, [directory], [record(`${directory}/Removed.app`)]);
  await store.refresh(false);
  expect(store.getSnapshot().apps.map((app) => app.bundlePath)).toEqual([`${directory}/Good.app`]);
  expect(store.getSnapshot().lastRefreshNoticeMessage).toBeUndefined();
});
it("does not duplicate a known installation found through an alternate root, or lose its ignore preference", async () => {
  const root = await rootFixture();
  const directory = `${root}/Apps`,
    alias = `${root}/Alias`;
  await app(`${directory}/Utility.app`);
  await symlink(directory, alias);
  const read = readdir;
  vi.spyOn(testingExports.directoryRuntime, "readdir").mockImplementation(((
    input: string,
    options: never
  ) =>
    input === directory
      ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
      : read(input, options)) as typeof readdir);
  const store = await storeFixture(
    root,
    [directory, alias],
    [record(`${directory}/Utility.app`)],
    true
  );
  await store.refresh(false);
  const snapshot = store.getSnapshot();
  expect(snapshot.apps).toHaveLength(1);
  expect(snapshot.ignoredIDs).toContain(snapshot.apps[0]!.id);
  expect(snapshot.apps[0]!.bundlePath).toBe(`${alias}/Utility.app`);
  const fingerprint = snapshot.apps[0]!.providerFingerprint;
  await store.refresh(false);
  expect(store.getSnapshot().apps[0]!.id).toBe(`${directory}/Utility.app`);
  expect(store.getSnapshot().ignoredIDs).toContain(store.getSnapshot().apps[0]!.id);
  await writeFile(
    `${directory}/Utility.app/Contents/Info.plist`,
    "<plist><dict><key>CFBundleName</key><string>Replacement</string><key>CFBundleIdentifier</key><string>test.replacement</string><key>CFBundleShortVersionString</key><string>2</string><key>SUFeedURL</key><string>https://example.com/replacement.xml</string></dict></plist>"
  );
  await store.refresh(false);
  expect(store.getSnapshot().apps[0]).toMatchObject({
    id: `${directory}/Utility.app`,
    bundleIdentifier: "test.replacement",
    sourceHint: "sparkle",
    localVersion: version("2")
  });
  expect(store.getSnapshot().apps[0]!.providerFingerprint).not.toBe(fingerprint);
  expect(store.getSnapshot().ignoredIDs).toContain(store.getSnapshot().apps[0]!.id);
});
it("does not warn for a truly absent conventional optional home Applications folder", async () => {
  const root = await rootFixture();
  fixture.home = `${root}/Home`;
  await mkdir(fixture.home);
  const store = await storeFixture(root, [`${fixture.home}/Applications`]);
  await store.refresh(false);
  expect(store.getSnapshot().apps).toEqual([]);
  expect(store.getSnapshot().lastRefreshNoticeMessage).toBeUndefined();
});
it("retains unavailable custom-root evidence when its missing path yields ENOENT", async () => {
  const root = await rootFixture();
  const directory = `${root}/UnavailableVolume/Apps`;
  const previous = record(`${directory}/Utility.app`);
  const store = await storeFixture(root, [directory], [previous]);
  await store.refresh(false);
  expect(store.getSnapshot().apps).toEqual([previous]);
  expect(store.getSnapshot().updates).toEqual([]);
  expect(store.getSnapshot().lastRefreshNoticeMessage).toContain("could not");
});
it("retains an unavailable optional home folder when an existing symlink target is missing", async () => {
  const root = await rootFixture();
  fixture.home = `${root}/Home`;
  await mkdir(fixture.home);
  const directory = `${fixture.home}/Applications`;
  await symlink(`${root}/OfflineVolume/Apps`, directory);
  const previous = record(`${directory}/Utility.app`);
  const store = await storeFixture(root, [directory], [previous]);
  await store.refresh(false);
  expect(store.getSnapshot().apps).toEqual([previous]);
  expect(store.getSnapshot().updates).toEqual([]);
  expect(store.getSnapshot().lastRefreshNoticeMessage).toContain("could not");
});

it("uses a prior current bundle path rather than its unavailable stable ID for canonical continuity", async () => {
  const root = await rootFixture();
  const actual = `${root}/Actual`;
  const alias = `${root}/CurrentAlias`;
  await app(`${actual}/Utility.app`);
  await symlink(actual, alias);
  const previous = {
    ...record(`${alias}/Utility.app`),
    id: `${root}/NoLongerPresentAlias/Utility.app`
  };
  const store = await storeFixture(root, [alias], [previous], true);
  await store.refresh(false);
  const snapshot = store.getSnapshot();
  expect(snapshot.apps).toHaveLength(1);
  expect(snapshot.apps[0]!.id).toBe(previous.id);
  expect(snapshot.apps[0]!.bundlePath).toBe(`${alias}/Utility.app`);
  expect(snapshot.ignoredIDs).toContain(snapshot.apps[0]!.id);
});
it("does not transfer identity between distinct installations having matching app metadata", async () => {
  const root = await rootFixture();
  const oldRoot = `${root}/Old`,
    freshRoot = `${root}/Fresh`;
  await app(`${oldRoot}/Utility.app`);
  await app(`${freshRoot}/Utility.app`);
  const read = readdir;
  vi.spyOn(testingExports.directoryRuntime, "readdir").mockImplementation(((
    input: string,
    options: never
  ) =>
    input === oldRoot
      ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
      : read(input, options)) as typeof readdir);
  const previous = record(`${oldRoot}/Utility.app`);
  const store = await storeFixture(root, [oldRoot, freshRoot], [previous], true);
  await store.refresh(false);
  const snapshot = store.getSnapshot();
  expect(snapshot.apps).toHaveLength(2);
  expect(snapshot.ignoredIDs).toContain(previous.id);
  expect(snapshot.ignoredIDs).not.toContain(`${freshRoot}/Utility.app`);
});
it("collapses pre-existing duplicate aliases without losing an ignored proven installation", async () => {
  const root = await rootFixture();
  const actual = `${root}/Actual`,
    alias = `${root}/Alias`;
  await app(`${actual}/Utility.app`);
  await symlink(actual, alias);
  const read = readdir;
  vi.spyOn(testingExports.directoryRuntime, "readdir").mockImplementation(((
    input: string,
    options: never
  ) =>
    input === actual
      ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
      : read(input, options)) as typeof readdir);
  const store = await storeFixture(
    root,
    [actual, alias],
    [record(`${alias}/Utility.app`), record(`${actual}/Utility.app`)]
  );
  await store.toggleIgnoredApp(`${actual}/Utility.app`);
  await store.refresh(false);
  const snapshot = store.getSnapshot();
  expect(snapshot.apps).toHaveLength(1);
  expect(snapshot.ignoredIDs).toContain(snapshot.apps[0]!.id);
});

it("keeps malformed bundle metadata separate from required metadata read failures", async () => {
  const root = await rootFixture();
  const directory = `${root}/Apps`;
  await app(`${directory}/Malformed.app`);
  await writeFile(`${directory}/Malformed.app/Contents/Info.plist`, "not a plist");
  const previous = record(`${directory}/Removed.app`);
  const store = await storeFixture(root, [directory], [previous]);
  await store.refresh(false);
  expect(store.getSnapshot().apps).toEqual([]);
  expect(store.getSnapshot().lastRefreshNoticeMessage).toBeUndefined();
  const access = testingExports.directoryRuntime.access;
  vi.spyOn(testingExports.directoryRuntime, "access").mockImplementation((input, mode) =>
    String(input).endsWith("Contents/Info.plist")
      ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
      : access(input, mode)
  );
  const health = vi.fn();
  expect(
    await new BundleScannerClient().scanApplications([directory], { onRootRead: health })
  ).toEqual([]);
  expect(health).toHaveBeenCalledWith({ directory, complete: false });
});

it.each(["lstat", "parent"] as const)(
  "keeps an optional root uncertain when its %s probe fails",
  async (probe) => {
    const root = await rootFixture();
    fixture.home = `${root}/Home`;
    await mkdir(fixture.home);
    const directory = `${fixture.home}/Applications`;
    if (probe === "lstat")
      vi.spyOn(testingExports.directoryRuntime, "lstat").mockRejectedValue(
        Object.assign(new Error("denied"), { code: "EACCES" })
      );
    else {
      const read = readdir;
      vi.spyOn(testingExports.directoryRuntime, "readdir").mockImplementation(((
        input: string,
        options: never
      ) =>
        input === fixture.home
          ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
          : read(input, options)) as typeof readdir);
    }
    const previous = record(`${directory}/Utility.app`);
    const store = await storeFixture(root, [directory], [previous]);
    await store.refresh(false);
    expect(store.getSnapshot().apps).toEqual([previous]);
    expect(store.getSnapshot().lastRefreshNoticeMessage).toContain("could not");
  }
);

it("retains prior app evidence when actual required bundle metadata is unreadable", async () => {
  const root = await rootFixture();
  const directory = `${root}/Apps`;
  const unreadable = `${directory}/Unreadable.app`;
  await app(unreadable);
  await app(`${directory}/Good.app`);
  const previous = record(unreadable);
  const store = await storeFixture(root, [directory], [previous]);
  await chmod(`${unreadable}/Contents`, 0);
  try {
    await store.refresh(false);
    const snapshot = store.getSnapshot();
    expect(snapshot.apps.some((app) => app.id === previous.id)).toBe(true);
    expect(snapshot.updates).toEqual([]);
    expect(snapshot.lastRefreshNoticeMessage).toContain("could not");
  } finally {
    await chmod(`${unreadable}/Contents`, 0o700);
  }
});

it.each([
  ["lstat", "caller"],
  ["lstat", "deadline"],
  ["parent", "caller"],
  ["parent", "deadline"]
] as const)("bounds and cancels the optional-root %s probe on %s abort", async (probe, cause) => {
  const root = await rootFixture();
  fixture.home = `${root}/Home`;
  await mkdir(fixture.home);
  const directory = `${fixture.home}/Applications`;
  const caller = new AbortController();
  const deadline = new AbortController();
  let started = false;
  let reject!: (error: Error) => void;
  const blocked = new Promise<never>((_, fail) => {
    reject = fail;
  });
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    started ? deadline.signal : originalTimeout(ms)
  );
  if (probe === "lstat")
    vi.spyOn(testingExports.directoryRuntime, "lstat").mockImplementation(() => {
      started = true;
      return blocked;
    });
  else {
    const read = readdir;
    vi.spyOn(testingExports.directoryRuntime, "readdir").mockImplementation(((
      input: string,
      options: never
    ) => {
      if (input !== fixture.home) return read(input, options);
      started = true;
      return blocked;
    }) as typeof readdir);
  }
  const health = vi.fn();
  let complete = false;
  let failure: unknown;
  const task = new BundleScannerClient().scanApplications([directory], {
    signal: caller.signal,
    onRootRead: health
  });
  const observed = task.then(
    () => {
      complete = true;
    },
    (error: unknown) => {
      failure = error;
    }
  );
  const reason = new DOMException(
    "probe stopped",
    cause === "deadline" ? "TimeoutError" : "AbortError"
  );
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    (cause === "caller" ? caller : deadline).abort(reason);
    await vi.waitFor(() => expect(complete || failure !== undefined).toBe(true), { timeout: 200 });
    if (cause === "caller") {
      expect(failure).toBe(reason);
      expect(health).not.toHaveBeenCalled();
    } else {
      expect(failure).toBeUndefined();
      expect(health).toHaveBeenCalledWith({ directory, complete: false });
    }
  } finally {
    reject(new Error("late probe failure"));
    await blocked.catch(() => {});
    await observed;
  }
});

it("preserves Ignore when a duplicated alias disappears only because healthy overlapping roots deduplicate it", async () => {
  const root = await rootFixture();
  const actual = `${root}/Actual`,
    alias = `${root}/Alias`;
  await app(`${actual}/Utility.app`);
  await symlink(actual, alias);
  const store = await storeFixture(
    root,
    [actual, alias],
    [record(`${actual}/Utility.app`), record(`${alias}/Utility.app`)]
  );
  await store.toggleIgnoredApp(`${alias}/Utility.app`);
  await store.refresh(false);
  const snapshot = store.getSnapshot();
  expect(snapshot.apps).toHaveLength(1);
  expect(snapshot.ignoredIDs).toContain(snapshot.apps[0]!.id);
});

it.each(["Contents", "Wrapper"])(
  "skips an unsupported non-directory %s layout without retaining unrelated absent apps",
  async (component) => {
    const root = await rootFixture();
    const directory = `${root}/Apps`;
    await app(`${directory}/Good.app`);
    await mkdir(`${directory}/Unsupported.app`);
    await writeFile(`${directory}/Unsupported.app/${component}`, "not a directory");
    const store = await storeFixture(root, [directory], [record(`${directory}/Removed.app`)]);
    await store.refresh(false);
    expect(store.getSnapshot().apps.map((app) => app.bundlePath)).toEqual([
      `${directory}/Good.app`
    ]);
    expect(store.getSnapshot().lastRefreshNoticeMessage).toBeUndefined();
  }
);

it("does not confirm absence when a required plist becomes unreadable after the access preflight", async () => {
  const root = await rootFixture();
  const directory = `${root}/Apps`;
  const unreadable = `${directory}/Unreadable.app`;
  await app(unreadable);
  await app(`${directory}/Good.app`);
  const originalAccess = testingExports.directoryRuntime.access;
  let changed = false;
  vi.spyOn(testingExports.directoryRuntime, "access").mockImplementation(async (input, mode) => {
    await originalAccess(input, mode);
    if (input === `${unreadable}/Contents/Info.plist` && !changed) {
      changed = true;
      await chmod(`${unreadable}/Contents`, 0);
    }
  });
  const previous = record(unreadable);
  const store = await storeFixture(root, [directory], [previous]);
  try {
    await store.refresh(false);
    const snapshot = store.getSnapshot();
    expect(changed).toBe(true);
    expect(snapshot.apps.some((app) => app.id === previous.id)).toBe(true);
    expect(snapshot.lastRefreshNoticeMessage).toContain("could not");
  } finally {
    await chmod(`${unreadable}/Contents`, 0o700);
  }
});
