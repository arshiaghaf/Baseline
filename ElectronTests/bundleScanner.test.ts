// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { Dirent } from "node:fs";
import {
  readdir,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconCache } from "../src/main/iconCache";
import { BundleScannerClient, testingExports } from "../src/main/bundleScanner";

const electronMocks = vi.hoisted(() => ({
  getFileIcon: vi.fn(async () => ({
    isEmpty: () => true,
    resize: () => ({ toDataURL: () => "" })
  })),
  createFromPath: vi.fn(
    (imagePath: string): { isEmpty: () => boolean; resize: () => { toDataURL: () => string } } => {
      void imagePath;
      return {
        isEmpty: () => true,
        resize: () => ({ toDataURL: () => "" })
      };
    }
  )
}));

vi.mock("electron", () => ({
  app: {
    getFileIcon: electronMocks.getFileIcon
  },
  nativeImage: {
    createFromPath: electronMocks.createFromPath
  }
}));

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirs = [];
  electronMocks.getFileIcon.mockReset();
  electronMocks.createFromPath.mockClear();
  testingExports.resetIconRuntime();
  vi.restoreAllMocks();
});

describe("bundle scanner", () => {
  it.each(["caller", "deadline"] as const)(
    "handles %s cancellation during a required metadata read without losing sibling health",
    async (cause) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "baseline-metadata-cancel-"));
      tempDirs.push(root);
      const first = path.join(root, "A.app");
      const healthy = path.join(root, "Z.app");
      for (const appPath of [first, healthy])
        await writeAppPlist(appPath, {
          displayName: path.basename(appPath),
          bundleIdentifier: "com.example.fixture",
          version: "1"
        });
      const caller = new AbortController();
      const deadline = new AbortController();
      let started = false;
      let reject!: (error: Error) => void;
      const blocked = new Promise<never>((_, fail) => {
        reject = fail;
      });
      const access = testingExports.directoryRuntime.access;
      vi.spyOn(testingExports.directoryRuntime, "access").mockImplementation((input, mode) => {
        if (input !== path.join(first, "Contents", "Info.plist")) return access(input, mode);
        started = true;
        return blocked;
      });
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      let metadataDeadlineAssigned = false;
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        if (started && !metadataDeadlineAssigned) {
          metadataDeadlineAssigned = true;
          return deadline.signal;
        }
        return timeout(ms);
      });
      const health = vi.fn();
      const task = new BundleScannerClient().scanApplications([root], {
        signal: caller.signal,
        onRootRead: health
      });
      let completed = false;
      let failure: unknown;
      const observed = task.then(
        () => {
          completed = true;
        },
        (error: unknown) => {
          failure = error;
        }
      );
      const reason = new DOMException(
        "metadata stopped",
        cause === "caller" ? "AbortError" : "TimeoutError"
      );
      try {
        await vi.waitFor(() => expect(started).toBe(true));
        (cause === "caller" ? caller : deadline).abort(reason);
        await vi.waitFor(() => expect(completed || failure !== undefined).toBe(true));
        if (cause === "caller") {
          expect(failure).toBe(reason);
          expect(health).not.toHaveBeenCalled();
        } else {
          expect(failure).toBeUndefined();
          expect((await task).map((app) => app.bundlePath)).toEqual([healthy]);
          expect(health).toHaveBeenCalledWith({
            directory: root,
            complete: true,
            unavailableApps: [{ bundlePath: first, notFound: false }]
          });
        }
      } finally {
        caller.abort();
        reject(new Error("late metadata read failure"));
        await Promise.allSettled([blocked, task, observed]);
      }
    }
  );

  it.each(["APP", "aPp"])(
    "respects .%s package boundaries and name fallback for directories and aliases",
    async (suffix) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "baseline-package-case-"));
      tempDirs.push(root);
      const appPath = path.join(root, "Apps", `Example.${suffix}`);
      await writeAppPlist(appPath, {
        displayName: "Example",
        bundleIdentifier: "com.example.outer",
        version: "1"
      });
      const plistPath = path.join(appPath, "Contents", "Info.plist");
      await writeFile(
        plistPath,
        (await readFile(plistPath, "utf8")).replace(
          /<key>CFBundleDisplayName<\/key>\s*<string>Example<\/string>/,
          ""
        )
      );
      await writeAppPlist(path.join(appPath, "Contents", "Frameworks", "Hidden.app"), {
        displayName: "Hidden",
        bundleIdentifier: "com.example.hidden",
        version: "1"
      });
      const aliases = path.join(root, "Aliases");
      await mkdir(aliases);
      const alias = path.join(aliases, `Linked.${suffix}`);
      await symlink(appPath, alias);
      for (const directories of [
        [path.dirname(appPath), aliases],
        [aliases, path.dirname(appPath)]
      ]) {
        const records = await new BundleScannerClient().scanApplications(directories);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          bundleIdentifier: "com.example.outer",
          displayName: directories[0] === aliases ? "Linked" : "Example"
        });
      }
    }
  );

  it("reads mixed-case wrapped app and Safari extension suffixes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-wrapped-case-"));
    tempDirs.push(root);
    const wrapped = path.join(root, "Wrapped.APP");
    await writeWrappedIOSAppPlist(wrapped, {
      displayName: "Wrapped",
      bundleIdentifier: "com.example.wrapped",
      version: "1"
    });
    await rename(
      path.join(wrapped, "Wrapper", "Wrapped.app"),
      path.join(wrapped, "Wrapper", "Wrapped.aPp")
    );
    const native = path.join(root, "Native.aPp");
    await writeAppPlist(native, {
      displayName: "Native",
      bundleIdentifier: "com.example.native",
      version: "1"
    });
    await writeAppPlist(path.join(native, "Contents", "PlugIns", "Extension.ApPeX"), {
      displayName: "Extension",
      bundleIdentifier: "com.example.extension",
      version: "1",
      extraKeys:
        "<key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.Safari.web-extension</string></dict>"
    });
    const records = await new BundleScannerClient().scanApplications([root]);
    expect(records).toHaveLength(2);
    expect(records.find((app) => app.bundlePath === wrapped)).toMatchObject({
      isIOSAppOnMac: true,
      hasAppStoreEvidence: true
    });
    expect(records.find((app) => app.bundlePath === native)).toMatchObject({
      hasSafariWebExtension: true
    });
  });

  it("distinguishes an unavailable root or nested folder from a successfully empty root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-health-"));
    tempDirs.push(root);
    const nested = path.join(root, "Nested");
    const missing = path.join(root, "Missing");
    await mkdir(nested);
    const read = readdir;
    vi.spyOn(testingExports.directoryRuntime, "readdir").mockImplementation(((
      directory: string,
      options: never
    ) => {
      if (directory === nested)
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      return read(directory, options);
    }) as typeof readdir);
    const health = vi.fn();
    const scanner = new BundleScannerClient();
    expect(await scanner.scanApplications([root, missing], { onRootRead: health })).toEqual([]);
    expect(health.mock.calls.map(([value]) => value)).toEqual([
      { directory: root, complete: false },
      { directory: missing, complete: false }
    ]);
    vi.restoreAllMocks();
    health.mockClear();
    expect(await scanner.scanApplications([nested], { onRootRead: health })).toEqual([]);
    expect(health).toHaveBeenCalledWith({ directory: nested, complete: true });
  });

  it("cancels a blocked directory read without reporting an empty root or continuing traversal", async () => {
    let finish!: (value: never[]) => void;
    const blocked = new Promise<never[]>((resolve) => {
      finish = resolve;
    });
    const read = vi
      .spyOn(testingExports.directoryRuntime, "readdir")
      .mockReturnValue(blocked as ReturnType<typeof readdir>);
    const health = vi.fn();
    const controller = new AbortController();
    const task = new BundleScannerClient().scanApplications(["/blocked", "/next"], {
      signal: controller.signal,
      onRootRead: health
    });
    const reason = new Error("superseded");
    let failure: unknown;
    const observed = task.catch((error: unknown) => {
      failure = error;
    });
    try {
      controller.abort(reason);
      await vi.waitFor(() => expect(failure).toBe(reason), { timeout: 200 });
      expect(health).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      finish([]);
      await blocked;
      await Promise.allSettled([task, observed]);
    }
  });

  it("marks a timed-out root incomplete, continues healthy roots, and observes late IO rejection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-deadline-"));
    tempDirs.push(root);
    let rejectRead!: (reason: Error) => void;
    const blocked = new Promise<never[]>((_resolve, reject) => {
      rejectRead = reject;
    });
    const read = readdir;
    vi.spyOn(testingExports.directoryRuntime, "readdir").mockImplementation(((
      directory: string,
      options: never
    ) => (directory === "/blocked" ? blocked : read(directory, options))) as typeof readdir);
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const health = vi.fn();
    const task = new BundleScannerClient().scanApplications(["/blocked", root], {
      onRootRead: health
    });
    let completed = false;
    const observed = task.then(() => {
      completed = true;
    });
    try {
      expect(testingExports.directoryRuntime.readdir).toHaveBeenCalledWith("/blocked", {
        withFileTypes: true
      });
      deadline.abort(Object.assign(new Error("read deadline"), { name: "TimeoutError" }));
      await vi.waitFor(() => expect(completed).toBe(true), { timeout: 200 });
      expect(await task).toEqual([]);
      expect(health.mock.calls.map(([value]) => value)).toEqual([
        { directory: "/blocked", complete: false },
        { directory: root, complete: true }
      ]);
    } finally {
      rejectRead(new Error("late filesystem failure"));
      await Promise.allSettled([blocked, task, observed]);
    }
  });

  it.each(["platform", "bundle"] as const)(
    "cancels while an optional %s icon read is pending without emitting a completed root",
    async (kind) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-icon-cancel-"));
      tempDirs.push(root);
      await writeAppPlist(path.join(root, "Example.app"), {
        displayName: "Example",
        bundleIdentifier: "com.example.application",
        version: "1",
        extraKeys:
          kind === "bundle" ? "<key>CFBundleIconFile</key><string>Example.icns</string>" : undefined
      });
      let rejectIcon!: (reason: Error) => void;
      const icon = new Promise<never>((_resolve, reject) => {
        rejectIcon = reject;
      });
      const read =
        kind === "platform"
          ? electronMocks.getFileIcon.mockReturnValueOnce(icon)
          : vi.spyOn(IconCache.prototype, "get").mockReturnValueOnce(icon);
      const controller = new AbortController();
      const health = vi.fn();
      const task = new BundleScannerClient().scanApplications([root], {
        signal: controller.signal,
        onRootRead: health
      });
      let failure: unknown;
      const observed = task.catch((error: unknown) => {
        failure = error;
      });
      try {
        await vi.waitFor(() => expect(read).toHaveBeenCalled());
        controller.abort(new Error("cancelled scan"));
        await vi.waitFor(() => expect(failure).toMatchObject({ message: "cancelled scan" }), {
          timeout: 200
        });
        expect(health).not.toHaveBeenCalled();
      } finally {
        rejectIcon(new Error("late optional icon failure"));
        await Promise.allSettled([icon, task, observed]);
      }
    }
  );

  it.each(["platform", "bundle"] as const)(
    "keeps readable app metadata and later apps after an optional %s icon deadline",
    async (kind) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "baseline-icon-deadline-"));
      tempDirs.push(root);
      const firstRoot = path.join(root, "First");
      const secondRoot = path.join(root, "Second");
      for (const [directory, name] of [
        [firstRoot, "A"],
        [firstRoot, "B"],
        [secondRoot, "C"]
      ] as const) {
        await writeAppPlist(path.join(directory, `${name}.app`), {
          displayName: name,
          bundleIdentifier: `com.example.${name}`,
          version: "1",
          extraKeys:
            kind === "bundle" && name === "A"
              ? "<key>CFBundleIconFile</key><string>Example.icns</string>"
              : undefined
        });
      }
      const originalRead = readdir;
      vi.spyOn(testingExports.directoryRuntime, "readdir").mockImplementation((async (
        directory: string,
        options: never
      ) => {
        const entries = (await originalRead(directory, options)) as unknown as Dirent[];
        return directory === firstRoot
          ? entries.sort((a, b) => a.name.localeCompare(b.name))
          : entries;
      }) as typeof readdir);
      const deadline = new AbortController();
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
      let iconActive = false;
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
        iconActive ? deadline.signal : originalTimeout(ms)
      );
      let rejectIcon!: (reason: Error) => void;
      const blockedIcon = new Promise<never>((_resolve, reject) => {
        rejectIcon = reject;
      });
      const blockIcon = () => {
        iconActive = true;
        queueMicrotask(() => {
          iconActive = false;
          deadline.abort(
            Object.assign(new Error("optional icon deadline"), { name: "TimeoutError" })
          );
        });
        return blockedIcon;
      };
      if (kind === "platform") electronMocks.getFileIcon.mockImplementationOnce(blockIcon);
      else vi.spyOn(IconCache.prototype, "get").mockImplementationOnce(blockIcon);
      const health = vi.fn();
      const task = new BundleScannerClient().scanApplications([firstRoot, secondRoot], {
        onRootRead: health
      });
      let records: Awaited<typeof task> | undefined;
      let failure: unknown;
      const observed = task.then(
        (value) => {
          records = value;
        },
        (error: unknown) => {
          failure = error;
        }
      );
      try {
        await vi.waitFor(() => expect(records).toBeDefined(), { timeout: 1000 });
        expect(failure).toBeUndefined();
        expect(records?.map((record) => record.displayName)).toEqual(["A", "B", "C"]);
        expect(records?.[0]).toMatchObject({
          bundleIdentifier: "com.example.A",
          localVersion: { raw: "1" },
          iconDataURL: undefined
        });
        expect(health.mock.calls.map(([value]) => value)).toEqual([
          { directory: firstRoot, complete: true },
          { directory: secondRoot, complete: true }
        ]);
        expect(electronMocks.getFileIcon).toHaveBeenCalledTimes(kind === "platform" ? 3 : 2);
      } finally {
        rejectIcon(new Error("late optional icon failure"));
        await Promise.allSettled([blockedIcon, task, observed]);
      }
    }
  );

  it.each([false, true])(
    "invalidates native/wrapped provider mappings for executable, actual plist and signature changes (wrapped=%s)",
    async (wrapped) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
      tempDirs.push(root);
      const appPath = path.join(root, "Example.app");
      const info = {
        displayName: "Example",
        bundleIdentifier: "com.example.application",
        version: "1.0",
        extraKeys: "<key>CFBundleExecutable</key><string>Example</string>"
      };
      if (wrapped) await writeWrappedIOSAppPlist(appPath, info);
      else await writeAppPlist(appPath, info);
      const contentsPath = wrapped
        ? path.join(appPath, "Wrapper", "Example.app")
        : path.join(appPath, "Contents");
      const executablePath = path.join(contentsPath, ...(wrapped ? [] : ["MacOS"]), "Example");
      const signaturePath = path.join(contentsPath, "_CodeSignature", "CodeResources");
      const plistPath = path.join(contentsPath, "Info.plist");
      await mkdir(path.dirname(executablePath), { recursive: true });
      await mkdir(path.dirname(signaturePath), { recursive: true });
      await writeFile(executablePath, "original executable");
      await writeFile(signaturePath, "original signature");
      const rootBefore = await stat(appPath);
      const plistBefore = await readFile(plistPath, "utf8");
      const scanner = new BundleScannerClient();
      const first = (await scanner.scanApplications([root]))[0]!;
      await writeFile(executablePath, "replacement executable with the same advertised version");
      const replaced = (await scanner.scanApplications([root]))[0]!;
      expect(replaced.providerFingerprint).not.toBe(first.providerFingerprint);
      expect(replaced.localVersion).toEqual(first.localVersion);
      expect(await readFile(plistPath, "utf8")).toBe(plistBefore);
      expect((await stat(appPath)).mtimeMs).toBe(rootBefore.mtimeMs);
      await writeFile(plistPath, `${plistBefore}\n`);
      const plistChanged = (await scanner.scanApplications([root]))[0]!;
      expect(plistChanged.providerFingerprint).not.toBe(replaced.providerFingerprint);
      await writeFile(signaturePath, "replacement signature resource");
      expect((await scanner.scanApplications([root]))[0]?.providerFingerprint).not.toBe(
        plistChanged.providerFingerprint
      );
    }
  );

  it.each(["../../../outside", "linked-executable"])(
    "ignores executable paths escaping the installed bundle (%s)",
    async (executable) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
      tempDirs.push(root);
      const appPath = path.join(root, "Example.app");
      const outside = path.join(root, "outside");
      await writeFile(outside, "outside file");
      await writeAppPlist(appPath, {
        displayName: "Example",
        bundleIdentifier: "com.example.application",
        version: "1",
        extraKeys: `<key>CFBundleExecutable</key><string>${executable}</string>`
      });
      await mkdir(path.join(appPath, "Contents", "MacOS"));
      if (executable === "linked-executable")
        await symlink(outside, path.join(appPath, "Contents", "MacOS", executable));
      const scanner = new BundleScannerClient();
      const first = (await scanner.scanApplications([root]))[0]!;
      await writeFile(outside, "changed outside file");
      expect((await scanner.scanApplications([root]))[0]?.providerFingerprint).toBe(
        first.providerFingerprint
      );
    }
  );

  it("keeps unchanged provider evidence stable and invalidates it when an installation or receipt changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);
    const appPath = path.join(root, "Example.app");
    const plist = {
      displayName: "Example",
      bundleIdentifier: "com.example.application",
      version: "1.0"
    };
    await writeAppPlist(appPath, plist);
    const scanner = new BundleScannerClient();
    const first = (await scanner.scanApplications([root]))[0]!;
    expect(first.providerFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await scanner.scanApplications([root]))[0]?.providerFingerprint).toBe(
      first.providerFingerprint
    );
    const receiptDirectory = path.join(appPath, "Contents", "_MASReceipt");
    await mkdir(receiptDirectory);
    await writeFile(path.join(receiptDirectory, "receipt"), "generic receipt evidence");
    const withReceipt = (await scanner.scanApplications([root]))[0]!;
    expect(withReceipt.hasAppStoreEvidence).toBe(true);
    expect(withReceipt.providerFingerprint).not.toBe(first.providerFingerprint);
    await writeAppPlist(appPath, { ...plist, version: "2.0" });
    expect((await scanner.scanApplications([root]))[0]?.providerFingerprint).not.toBe(
      withReceipt.providerFingerprint
    );
  });

  it("recursively finds apps without descending into app bundles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    await writeAppPlist(path.join(root, "Direct.app"), {
      displayName: "Direct",
      bundleIdentifier: "com.example.direct",
      version: "1.0.0"
    });
    await writeAppPlist(path.join(root, "Vendor", "Nested.app"), {
      displayName: "Nested",
      bundleIdentifier: "com.example.nested",
      version: "2.0.0"
    });
    await writeAppPlist(
      path.join(root, "Vendor", "Nested.app", "Contents", "PlugIns", "Hidden.app"),
      {
        displayName: "Hidden",
        bundleIdentifier: "com.example.hidden",
        version: "3.0.0"
      }
    );

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records.map((record) => record.displayName)).toEqual(["Direct", "Nested"]);
    expect(records.map((record) => record.bundleIdentifier)).toEqual([
      "com.example.direct",
      "com.example.nested"
    ]);
  });

  it("scans symlinked app bundles once when their target is also scanned", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);
    const scanRoot = path.join(root, "Scan");
    const targetRoot = path.join(root, "Targets");
    const targetApp = path.join(targetRoot, "Target.app");
    const linkedApp = path.join(scanRoot, "Linked.app");
    await mkdir(scanRoot, { recursive: true });
    await writeAppPlist(targetApp, {
      displayName: "Target",
      bundleIdentifier: "com.example.target",
      version: "1.0.0"
    });
    await symlink(targetApp, linkedApp);

    const records = await new BundleScannerClient().scanApplications([scanRoot, targetRoot]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      displayName: "Target",
      bundleIdentifier: "com.example.target"
    });
  });

  it("ignores Safari web app bundles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    await writeAppPlist(path.join(root, "GitHub.app"), {
      displayName: "GitHub",
      bundleIdentifier: "com.apple.Safari.WebApp.96B22158-BAD1-44DA-880D-913DB7E56FC7",
      version: "1.0.0",
      extraKeys: [
        "  <key>LSTemplateApplication</key>",
        "  <true/>",
        "  <key>LSTemplateApplicationParameters</key>",
        "  <dict>",
        "    <key>CFBundleIdentifier</key>",
        "    <string>com.apple.Safari.WebApp</string>",
        "  </dict>",
        "  <key>WKManifestURL</key>",
        "  <string>https://github.com/manifest.json</string>",
        "  <key>Manifest</key>",
        "  <dict>",
        "    <key>name</key>",
        "    <string>GitHub</string>",
        "  </dict>"
      ].join("\n")
    });

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records).toEqual([]);
  });

  it("keeps normal app bundles that contain a generic manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    await writeAppPlist(path.join(root, "Manifested.app"), {
      displayName: "Manifested",
      bundleIdentifier: "com.example.manifested",
      version: "1.0.0",
      extraKeys: [
        "  <key>Manifest</key>",
        "  <dict>",
        "    <key>name</key>",
        "    <string>Manifested</string>",
        "  </dict>"
      ].join("\n")
    });

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records.map((record) => record.displayName)).toEqual(["Manifested"]);
  });

  it("keeps the bundle build version alongside the marketing version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    await writeAppPlist(path.join(root, "Build Versioned.app"), {
      displayName: "Build Versioned",
      bundleIdentifier: "com.example.build-versioned",
      version: "1.0",
      extraKeys: ["  <key>CFBundleVersion</key>", "  <string>100</string>"].join("\n")
    });

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      displayName: "Build Versioned",
      localVersion: { raw: "1.0" },
      bundleVersion: { raw: "100" }
    });
  });

  it("marks direct iOS-on-Mac bundles as App Store apps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "Designed for iPad.app");
    await writeAppPlist(appPath, {
      displayName: "Designed for iPad",
      bundleIdentifier: "com.example.ipad-direct",
      version: "1.0.0",
      extraKeys: [
        "  <key>UIDeviceFamily</key>",
        "  <array>",
        "    <integer>2</integer>",
        "  </array>",
        "  <key>UIDesignRequiresCompatibility</key>",
        "  <true/>"
      ].join("\n")
    });
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundlePath: appPath,
      bundleIdentifier: "com.example.ipad-direct",
      sourceHint: "appStore",
      isIOSAppOnMac: true,
      hasAppStoreEvidence: true
    });
  });

  it("marks receipt-backed UIKit iPad bundles as App Store software lookup eligible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "UIKit Mac App.app");
    await writeAppPlist(appPath, {
      displayName: "UIKit Mac App",
      bundleIdentifier: "com.example.uikit-mac",
      version: "1.0.0",
      extraKeys: [
        "  <key>CFBundleSupportedPlatforms</key>",
        "  <array>",
        "    <string>MacOSX</string>",
        "  </array>",
        "  <key>UIApplicationSceneManifest</key>",
        "  <dict>",
        "    <key>UIApplicationSupportsMultipleScenes</key>",
        "    <false/>",
        "  </dict>",
        "  <key>UIDeviceFamily</key>",
        "  <array>",
        "    <integer>2</integer>",
        "  </array>",
        "  <key>UILaunchStoryboardName</key>",
        "  <string>LaunchScreen</string>"
      ].join("\n")
    });
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundlePath: appPath,
      bundleIdentifier: "com.example.uikit-mac",
      sourceHint: "appStore",
      isIOSAppOnMac: true,
      hasAppStoreEvidence: true
    });
  });

  it("does not enable iOS software lookup for native macOS UIKit App Store bundles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "Native UIKit Mac App.app");
    await writeAppPlist(appPath, {
      displayName: "Native UIKit Mac App",
      bundleIdentifier: "com.example.native-uikit-mac",
      version: "1.0.0",
      extraKeys: [
        "  <key>CFBundleSupportedPlatforms</key>",
        "  <array>",
        "    <string>MacOSX</string>",
        "  </array>",
        "  <key>DTPlatformName</key>",
        "  <string>macosx</string>",
        "  <key>DTSDKName</key>",
        "  <string>macosx26.5</string>",
        "  <key>LSMinimumSystemVersion</key>",
        "  <string>26.0</string>",
        "  <key>UIDesignRequiresCompatibility</key>",
        "  <true/>",
        "  <key>UIApplicationSceneManifest</key>",
        "  <dict>",
        "    <key>UIApplicationSupportsMultipleScenes</key>",
        "    <false/>",
        "  </dict>",
        "  <key>UIDeviceFamily</key>",
        "  <array>",
        "    <integer>2</integer>",
        "  </array>",
        "  <key>UILaunchStoryboardName</key>",
        "  <string>LaunchScreen</string>"
      ].join("\n")
    });
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundlePath: appPath,
      bundleIdentifier: "com.example.native-uikit-mac",
      sourceHint: "appStore",
      isIOSAppOnMac: false,
      hasAppStoreEvidence: true
    });
  });

  it("does not enable iOS software lookup for App Store UIKit bundles with Mac idiom", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "UIKit Mac Idiom App.app");
    await writeAppPlist(appPath, {
      displayName: "UIKit Mac Idiom App",
      bundleIdentifier: "com.example.uikit-mac-idiom",
      version: "1.0.0",
      extraKeys: [
        "  <key>UIApplicationSceneManifest</key>",
        "  <dict>",
        "    <key>UIApplicationSupportsMultipleScenes</key>",
        "    <false/>",
        "  </dict>",
        "  <key>UIDeviceFamily</key>",
        "  <array>",
        "    <integer>6</integer>",
        "  </array>",
        "  <key>UILaunchStoryboardName</key>",
        "  <string>LaunchScreen</string>"
      ].join("\n")
    });
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundleIdentifier: "com.example.uikit-mac-idiom",
      sourceHint: "appStore",
      isIOSAppOnMac: false,
      hasAppStoreEvidence: true
    });
  });

  it("does not enable iOS software lookup for App Store UIKit bundles with mixed iPad and Mac idioms", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "UIKit Mixed Idiom App.app");
    await writeAppPlist(appPath, {
      displayName: "UIKit Mixed Idiom App",
      bundleIdentifier: "com.example.uikit-mixed-idiom",
      version: "1.0.0",
      extraKeys: [
        "  <key>UIApplicationSceneManifest</key>",
        "  <dict>",
        "    <key>UIApplicationSupportsMultipleScenes</key>",
        "    <false/>",
        "  </dict>",
        "  <key>UIDeviceFamily</key>",
        "  <array>",
        "    <integer>2</integer>",
        "    <integer>6</integer>",
        "  </array>",
        "  <key>UILaunchStoryboardName</key>",
        "  <string>LaunchScreen</string>"
      ].join("\n")
    });
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundlePath: appPath,
      bundleIdentifier: "com.example.uikit-mixed-idiom",
      sourceHint: "appStore",
      isIOSAppOnMac: false,
      hasAppStoreEvidence: true
    });
  });

  it("marks App Store UIKit Mac bundles with scalar device family as lookup eligible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "UIKit Scalar Device Family.app");
    await writeAppPlist(appPath, {
      displayName: "UIKit Scalar Device Family",
      bundleIdentifier: "com.example.uikit-scalar-device-family",
      version: "1.0.0",
      extraKeys: [
        "  <key>UIApplicationSceneManifest</key>",
        "  <dict>",
        "    <key>UIApplicationSupportsMultipleScenes</key>",
        "    <false/>",
        "  </dict>",
        "  <key>UIDeviceFamily</key>",
        "  <integer>2</integer>",
        "  <key>UILaunchStoryboardName</key>",
        "  <string>LaunchScreen</string>"
      ].join("\n")
    });
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundleIdentifier: "com.example.uikit-scalar-device-family",
      sourceHint: "appStore",
      isIOSAppOnMac: true,
      hasAppStoreEvidence: true
    });
  });

  it("does not enable iOS software lookup for UIKit-style Mac bundles without App Store evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    await writeAppPlist(path.join(root, "Sideloaded UIKit Mac App.app"), {
      displayName: "Sideloaded UIKit Mac App",
      bundleIdentifier: "com.example.sideloaded-uikit-mac",
      version: "1.0.0",
      extraKeys: [
        "  <key>UIApplicationSceneManifest</key>",
        "  <dict>",
        "    <key>UIApplicationSupportsMultipleScenes</key>",
        "    <false/>",
        "  </dict>",
        "  <key>UIDeviceFamily</key>",
        "  <array>",
        "    <integer>2</integer>",
        "  </array>",
        "  <key>UILaunchStoryboardName</key>",
        "  <string>LaunchScreen</string>"
      ].join("\n")
    });

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundleIdentifier: "com.example.sideloaded-uikit-mac",
      sourceHint: "unknown",
      isIOSAppOnMac: false,
      hasAppStoreEvidence: false
    });
  });

  it("marks native Safari web extension apps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "Content Blocker.app");
    await writeAppPlist(appPath, {
      displayName: "Content Blocker",
      bundleIdentifier: "com.example.content-blocker",
      version: "1.0.0",
      extraKeys: [
        "  <key>CFBundleSupportedPlatforms</key>",
        "  <array>",
        "    <string>MacOSX</string>",
        "  </array>",
        "  <key>LSMinimumSystemVersion</key>",
        "  <string>13.5</string>"
      ].join("\n")
    });
    await writeExtensionPlist(
      path.join(appPath, "Contents", "PlugIns", "Content Blocker Extension.appex"),
      "com.apple.Safari.web-extension"
    );
    await mkdir(path.join(appPath, "Contents", "_MASReceipt"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "_MASReceipt", "receipt"), "receipt");

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundlePath: appPath,
      bundleIdentifier: "com.example.content-blocker",
      sourceHint: "appStore",
      isIOSAppOnMac: false,
      hasAppStoreEvidence: true,
      hasSafariWebExtension: true
    });
  });

  it("does not mark other app extensions as Safari web extension apps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);

    const appPath = path.join(root, "Native Service App.app");
    await writeAppPlist(appPath, {
      displayName: "Native Service App",
      bundleIdentifier: "com.example.native-service",
      version: "1.0.0"
    });
    await writeExtensionPlist(
      path.join(appPath, "Contents", "PlugIns", "Service Extension.appex"),
      "com.example.native-service-extension"
    );

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundleIdentifier: "com.example.native-service",
      hasSafariWebExtension: false
    });
  });

  it("scans App Store wrapper bundles for iOS-on-Mac apps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);
    const appPath = path.join(root, "Wrapped iPad App.app");

    await writeWrappedIOSAppPlist(appPath, {
      displayName: "Wrapped iPad App",
      bundleIdentifier: "com.example.ipad-wrapper",
      version: "3.22"
    });
    electronMocks.createFromPath.mockImplementation((imagePath: string) => ({
      isEmpty: () => !imagePath.endsWith("AppIcon60x60@2x.png"),
      resize: () => ({ toDataURL: () => `icon:${imagePath}` })
    }));

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      id: appPath,
      bundlePath: appPath,
      displayName: "Wrapped iPad App",
      bundleIdentifier: "com.example.ipad-wrapper",
      localVersion: { raw: "3.22" },
      sourceHint: "appStore",
      isIOSAppOnMac: true,
      hasAppStoreEvidence: true,
      iconDataURL: `icon:${path.join(appPath, "Wrapper", "Wrapped iPad App.app", "AppIcon60x60@2x.png")}`
    });
  });

  it("does not treat wrapper iOS apps without App Store metadata as App Store managed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);
    const appPath = path.join(root, "Sideloaded iPad App.app");

    await writeWrappedIOSAppPlist(appPath, {
      displayName: "Sideloaded iPad App",
      bundleIdentifier: "com.example.sideloaded-ipad-wrapper",
      version: "1.0",
      includeAppStoreEvidence: false
    });

    const records = await new BundleScannerClient().scanApplications([root]);

    expect(records[0]).toMatchObject({
      bundleIdentifier: "com.example.sideloaded-ipad-wrapper",
      sourceHint: "unknown",
      isIOSAppOnMac: true,
      hasAppStoreEvidence: false
    });
  });

  it("detects grayscale icon conversion output", () => {
    expect(testingExports.isGrayscaleSipsOutput("  space: Gray\n")).toBe(true);
    expect(testingExports.isGrayscaleSipsOutput("  space: RGB\n")).toBe(false);
    expect(testingExports.isGrayscaleSipsOutput("  profile: Generic Gray Gamma 2.2\n")).toBe(false);
  });

  it("limits grayscale padding candidates to generic Electron bundle icons", () => {
    expect(
      testingExports.isGenericElectronIconName("/Applications/Example.app/electron.icns")
    ).toBe(true);
    expect(
      testingExports.isGenericElectronIconName("/Applications/Example.app/Electron.icns")
    ).toBe(true);
    expect(testingExports.isGenericElectronIconName("/Applications/Example.app/Custom.icns")).toBe(
      false
    );
  });

  it("uses the padded raster output for grayscale generic Electron bundle icons", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-scan-"));
    tempDirs.push(root);
    const iconPath = path.join(root, "Contents", "Resources", "electron.icns");

    testingExports.iconRuntime.execFileAsync = vi.fn(async (file: string, args: string[]) => {
      const execArgs = args;

      if (file !== "/usr/bin/sips") {
        throw new Error(`Unexpected executable: ${file}`);
      }

      if (execArgs.includes("-s") && execArgs.includes("format")) {
        const outputPath = execArgs.at(-1);
        await writeFile(String(outputPath), "converted png");
        return { stdout: "", stderr: "" };
      }

      if (execArgs.includes("-g") && execArgs.includes("space")) {
        return { stdout: `${execArgs.at(-1)}\n  space: Gray\n`, stderr: "" };
      }

      if (execArgs.includes("-z")) {
        const outputPath = execArgs.at(-1);
        await writeFile(String(outputPath), "resized png");
        return { stdout: "", stderr: "" };
      }

      if (execArgs.includes("--padToHeightWidth")) {
        const outputPath = execArgs.at(-1);
        await writeFile(String(outputPath), "padded png");
        return { stdout: "", stderr: "" };
      }

      throw new Error(`Unexpected sips arguments: ${execArgs.join(" ")}`);
    });
    testingExports.iconRuntime.createFromPath = vi.fn((imagePath: string) => ({
      isEmpty: () => false,
      resize: () => ({ toDataURL: () => `resized:${imagePath}` }),
      toDataURL: () => `padded:${imagePath}`
    }));

    expect(await testingExports.shouldPadGrayscaleIcon(iconPath, "converted-icon.png")).toBe(true);

    const result = await testingExports.loadIconFileDataURL(iconPath);

    expect(result.dataURL).toMatch(/^padded:.*icon-padded\.png$/u);
    expect(testingExports.iconRuntime.createFromPath).toHaveBeenCalledTimes(1);
    expect(testingExports.iconRuntime.createFromPath).toHaveBeenCalledWith(
      expect.stringMatching(/icon-padded\.png$/u)
    );
  });

  it("normalizes unreadable raster app icons before falling back to system icons", async () => {
    const iconPath = "/Applications/Wrapped.app/Wrapper/Wrapped.app/AppIcon60x60@2x.png";

    testingExports.iconRuntime.execFileAsync = vi.fn(async (file: string, args: string[]) => {
      if (file !== "/usr/bin/sips") {
        throw new Error(`Unexpected executable: ${file}`);
      }
      if (args.includes("-s") && args.includes("format")) {
        const outputPath = args.at(-1);
        await writeFile(String(outputPath), "normalized png");
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected sips arguments: ${args.join(" ")}`);
    });
    testingExports.iconRuntime.createFromPath = vi.fn((imagePath: string) => ({
      isEmpty: () => !imagePath.endsWith("icon-normalized.png"),
      resize: () => ({ toDataURL: () => `normalized:${imagePath}` }),
      toDataURL: () => `original:${imagePath}`
    }));

    const result = await testingExports.loadIconFileDataURL(iconPath);

    expect(result.dataURL).toMatch(/^normalized:.*icon-normalized\.png$/u);
    expect(testingExports.iconRuntime.createFromPath).toHaveBeenCalledWith(iconPath);
    expect(testingExports.iconRuntime.createFromPath).toHaveBeenCalledWith(
      expect.stringMatching(/icon-normalized\.png$/u)
    );
  });
});

async function writeAppPlist(
  appPath: string,
  {
    displayName,
    bundleIdentifier,
    version,
    extraKeys = ""
  }: { displayName: string; bundleIdentifier: string; version: string; extraKeys?: string }
): Promise<void> {
  await mkdir(path.join(appPath, "Contents"), { recursive: true });
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${displayName}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
${extraKeys}
</dict>
</plist>
`
  );
}

async function writeWrappedIOSAppPlist(
  appPath: string,
  {
    displayName,
    bundleIdentifier,
    version,
    includeAppStoreEvidence = true,
    extraKeys = ""
  }: {
    displayName: string;
    bundleIdentifier: string;
    version: string;
    includeAppStoreEvidence?: boolean;
    extraKeys?: string;
  }
): Promise<void> {
  const wrappedAppPath = path.join(appPath, "Wrapper", `${displayName}.app`);
  await mkdir(wrappedAppPath, { recursive: true });
  await writeFile(path.join(wrappedAppPath, "AppIcon60x60@2x.png"), "icon");
  await writeFile(
    path.join(wrappedAppPath, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${displayName}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleIconFiles</key>
  <array>
    <string>AppIcon60x60</string>
  </array>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleSupportedPlatforms</key>
  <array>
    <string>iPhoneOS</string>
  </array>
  <key>LSRequiresIPhoneOS</key>
  <true/>
  <key>UIDeviceFamily</key>
  <array>
    <integer>1</integer>
    <integer>2</integer>
  </array>
${extraKeys}
</dict>
</plist>
`
  );
  if (includeAppStoreEvidence) {
    await mkdir(path.join(wrappedAppPath, "SC_Info"), { recursive: true });
    await writeFile(
      path.join(appPath, "Wrapper", "iTunesMetadata.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>softwareVersionBundleId</key>
  <string>${bundleIdentifier}</string>
  <key>itemId</key>
  <integer>123456789</integer>
</dict>
</plist>
`
    );
  }
}

async function writeExtensionPlist(
  appExtensionPath: string,
  extensionPoint: string
): Promise<void> {
  await mkdir(path.join(appExtensionPath, "Contents"), { recursive: true });
  await writeFile(
    path.join(appExtensionPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.example.extension</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>${extensionPoint}</string>
  </dict>
</dict>
</plist>
`
  );
}
