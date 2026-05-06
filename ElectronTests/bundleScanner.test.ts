import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BundleScannerClient } from "../src/main/bundleScanner";

vi.mock("electron", () => ({
  app: {
    getFileIcon: vi.fn(async () => ({
      isEmpty: () => true,
      resize: () => ({ toDataURL: () => "" })
    }))
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => true,
      resize: () => ({ toDataURL: () => "" })
    }))
  }
}));

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirs = [];
});

describe("bundle scanner", () => {
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
});

async function writeAppPlist(
  appPath: string,
  {
    displayName,
    bundleIdentifier,
    version
  }: { displayName: string; bundleIdentifier: string; version: string }
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
</dict>
</plist>
`
  );
}
