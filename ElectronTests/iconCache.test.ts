// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { mkdtemp, rm, symlink, writeFile, rename, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconCache } from "../src/main/iconCache";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "baseline-icon-cache-"));
  directories.push(directory);
  const icon = path.join(directory, "Audit.icns");
  await writeFile(icon, "first");
  const load = vi.fn(async () => ({ dataURL: "data:image/png;base64,fixture" }));
  return { directory, icon, load, cache: new IconCache(load) };
}

describe("fingerprinted icon caching", () => {
  it("shares unchanged loads, including canonical aliases", async () => {
    const { directory, icon, load, cache } = await fixture();
    const alias = path.join(directory, "Alias.icns");
    await symlink(icon, alias);
    const [one, two] = await Promise.all([cache.get(icon), cache.get(alias)]);
    expect(two).toEqual(one);
    expect(await cache.get(icon)).toEqual(one);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads changed and replaced files, including replacements with matching size and mtime", async () => {
    const { directory, icon, load, cache } = await fixture();
    await cache.get(icon);
    await writeFile(icon, "longer version");
    await cache.get(icon);
    const timestamp = new Date("2026-10-01T00:00:00Z");
    await utimes(icon, timestamp, timestamp);
    await cache.get(icon);
    const replacement = path.join(directory, "replacement.icns");
    await writeFile(replacement, "longer version");
    await utimes(replacement, timestamp, timestamp);
    await rename(replacement, icon);
    await cache.get(icon);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("does not retain missing icons and keeps Electron padding policy separate", async () => {
    const { directory, icon, load, cache } = await fixture();
    const missing = path.join(directory, "New.icns");
    expect(await cache.get(missing)).toEqual({});
    await writeFile(missing, "new");
    await cache.get(missing);
    await cache.get(icon);
    const generic = path.join(directory, "electron.icns");
    await symlink(icon, generic);
    await cache.get(generic);
    expect(load).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenLastCalledWith(generic);
  });

  it("retries empty/failed conversions after a short delay", async () => {
    const { icon } = await fixture();
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ dataURL: "recovered" });
    const cache = new IconCache(load);
    await cache.get(icon);
    await cache.get(icon);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(await cache.get(icon)).toEqual({ dataURL: "recovered" });
  });

  it("evicts the least recently used icon by entry count and byte budget", async () => {
    const { directory, icon, load } = await fixture();
    const second = path.join(directory, "Second.icns");
    const third = path.join(directory, "Third.icns");
    await writeFile(second, "second");
    await writeFile(third, "third");
    const cache = new IconCache(load, 2, 1_000);
    await cache.get(icon);
    await cache.get(second);
    await cache.get(icon);
    await cache.get(third);
    await cache.get(icon);
    expect(load).toHaveBeenCalledTimes(3);
    await cache.get(second);
    expect(load).toHaveBeenCalledTimes(4);
    const byteCache = new IconCache(load, 10, 60);
    await byteCache.get(icon);
    await byteCache.get(second);
    await byteCache.get(icon);
    expect(load).toHaveBeenCalledTimes(7);
  });
});
