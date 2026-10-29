// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { build } from "vite";
import { builtinModules, createRequire } from "node:module";
import { access, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (["--prepare", "--hidden"].includes(key)) options.set(key, true);
  else if (
    ["--profile", "--snapshot", "--fixture-notes", "--route"].includes(key) &&
    args[i + 1] &&
    !args[i + 1].startsWith("--")
  )
    options.set(key, args[++i]);
  else throw new Error(`Unknown or incomplete preview option: ${key}`);
}
const renderer = path.join(root, ".vite", "renderer", "main_window", "index.html");
const preload = path.join(root, ".vite", "build", "preload.js");
await Promise.all([access(renderer), access(preload)]).catch(() => {
  throw new Error(
    "Build the prototype first with npm run build. The preview never launches the production application."
  );
});
const output = path.join(root, ".vite", "notes-preview");
await mkdir(output, { recursive: true });
await build({
  configFile: false,
  logLevel: "error",
  build: {
    outDir: output,
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: path.join(root, "preview", "main.ts"),
      formats: ["cjs"],
      fileName: () => "main.cjs"
    },
    rollupOptions: {
      external: ["electron", ...builtinModules.flatMap((name) => [name, `node:${name}`])]
    }
  }
});
const entry = path.join(output, "main.cjs");
if (options.has("--prepare")) console.log(JSON.stringify({ root, entry, preload, renderer }));
else {
  const require = createRequire(import.meta.url);
  const env = { ...process.env, BASELINE_NOTES_PREVIEW_ROOT: root };
  if (options.has("--hidden")) env.BASELINE_NOTES_PREVIEW_HIDDEN = "1";
  for (const [flag, name] of [
    ["--profile", "PROFILE"],
    ["--snapshot", "SNAPSHOT"],
    ["--fixture-notes", "FIXTURE_NOTES"],
    ["--route", "ROUTE"]
  ])
    if (options.has(flag)) env[`BASELINE_NOTES_PREVIEW_${name}`] = pathFor(flag, options.get(flag));
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [entry], { cwd: root, env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
function pathFor(flag, value) {
  return flag === "--route" ? value : path.resolve(value);
}
