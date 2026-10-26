// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import ts from "typescript";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { buildSelfUpdater } from "../selfUpdatePackaging.config";

const upstream = path.resolve("node_modules/.cache/baseline-sparkle/2.10.1/upstream");
const baseApp = path.resolve("out/Baseline-darwin-arm64/Baseline.app");
const enabled =
  process.env.BASELINE_SELF_UPDATE_FIXTURE_TESTS === "1" &&
  process.platform === "darwin" &&
  process.arch === "arm64";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed.");
});

async function json(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value));
}
async function plist(file: string, value: unknown) {
  await json(file, value);
  execFileSync("/usr/bin/plutil", ["-convert", "xml1", file]);
}

async function disposableKey(root: string) {
  const pair = generateKeyPairSync("ed25519");
  const seed = pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const publicKey = pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  const file = path.join(root, "disposable-test-key");
  await writeFile(file, seed.toString("base64"), { mode: 0o600 });
  return { file, publicKey };
}

async function fixture(mode: string) {
  if (!existsSync(baseApp) || !existsSync(upstream))
    throw new Error("Build Baseline and prepare Sparkle before lifecycle tests.");
  const root = await realpath(await mkdtemp("/tmp/baseline-sparkle-lifecycle-"));
  await chmod(root, 0o700);
  await mkdir(path.join(root, "home"));
  let processesConfirmed = true;
  cleanups.push(async () => {
    if (!processesConfirmed)
      throw new Error(`Fixture process cleanup is unconfirmed; preserving ${root}`);
    await rm(root, { recursive: true, force: true });
  });
  const id = `org.example.baselinefixture.${randomUUID().replaceAll("-", "")}`;
  const cachePaths = [id, id + ".updater"].map((value) =>
    path.join(os.homedir(), "Library/Caches", value)
  );
  if (cachePaths.some(existsSync)) throw new Error("Refusing to reuse fixture cache identity.");
  cleanups.push(async () => {
    if (!processesConfirmed)
      throw new Error("Cannot remove fixture caches before process exit is confirmed.");
    for (const cache of cachePaths) await rm(cache, { recursive: true, force: true });
  });
  const installed = path.join(root, "installed/Fixture.app");
  const incoming = path.join(root, "incoming/Fixture.app");
  const observed = { feed: 0, archive: 0, completed: 0, redirects: 0 };
  const server = createServer((request, response) => {
    if (request.url === "/redirect.zip") {
      observed.redirects++;
      response.writeHead(302, { location: "/update.zip" }).end();
      return;
    }
    const feed = request.url === "/appcast.xml";
    if (!feed && request.url !== "/update.zip") {
      response.writeHead(404).end();
      return;
    }
    if (feed) observed.feed++;
    else observed.archive++;
    if (!feed && mode === "standard-cancel") return;
    response.setHeader("content-type", feed ? "application/xml" : "application/zip");
    response.on("finish", () => observed.completed++);
    createReadStream(path.join(root, feed ? "appcast.xml" : "update.zip")).pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const port = (server.address() as { port: number }).port;
  const feedURL = `http://127.0.0.1:${port}/appcast.xml`;
  const key = await disposableKey(root);
  const configuration = { id, root, mode };
  await mkdir(path.dirname(installed), { recursive: true });
  execFileSync("/bin/cp", ["-cR", baseApp, installed]);
  const contents = path.join(installed, "Contents");
  await rm(path.join(contents, "Resources/app.asar"), { force: true });
  await rm(path.join(contents, "Resources/app.asar.unpacked"), { force: true, recursive: true });
  const app = path.join(contents, "Resources/app");
  await mkdir(path.join(app, "src/main"), { recursive: true });
  await mkdir(path.join(app, "src/shared"), { recursive: true });
  await json(path.join(app, "package.json"), { name: id, version: "1.0.0", main: "fixture.cjs" });
  await json(path.join(app, "fixture.json"), configuration);
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "./profileStatsIntegrity": path.resolve("e2e/profileStatsIntegrity.ts") } },
    plugins: [
      {
        name: "exclude-production-secret-provider",
        moduleParsed(module) {
          if (module.id === path.resolve("src/main/profileStatsIntegrity.ts"))
            throw new Error("Production Keychain provider entered lifecycle fixture.");
        }
      }
    ],
    build: {
      outDir: app,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: path.resolve("ElectronTests/Fixtures/selfUpdatePreparation.ts"),
        formats: ["cjs"],
        fileName: () => "prepare.cjs"
      },
      rollupOptions: { external: [/^node:/, "electron"] }
    }
  });
  for (const source of ["main/signedSelfUpdater", "shared/signedSelfUpdate"]) {
    const result = ts.transpileModule(await readFile(`src/${source}.ts`, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    });
    await writeFile(path.join(app, `src/${source}.js`), result.outputText);
  }
  await writeFile(
    path.join(app, "fixture.cjs"),
    `
    const {app} = require('electron');
    const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
    const config = require('./fixture.json');
    const {SignedSelfUpdater} = require('./src/main/signedSelfUpdater.js');
    const {createPreparation}=require('./prepare.cjs');
    const prepare=createPreparation(config.root,config.mode);
    fs.mkdirSync(path.join(config.root,'profile'),{recursive:true});
    app.setPath('userData',path.join(config.root,'profile')); app.setName(config.id);
    app.disableHardwareAcceleration();
    const record = (name,value) => fs.writeFileSync(path.join(config.root,name),JSON.stringify(value));
    const timer=setTimeout(()=>{record('error.json',{reason:'fixture timeout'});app.quit()},60000);
    app.whenReady().then(async()=>{
      record('host.json',{pid:process.pid,executable:process.execPath,version:app.getVersion()});
      if(app.getVersion()==='2.0.0') {const saved=JSON.parse(fs.readFileSync(path.join(config.root,'profile/baseline-snapshot.json')));record('relaunched.json',{version:app.getVersion(),saved:saved.appearancePreference==='dark'});clearTimeout(timer);app.quit();return}
      const updater=new SignedSelfUpdater({bundlePath:path.resolve(process.resourcesPath,'../..'),resourcesPath:process.resourcesPath,home:config.root,packaged:true,isolatedProfile:false},{
        available:async()=>true,
        spawn:(file,args)=>{
          const child=cp.spawn(file,args,{stdio:'pipe'});
          record('helper.json',{pid:child.pid,executable:file});
          child.stdout.on('data',data=>fs.appendFileSync(path.join(config.root,'events.log'),data));
          child.stderr.on('data',data=>fs.appendFileSync(path.join(config.root,'helper-error.log'),data));
          return child;
        }
      });
      try {await updater.check(async()=>{record('prepare.json',{requested:true});return prepare()},()=>app.quit());record('completed.json',{finished:true})}
      catch(error){record('error.json',{reason:error.message})}
      finally{clearTimeout(timer);app.quit()}
    }).catch(error=>{record('error.json',{reason:error.message});app.quit()});
  `
  );
  // Copy only the authenticated upstream framework already prepared by the pinned tooling.
  await rm(path.join(contents, "Frameworks/Sparkle.framework"), { recursive: true, force: true });
  execFileSync("/bin/cp", [
    "-cR",
    path.join(upstream, "Sparkle.framework"),
    path.join(contents, "Frameworks/Sparkle.framework")
  ]);
  const helperContents = path.join(contents, "Helpers/Baseline Updater.app/Contents");
  await buildSelfUpdater(
    path.join(helperContents, "MacOS/Baseline Updater"),
    path.join(upstream, "Sparkle.framework"),
    process.cwd(),
    { bundleIdentifier: id, feedURL }
  );
  await plist(path.join(helperContents, "Info.plist"), {
    CFBundleIdentifier: `${id}.updater`,
    CFBundleExecutable: "Baseline Updater",
    CFBundleName: "Fixture Updater",
    CFBundlePackageType: "APPL",
    LSUIElement: true,
    NSPrincipalClass: "NSApplication"
  });
  const info = JSON.parse(
    execFileSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", path.join(contents, "Info.plist")],
      { encoding: "utf8" }
    )
  );
  Object.assign(info, {
    CFBundleIdentifier: id,
    CFBundleName: "Baseline",
    CFBundleDisplayName: "Updater Fixture",
    CFBundleShortVersionString: "1.0.0",
    CFBundleVersion: "100",
    LSUIElement: true,
    SUPublicEDKey: key.publicKey,
    SUFeedURL: feedURL,
    BaselineSignedUpdatesEnabled: true,
    SUVerifyUpdateBeforeExtraction: true,
    SURequireSignedFeed: true,
    SUSignedFeedFailureExpirationInterval: 0,
    SUEnableAutomaticChecks: false,
    SUAutomaticallyUpdate: false,
    SUAllowsAutomaticUpdates: false,
    SUEnableSystemProfiling: false,
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true }
  });
  await plist(path.join(contents, "Info.plist"), info);
  // Preserve ordinary OS checks and ad-hoc bundle integrity for both fixture versions.
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", installed], {
    stdio: "pipe"
  });
  await mkdir(path.dirname(incoming), { recursive: true });
  execFileSync("/bin/cp", ["-cR", installed, incoming]);
  const nextApp = path.join(incoming, "Contents/Resources/app");
  await json(path.join(nextApp, "package.json"), {
    name: id,
    version: "2.0.0",
    main: "fixture.cjs"
  });
  await plist(path.join(incoming, "Contents/Info.plist"), {
    ...info,
    CFBundleShortVersionString: "2.0.0",
    CFBundleVersion: "200"
  });
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", incoming], {
    stdio: "pipe"
  });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", incoming], {
    stdio: "pipe"
  });
  const archive = path.join(root, "update.zip");
  execFileSync("/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    incoming,
    archive
  ]);
  const archiveKey =
    mode === "wrong-archive-key" ? await disposableKey(path.dirname(incoming)) : key;
  const signature = execFileSync(
    path.join(upstream, "bin/sign_update"),
    ["--ed-key-file", archiveKey.file, archive],
    { encoding: "utf8" }
  );
  const attrs = signature.trim();
  expect(attrs).toMatch(/sparkle:edSignature=/);
  const appcast = path.join(root, "appcast.xml");
  await writeFile(
    appcast,
    `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Updater fixture</title><item><title>Fixture 2.0.0</title><sparkle:version>200</sparkle:version><sparkle:shortVersionString>2.0.0</sparkle:shortVersionString><sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion><enclosure url="http://127.0.0.1:${port}/${mode.startsWith("redirected-") ? "redirect.zip" : "update.zip"}" type="application/octet-stream" ${attrs}/></item></channel></rss>`
  );
  execFileSync(path.join(upstream, "bin/sign_update"), ["--ed-key-file", key.file, appcast], {
    stdio: "pipe"
  });
  if (mode.endsWith("tampered-archive")) await appendFile(archive, "unauthenticated change");
  if (mode === "tampered-feed")
    await writeFile(
      appcast,
      (await readFile(appcast, "utf8")).replace("Fixture 2.0.0", "Changed 2.0.0")
    );
  // The installer needs only the public key and signatures from this point on.
  await rm(key.file);
  if (archiveKey.file !== key.file) await rm(archiveKey.file);
  const executable = path.join(installed, "Contents/MacOS/Baseline");
  const launched: ChildProcess = spawn(executable, [], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      CFFIXED_USER_HOME: path.join(root, "home"),
      BASELINE_SELF_UPDATE_FIXTURE_MODE: mode
    }
  });
  processesConfirmed = false;
  launched.stderr?.on("data", (data: Buffer) => {
    void writeFile(path.join(root, "host-error.log"), data, { flag: "a" }).catch(() => undefined);
  });
  launched.on("close", (code) => {
    if (!existsSync(path.join(root, "host.json")))
      void json(path.join(root, "error.json"), {
        reason: `Fixture host exited before initialization (${code}).`
      }).catch(() => undefined);
  });
  cleanups.push(async () => {
    for (const record of ["host.json", "helper.json"]) {
      try {
        const owned = JSON.parse(await readFile(path.join(root, record), "utf8"));
        const command = execFileSync("/bin/ps", ["-p", String(owned.pid), "-o", "comm="], {
          encoding: "utf8"
        }).trim();
        if (command === owned.executable && command.startsWith(root + "/"))
          process.kill(owned.pid, "SIGTERM");
      } catch {
        /* Already exited, or ownership could not be established. */
      }
    }
    // Wait for only fixture-owned executable paths; do not infer cleanup from runner exit.
    const deadline = Date.now() + 5000;
    for (;;) {
      const running: number[] = [];
      try {
        const matches = execFileSync("/usr/bin/pgrep", ["-f", root + "|" + id], {
          encoding: "utf8"
        })
          .trim()
          .split(/\s+/);
        for (const match of matches) {
          if (!/^\d+$/.test(match)) continue;
          const command = execFileSync("/bin/ps", ["-p", match, "-o", "comm="], {
            encoding: "utf8"
          }).trim();
          if ([root, ...cachePaths].some((owned) => command.startsWith(owned + "/")))
            running.push(Number(match));
        }
      } catch (error) {
        if ((error as { status?: number }).status !== 1) throw error;
      }
      if (!running.length) {
        processesConfirmed = true;
        break;
      }
      for (const pid of running) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* Already exited. */
        }
      }
      if (Date.now() > deadline)
        throw new Error("Could not confirm owned fixture processes stopped.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  return { root, installed, observed, launched };
}

async function waitForOutcome(f: Awaited<ReturnType<typeof fixture>>) {
  const deadline = Date.now() + 60000;
  while (
    !existsSync(path.join(f.root, "relaunched.json")) &&
    !existsSync(path.join(f.root, "error.json")) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  for (const file of ["events.log", "helper-error.log", "host-error.log"])
    if (existsSync(path.join(f.root, file)))
      console.error(file, (await readFile(path.join(f.root, file), "utf8")).slice(-10000));
  return existsSync(path.join(f.root, "error.json"))
    ? JSON.parse(await readFile(path.join(f.root, "error.json"), "utf8"))
    : undefined;
}

describe.skipIf(!enabled)("authenticated isolated Sparkle lifecycle", () => {
  it.each(["valid", "delayed-save", "redirected-valid"])(
    "downloads, verifies, installs and relaunches with %s persistence",
    async (mode) => {
      const f = await fixture(mode);
      try {
        const error = await waitForOutcome(f);
        expect(error).toBeUndefined();
        expect(JSON.parse(await readFile(path.join(f.root, "relaunched.json"), "utf8"))).toEqual({
          version: "2.0.0",
          saved: true
        });
        expect(f.observed.feed).toBeGreaterThan(0);
        expect(f.observed.archive).toBeGreaterThan(0);
        if (mode.startsWith("redirected-")) expect(f.observed.redirects).toBeGreaterThan(0);
        if (mode === "delayed-save")
          expect(
            JSON.parse(await readFile(path.join(f.root, "saved.json"), "utf8")).elapsed
          ).toBeGreaterThanOrEqual(31000);
      } catch (error) {
        console.error("observed requests", f.observed);
        // Public diagnostics only. Disposable private seed is never printed or retained.
        for (const file of ["events.log", "helper-error.log", "host-error.log"])
          if (existsSync(path.join(f.root, file)))
            console.error(file, (await readFile(path.join(f.root, file), "utf8")).slice(-10000));
        throw error;
      }
    },
    180000
  );

  it.each(["cancel-ready", "standard-cancel"])(
    "cancels %s without install-on-quit",
    async (mode) => {
      const f = await fixture(mode);
      const deadline = Date.now() + 60000;
      while (
        !existsSync(path.join(f.root, "completed.json")) &&
        !existsSync(path.join(f.root, "error.json")) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      expect(existsSync(path.join(f.root, "completed.json"))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(existsSync(path.join(f.root, "prepare.json"))).toBe(false);
      if (mode === "standard-cancel") {
        expect(await readFile(path.join(f.root, "helper-error.log"), "utf8")).toContain(
          "fixture: standard UI cancel download"
        );
        expect(f.observed.archive).toBeGreaterThan(0);
      }
      expect(existsSync(path.join(f.root, "relaunched.json"))).toBe(false);
      expect(
        execFileSync(
          "/usr/libexec/PlistBuddy",
          [
            "-c",
            "Print :CFBundleShortVersionString",
            path.join(f.installed, "Contents/Info.plist")
          ],
          { encoding: "utf8" }
        ).trim()
      ).toBe("1.0.0");
    },
    180000
  );

  it.each([
    "tampered-feed",
    "tampered-archive",
    "wrong-archive-key",
    "save-fail",
    "redirected-tampered-archive"
  ])(
    "refuses %s without replacing or relaunching the original app",
    async (mode) => {
      const f = await fixture(mode);
      const error = await waitForOutcome(f);
      expect(error?.reason).toMatch(/update|save/i);
      // Allow an already-staged installer to observe the old host's termination.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(existsSync(path.join(f.root, "relaunched.json"))).toBe(false);
      const version = execFileSync(
        "/usr/libexec/PlistBuddy",
        ["-c", "Print :CFBundleShortVersionString", path.join(f.installed, "Contents/Info.plist")],
        { encoding: "utf8" }
      ).trim();
      expect(version).toBe("1.0.0");
      expect(existsSync(path.join(f.root, "saved.json"))).toBe(false);
      expect(existsSync(path.join(f.root, "prepare.json"))).toBe(mode === "save-fail");
      expect(f.observed.feed).toBeGreaterThan(0);
      expect(f.observed.archive > 0).toBe(mode !== "tampered-feed");
      if (mode.startsWith("redirected-")) expect(f.observed.redirects).toBeGreaterThan(0);
    },
    180000
  );
});
