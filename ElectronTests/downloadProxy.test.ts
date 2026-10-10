// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

function runProbe(source: string, logging: boolean) {
  const child = spawnSync(process.execPath, ["-e", source, require.resolve("@electron/get")], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      ELECTRON_GET_USE_PROXY: "",
      ELECTRON_GET_NO_PROGRESS: "1",
      GLOBAL_AGENT_HTTP_PROXY: "http://127.0.0.1:12345",
      GLOBAL_AGENT_HTTPS_PROXY: "http://127.0.0.1:12345",
      GLOBAL_AGENT_NO_PROXY: "",
      ROARR_LOG: String(logging)
    }
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
}

describe("Electron download proxy dependencies", () => {
  it.each([false, true])("bootstraps with logging enabled=%s", (logging) => {
    runProbe(
      `
        const assert = require('node:assert/strict');
        const records = [];
        require(process.argv[1]).initializeProxy();
        global.ROARR.write = record => records.push(JSON.parse(record));
        assert.ok(global.GLOBAL_AGENT, 'bootstrap must not silently fail');
        global.GLOBAL_AGENT.NO_PROXY = 'example.test';
        if (process.env.ROARR_LOG === 'true') {
          assert.ok(records.length > 0, 'enabled proxy logging must produce valid JSON records');
        } else {
          assert.equal(records.length, 0);
        }
      `,
      logging
    );
  });

  it("forwards Got HTTPS CA, client credentials and SNI without a secureEndpoint flag", () => {
    // A child keeps global-agent's process-wide HTTP patches out of the test worker.
    // Capture the tunnel connection before networking; exercise the actual Got downloader.
    runProbe(
      `
        const assert = require('node:assert/strict');
        const https = require('node:https');
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const { createRequire } = require('node:module');
        const fromGet = createRequire(process.argv[1]);
        require(process.argv[1]).initializeProxy();
        assert.ok(global.GLOBAL_AGENT);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'download-proxy-'));
        let captured;
        let verified = false;
        process.on('beforeExit', () => assert.ok(verified, 'download probe must settle'));
        https.globalAgent.createConnection = (options, callback) => {
          captured = options.tls;
          setImmediate(() => callback(new Error('fixture tunnel stopped')));
        };
        const { GotDownloader } = fromGet('./GotDownloader.js');
        new GotDownloader().download('https://example.test/artifact.zip', path.join(root, 'download'), {
          quiet: true,
          retry: { limit: 0 },
          https: { certificateAuthority: 'fixture CA', certificate: 'fixture certificate', key: 'fixture key' }
        }).then(() => { throw new Error('expected fixture failure'); }).catch(error => {
          assert.match(error.message, /fixture tunnel stopped/);
          assert.equal(captured.ca, 'fixture CA');
          assert.equal(captured.cert, 'fixture certificate');
          assert.equal(captured.key, 'fixture key');
          assert.equal(captured.servername, 'example.test');
          assert.notEqual(captured.rejectUnauthorized, false);
          verified = true;
        }).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
          fs.rmSync(root, { recursive: true, force: true });
        });
      `,
      true
    );
  });
});
