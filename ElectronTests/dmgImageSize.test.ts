// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fromAppdmg =
  process.platform === "darwin" ? createRequire(require.resolve("appdmg")) : undefined;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function probe(data: Buffer | undefined, succeeds: boolean) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "baseline-image-size-"));
  directories.push(dir);
  const filename = path.join(dir, "background");
  if (data) await writeFile(filename, data);
  // Resolve through the actual DMG builder. A timeout also bounds regressions to
  // the vulnerable parser's infinite loop; no native app or disk image is opened.
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        const assert = require('node:assert/strict');
        const sizeOf = require(process.argv[1]);
        let calls = 0;
        process.on('beforeExit', () => assert.equal(calls, 1, 'callback must settle exactly once'));
        sizeOf(process.argv[2], (error, dimensions) => {
          calls++;
          if (process.argv[3] === 'true') {
            assert.ifError(error);
            assert.ok(dimensions.width > 0 && dimensions.height > 0);
            console.log(JSON.stringify(dimensions));
          } else {
            assert.ok(error instanceof Error, 'invalid images must fail');
            assert.equal(dimensions, undefined);
          }
        });
      `,
      fromAppdmg!.resolve("image-size"),
      filename,
      String(succeeds)
    ],
    { encoding: "utf8", timeout: 5000 }
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return child.stdout;
}

describe.skipIf(process.platform !== "darwin")("DMG background dimensions", () => {
  it("preserves the callback API for the committed normal and retina backgrounds", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const name of ["background.png", "background@2x.png"]) {
      const data = await readFile(path.resolve("assets/dmg", name));
      const result = JSON.parse(await probe(data, true));
      expect(result.type).toBe("png");
      expect(result.width).toBe(name.includes("@2x") ? 1320 : 660);
      expect(result.height).toBe(name.includes("@2x") ? 880 : 440);
    }
  });

  it.each([0, 1, 7, 0xffffffff])("rejects malformed ICNS entry length %i", async (length) => {
    const image = Buffer.alloc(24);
    image.write("icns");
    image.writeUInt32BE(image.length, 4);
    image.write("zzzz", 8);
    image.writeUInt32BE(length, 12);
    await probe(image, false);
  });

  it("rejects truncated image data and forwards missing-file errors", async () => {
    await probe(Buffer.from("not an image"), false);
    await probe(undefined, false);
  });
});
