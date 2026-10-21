// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";
import console from "node:console";
import { fileURLToPath, URL } from "node:url";

const require = createRequire(import.meta.url);
// tsrs 0.18 ships macOS arm64 and Linux x64/arm64 binaries only.
const supported =
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "linux" && ["x64", "arm64"].includes(process.arch));

if (!supported) {
  console.error(
    `tsrs does not support ${process.platform}/${process.arch}; using TypeScript 6 for type checking.`
  );
}

const checker = supported
  ? fileURLToPath(new URL("../node_modules/tsrs/bin/tsrs", import.meta.url))
  : require.resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [checker, "--noEmit", ...process.argv.slice(2)], {
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
