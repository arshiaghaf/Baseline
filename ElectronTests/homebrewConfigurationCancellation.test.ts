// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CommandPreflight } from "../src/main/commandPreflight";

const fixture = vi.hoisted(() => ({
  file: "",
  stage: "",
  wait: async () => {},
  opened: 0,
  reads: 0,
  closed: 0
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (args[0] !== fixture.file) return fs.open(...args);
      if (fixture.stage === "open") await fixture.wait();
      const handle = await fs.open(...args);
      fixture.opened++;
      return {
        stat: handle.stat.bind(handle),
        read: async (...readArgs: Parameters<typeof handle.read>) => {
          fixture.reads++;
          if (fixture.stage === "read") await fixture.wait();
          return handle.read(...readArgs);
        },
        close: async () => {
          if (fixture.stage.startsWith("close")) await fixture.wait();
          await handle.close();
          fixture.closed++;
          if (fixture.stage === "close-rejection") throw new Error("fixture late close rejection");
        }
      };
    }
  };
});
import { checkHomebrewConfiguration } from "../src/main/homebrewConfiguration";

let root = "";
let release: (() => void) | undefined;
let operation: Promise<unknown> | undefined;
afterEach(async () => {
  release?.();
  await operation;
  if (root) await rm(root, { recursive: true, force: true });
});

it.each(
  ["open", "read", "close", "close-rejection"].flatMap((stage) =>
    ["timeout", "cancelled"].map((kind) => [stage, kind])
  )
)("closes an eventual descriptor after %s %s", async (stage, kind) => {
  root = await realpath(await mkdtemp("/tmp/baseline-config-cancellation-"));
  const executable = path.join(root, "prefix/bin/brew");
  fixture.file = path.join(root, "prefix/etc/homebrew/brew.env");
  for (const file of [executable, fixture.file]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
  }
  fixture.stage = stage;
  fixture.opened = 0;
  fixture.reads = 0;
  fixture.closed = 0;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  fixture.wait = () => {
    reached();
    return blocked;
  };
  const abort = new AbortController();
  operation = checkHomebrewConfiguration(executable, { HOME: root }, abort.signal);
  await Promise.race([
    ready,
    operation.then(() => {
      throw new Error("Fixture did not reach the gated descriptor.");
    })
  ]);
  const budget = new CommandPreflight(kind === "timeout" ? 10 : 0, abort.signal);
  budget.cancellationSignal.addEventListener("abort", () => abort.abort(), { once: true });
  try {
    const bounded = budget.run(() => operation!);
    if (kind === "cancelled") abort.abort();
    await expect(bounded).rejects.toMatchObject({ failure: { kind } });
    expect(fixture.closed).toBe(0);
    release!();
    await operation;
    expect(fixture.opened).toBe(1);
    expect(fixture.closed).toBe(1);
    expect(fixture.reads).toBe(stage === "open" ? 0 : 1);
  } finally {
    budget.dispose();
  }
});
