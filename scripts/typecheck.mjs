// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { spawnSync } from "node:child_process";
import process from "node:process";
import console from "node:console";
import { fileURLToPath, URL } from "node:url";

// tsrs 0.18 ships macOS arm64 and Linux x64/arm64 binaries only.
const supported =
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "linux" && ["x64", "arm64"].includes(process.arch));

if (!supported) {
  console.error(
    `Type checking requires tsrs on macOS arm64 or Linux x64/arm64; ${process.platform}/${process.arch} is unsupported.`
  );
  process.exit(1);
}

const checker = fileURLToPath(new URL("../node_modules/tsrs/bin/tsrs", import.meta.url));
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
