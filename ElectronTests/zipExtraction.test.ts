// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { extractElectronZip } = require(
  path.join(path.dirname(require.resolve("@electron/packager")), "unzip.js")
) as { extractElectronZip: (file: string, dir: string) => Promise<void> };
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type ZipEntry = { name: string; data: string; mode?: number };

// Store entries verbatim, including duplicate names and Unix symlink attributes.
function zip(entries: ZipEntry[]): Buffer {
  const files: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    files.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, central, end]);
}

async function fixture(entries: ZipEntry[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "baseline-zip-"));
  tempDirs.push(root);
  const file = path.join(root, "fixture.zip");
  const dir = path.join(root, "output");
  const outside = path.join(root, "outside");
  await writeFile(file, zip(entries));
  await writeFile(outside, "sentinel");
  await mkdir(dir);
  return { root, file, dir, outside };
}

describe("Electron packaging ZIP extraction", () => {
  it("preserves files, executable modes and framework-style internal links", async () => {
    const { file, dir } = await fixture([
      { name: "Example.app/Contents/MacOS/Example", data: "executable", mode: 0o100755 },
      {
        name: "Example.app/Contents/Frameworks/Example.framework/Versions/A/payload",
        data: "payload"
      },
      {
        name: "Example.app/Contents/Frameworks/Example.framework/Versions/Current",
        data: "A",
        mode: 0o120777
      },
      {
        name: "Example.app/Contents/Frameworks/Example.framework/payload",
        data: "Versions/Current/payload",
        mode: 0o120777
      }
    ]);
    await extractElectronZip(file, dir);
    const executable = path.join(dir, "Example.app/Contents/MacOS/Example");
    expect(await readFile(executable, "utf8")).toBe("executable");
    expect((await stat(executable)).mode & 0o777).toBe(0o755);
    const framework = path.join(dir, "Example.app/Contents/Frameworks/Example.framework");
    expect(await readlink(path.join(framework, "Versions/Current"))).toBe("A");
    expect(await readFile(path.join(framework, "payload"), "utf8")).toBe("payload");
  });

  it.each(["../outside", "nested/../../outside"])(
    "rejects escaping symlink target %s",
    async (target) => {
      const { file, dir, outside } = await fixture([
        { name: "escape", data: target, mode: 0o120777 }
      ]);
      await expect(extractElectronZip(file, dir)).rejects.toThrow();
      expect(await readFile(outside, "utf8")).toBe("sentinel");
      await expect(lstat(path.join(dir, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("rejects absolute symlink targets", async () => {
    const { file, dir, outside } = await fixture([]);
    await writeFile(file, zip([{ name: "escape", data: outside, mode: 0o120777 }]));
    await expect(extractElectronZip(file, dir)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("sentinel");
  });

  it.each([false, true])(
    "keeps duplicate symlink/file entries inside the destination (file first=%s)",
    async (fileFirst) => {
      const entries = [
        { name: "duplicate", data: "../outside", mode: 0o120777 },
        { name: "duplicate", data: "replacement" }
      ];
      const { file, dir, outside } = await fixture(fileFirst ? entries.reverse() : entries);
      // The ZIP reader keeps the last entry for a duplicate name.
      if (fileFirst) {
        await expect(extractElectronZip(file, dir)).rejects.toThrow();
        await expect(lstat(path.join(dir, "duplicate"))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await extractElectronZip(file, dir);
        expect(await readFile(path.join(dir, "duplicate"), "utf8")).toBe("replacement");
        expect((await lstat(path.join(dir, "duplicate"))).isSymbolicLink()).toBe(false);
      }
      expect(await readFile(outside, "utf8")).toBe("sentinel");
    }
  );

  it("rejects symlink chains that escape the destination", async () => {
    const { file, dir, outside } = await fixture([
      { name: "back", data: ".", mode: 0o120777 },
      { name: "escape", data: "back/../outside", mode: 0o120777 }
    ]);
    await expect(extractElectronZip(file, dir)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("sentinel");
  });

  it("does not write through a pre-existing final-component symlink", async () => {
    const { file, dir, outside } = await fixture([{ name: "existing", data: "replacement" }]);
    await symlink(outside, path.join(dir, "existing"));
    await extractElectronZip(file, dir);
    expect(await readFile(outside, "utf8")).toBe("sentinel");
    expect(await readFile(path.join(dir, "existing"), "utf8")).toBe("replacement");
    expect((await lstat(path.join(dir, "existing"))).isSymbolicLink()).toBe(false);
  });

  it("rejects a target that resolves through an existing escaping symlink", async () => {
    const { file, dir, outside } = await fixture([
      { name: "escape", data: "existing", mode: 0o120777 }
    ]);
    await symlink(outside, path.join(dir, "existing"));
    await expect(extractElectronZip(file, dir)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("sentinel");
    await expect(lstat(path.join(dir, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
