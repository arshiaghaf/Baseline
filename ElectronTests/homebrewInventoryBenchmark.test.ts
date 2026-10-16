// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import seed from "./Fixtures/homebrew_installed_inventory.json";
import { HomebrewInventoryClient } from "../src/main/homebrewInventoryClient";
import { runCommand, type CommandResult } from "../src/main/commandRunner";

// Opt-in reproducible transport probe, not a product performance assertion.
it.skipIf(process.env.BASELINE_INVENTORY_BENCHMARK !== "1")(
  "compares the original six-read schedule and combined inventory using fake child processes",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "baseline-inventory-bench-"));
    const executable = path.join(root, "fake-brew.cjs");
    try {
      await writeFile(
        executable,
        `
const fs = require('node:fs');
const responses = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const command = process.argv.slice(3).join(' ');
if (!(command in responses)) process.exit(2);
setTimeout(() => {
  process.stdout.write(responses[command]);
  process.stderr.write('fixture peak RSS KiB=' + process.resourceUsage().maxRSS + '\\n');
}, 10);
`
      );
      const rows: unknown[] = [];
      for (const additionalPerKind of [0, 200]) {
        const fixture = scaledFixture(additionalPerKind);
        const responses = {
          "list --formula --versions": fixture.formulaVersions,
          "list --cask --versions": fixture.caskVersions,
          "outdated --formula --json=v2": JSON.stringify(fixture.formulaOutdated),
          "outdated --cask --greedy --json=v2": JSON.stringify(fixture.caskOutdated),
          "info --installed --json=v2": JSON.stringify(fixture.info),
          "info --formula --installed --json=v2": JSON.stringify({
            formulae: fixture.info.formulae
          }),
          "info --cask --installed --json=v2": JSON.stringify({ casks: fixture.info.casks })
        };
        const fixturePath = path.join(root, `responses-${additionalPerKind}.json`);
        await writeFile(fixturePath, JSON.stringify(responses));
        const measurements = { legacy: [] as number[], combined: [] as number[] };
        const peaks = { legacy: [] as number[], combined: [] as number[] };
        for (let sample = 0; sample < 6; sample++) {
          // Alternate order to reduce a systematic warm-cache/order advantage.
          for (const plan of sample % 2
            ? (["combined", "legacy"] as const)
            : (["legacy", "combined"] as const)) {
            let count = 0;
            let peak = 0;
            const run = async (args: string[]) => {
              count++;
              const result = await runCommand(process.execPath, [executable, fixturePath, ...args]);
              expect(result.success).toBe(true);
              peak = Math.max(peak, Number(result.stderr?.match(/RSS KiB=(\d+)/u)?.[1] ?? 0));
              return result;
            };
            const started = performance.now();
            const result =
              plan === "legacy"
                ? await legacyInventory(run)
                : await new HomebrewInventoryClient(run).fetchInventory();
            const elapsed = performance.now() - started;
            expect(count).toBe(plan === "legacy" ? 6 : 5);
            expect(result.items).toHaveLength(7 + additionalPerKind * 2);
            expect(result.warning).toBeUndefined();
            if (sample > 0) {
              measurements[plan].push(elapsed);
              peaks[plan].push(peak);
            }
          }
        }
        // Re-run once outside the measurements to compare complete backend results.
        const run = (args: string[]) =>
          runCommand(process.execPath, [executable, fixturePath, ...args]);
        expect(await new HomebrewInventoryClient(run).fetchInventory()).toEqual(
          await legacyInventory(run)
        );
        rows.push({
          fixtureItems: 7 + additionalPerKind * 2,
          samplesPerPlan: 5,
          subprocesses: { legacy: 6, combined: 5 },
          medianMilliseconds: {
            legacy: median(measurements.legacy),
            combined: median(measurements.combined)
          },
          maximumFakeChildRSSKiB: {
            legacy: Math.max(...peaks.legacy),
            combined: Math.max(...peaks.combined)
          }
        });
      }
      console.log(
        JSON.stringify(
          {
            note: "Synthetic Node children with fixed 10ms work; not Homebrew/product latency or memory.",
            node: process.version,
            platform: `${process.platform}/${process.arch}`,
            rows
          },
          null,
          2
        )
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000
);

/** Original transport schedule at 6f07aca, with the preserved parser/identity path. */
async function legacyInventory(run: (args: string[]) => Promise<CommandResult>) {
  const lists = [
    ["list", "--formula", "--versions"],
    ["list", "--cask", "--versions"]
  ];
  const metadata = [
    ["outdated", "--formula", "--json=v2"],
    ["outdated", "--cask", "--greedy", "--json=v2"],
    ["info", "--cask", "--installed", "--json=v2"],
    ["info", "--formula", "--installed", "--json=v2"]
  ];
  const responses = new Map<string, CommandResult>();
  for (const batch of [lists, metadata]) {
    await Promise.all(batch.map(async (args) => responses.set(args.join(" "), await run(args))));
  }
  // Replay captured reads in memory: no seventh child is launched for the probe.
  return new HomebrewInventoryClient(
    async (args) => responses.get(args.join(" ")) ?? { success: false, status: 1, output: "" }
  ).fetchInventory();
}

function median(values: number[]): number {
  return Number([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!.toFixed(2));
}

function scaledFixture(additionalPerKind: number) {
  const result: {
    formulaVersions: string;
    caskVersions: string;
    info: { formulae: Record<string, unknown>[]; casks: Record<string, unknown>[] };
    formulaOutdated: { formulae: Record<string, unknown>[] };
    caskOutdated: { casks: Record<string, unknown>[] };
  } = structuredClone(seed);
  for (let i = 0; i < additionalPerKind; i++) {
    const token = `fixture-${i}`;
    result.formulaVersions += `${token} 1.0_1 1.0_2\n`;
    result.caskVersions += `${token} 1.0,100\n`;
    result.info.formulae.push({
      name: token,
      full_name: token,
      tap: "homebrew/core",
      installed: [{ version: "1.0_2", installed_on_request: true, installed_as_dependency: false }]
    });
    result.info.casks.push({
      token,
      full_token: token,
      tap: "homebrew/cask",
      installed: "1.0,100",
      version: "2.0,200",
      outdated: false,
      auto_updates: true,
      pinned: i % 3 === 0,
      depends_on: { formula: [], cask: [] },
      artifacts: [{ app: [`${token}.app`] }]
    });
    if (i % 2 === 0) {
      result.formulaOutdated.formulae.push({ name: token, current_version: "2.0_1" });
      result.caskOutdated.casks.push({ name: token, current_version: "2.0,200" });
    }
  }
  return result;
}
