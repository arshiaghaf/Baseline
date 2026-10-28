// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { Header, Pax, type HeaderData } from "tar";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function entry(header: HeaderData, data = "", pax?: HeaderData): Buffer {
  const block = Buffer.alloc(512);
  const body = Buffer.from(data);
  new Header({ mode: 0o755, ...header, size: body.length }).encode(block);
  return Buffer.concat([
    ...(pax ? [new Pax(pax).encode()] : []),
    block,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512)
  ]);
}

async function extractInChild(archive: Buffer, options: { strict: boolean; sync: boolean }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-tar-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fixture.tar");
  await writeFile(file, archive);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        process.on('uncaughtException', error => {
          console.error(error.name + ': ' + error.message);
          process.exitCode = 1;
        });
        const tar = require(process.argv[1]);
        Promise.resolve(tar.extract({
          file: process.argv[2], cwd: process.argv[3],
          strict: process.argv[4] === 'true', sync: process.argv[5] === 'true'
        })).catch(error => { console.error(error.message); process.exitCode = 1; });
      `,
      require.resolve("tar"),
      file,
      dir,
      String(options.strict),
      String(options.sync)
    ],
    { encoding: "utf8", timeout: 10000 }
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return dir;
}

describe("tooling tar extraction", () => {
  it.each(["gzip", "brotli"])(
    "bounds %s decompression before resource exhaustion",
    async (kind) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-tar-ratio-"));
      tempDirs.push(dir);
      const archive = Buffer.concat([
        entry({ path: "payload", type: "File" }, "\0".repeat(8 * 1024 * 1024)),
        Buffer.alloc(1024)
      ]);
      const file = path.join(dir, kind === "gzip" ? "fixture.tgz" : "fixture.tar.br");
      await writeFile(file, kind === "gzip" ? gzipSync(archive) : brotliCompressSync(archive));
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          `
          const assert = require('node:assert/strict');
          let rejected = false;
          process.on('beforeExit', () => assert.ok(rejected, 'must reject excessive expansion'));
          require(process.argv[1]).list({file: process.argv[2]}).then(
            () => { throw new Error('accepted excessive expansion'); },
            error => { assert.match(error.message, /max decompression ratio exceeded/); rejected = true; }
          ).catch(error => { console.error(error); process.exitCode = 1; });
        `,
          require.resolve("tar"),
          file
        ],
        { encoding: "utf8", timeout: 10000 }
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
    }
  );

  it("filters a deeply nested PAX path without overflowing the stack", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-tar-selection-"));
    tempDirs.push(dir);
    const file = path.join(dir, "fixture.tar");
    await writeFile(
      file,
      Buffer.concat([
        entry({ path: "placeholder", type: "File" }, "", { path: `${"a/".repeat(20000)}leaf` }),
        entry({ path: "selected", type: "File" }, "ordinary payload"),
        Buffer.alloc(1024)
      ])
    );
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const assert = require('node:assert/strict');
          const seen = [];
          let settled = false;
          process.on('beforeExit', () => assert.ok(settled));
          require(process.argv[1]).list({
            file: process.argv[2], onReadEntry: entry => seen.push(entry.path)
          }, ['selected']).then(() => {
            assert.deepEqual(seen, ['selected']); settled = true;
          }).catch(error => { console.error(error); process.exitCode = 1; });
        `,
        require.resolve("tar"),
        file
      ],
      { encoding: "utf8", timeout: 10000 }
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  });

  for (const strict of [false, true]) {
    for (const sync of [false, true]) {
      it(`preserves numeric PAX paths and link targets (strict=${strict}, sync=${sync})`, async () => {
        const dir = await extractInChild(
          Buffer.concat([
            entry({ path: "placeholder", type: "Directory" }, "", { path: "12345" }),
            entry({ path: "12345/payload", type: "File" }, "directory payload"),
            entry({ path: "placeholder", type: "File" }, "numeric payload", { path: "00054321" }),
            entry({ path: "symbolic", type: "SymbolicLink", linkpath: "placeholder-target" }, "", {
              linkpath: "00054321"
            }),
            entry({ path: "hard", type: "Link", linkpath: "placeholder-target" }, "", {
              linkpath: "00054321"
            }),
            entry({ path: "ordinary", type: "File" }, "ordinary payload"),
            Buffer.alloc(1024)
          ]),
          { strict, sync }
        );
        expect((await stat(path.join(dir, "12345"))).isDirectory()).toBe(true);
        expect(await readFile(path.join(dir, "12345/payload"), "utf8")).toBe("directory payload");
        expect(await readFile(path.join(dir, "00054321"), "utf8")).toBe("numeric payload");
        expect(await readlink(path.join(dir, "symbolic"))).toBe("00054321");
        expect(await readFile(path.join(dir, "hard"), "utf8")).toBe("numeric payload");
        expect(await readFile(path.join(dir, "ordinary"), "utf8")).toBe("ordinary payload");
      });
    }
  }
});
