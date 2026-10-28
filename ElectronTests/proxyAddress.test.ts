// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fromSocks = createRequire(require.resolve("socks"));

it("rejects adversarial IPv6 zones promptly while preserving ordinary proxy addresses", () => {
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      String.raw`
        const assert = require('node:assert/strict');
        const { Address6 } = require(process.argv[1]);
        for (const ending of ['\n', '\r', '\u2028', '\u2029']) {
          assert.equal(Address6.isValid('%'.repeat(300000) + ending), false);
        }
        for (const address of ['::1', 'fe80::1%en0', '::ffff:192.0.2.1']) {
          assert.ok(Address6.isValid(address), address);
        }
        assert.equal(Address6.fromUnsignedByteArray(new Array(16).fill(0)).correctForm(), '::');
      `,
      fromSocks.resolve("ip-address")
    ],
    { encoding: "utf8", timeout: 5000 }
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
});
