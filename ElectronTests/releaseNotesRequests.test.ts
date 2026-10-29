// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { expect, it } from "vitest";
import { ReleaseNotesRequests } from "../src/main/releaseNotesRequests";
import type { ReleaseNotesResult } from "../src/shared/releaseNotes";

const target = { kind: "app" as const, id: "app:example", version: "2" };

it("scopes cancellation to the authenticated renderer and releases admission after settling", async () => {
  const signals: AbortSignal[] = [];
  const complete: Array<(value: ReleaseNotesResult) => void> = [];
  const manager = new ReleaseNotesRequests({
    getNotes: async (_target, { signal }) => {
      signals.push(signal);
      return new Promise<ReleaseNotesResult>((resolve) => complete.push(resolve));
    }
  });
  const main = manager.get(1, { requestID: "same", target });
  const tray = manager.get(2, { requestID: "same", target });
  manager.cancel(1, "same");
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[1]!.aborted).toBe(false);
  manager.close(2);
  expect(signals[1]!.aborted).toBe(true);
  const result = { status: "unavailable" as const, title: "Release notes", version: "2" };
  for (const resolve of complete) resolve(result);
  await Promise.all([main, tray]);
  expect(
    await new ReleaseNotesRequests({ getNotes: async () => result }).get(1, {
      requestID: "new",
      target
    })
  ).toEqual(result);
});

it("bounds each renderer's pending work without blocking another renderer", async () => {
  const complete: Array<(value: ReleaseNotesResult) => void> = [];
  const manager = new ReleaseNotesRequests({
    getNotes: async () => new Promise<ReleaseNotesResult>((resolve) => complete.push(resolve))
  });
  const pending = Array.from({ length: 16 }, (_, i) =>
    manager.get(1, { requestID: `notes:${i}`, target })
  );
  const rejected = await manager.get(1, { requestID: "overflow", target });
  expect(rejected.status).toBe("error");
  const other = manager.get(2, { requestID: "other", target });
  expect(complete).toHaveLength(17);
  const result = { status: "unavailable" as const, title: "Release notes", version: "2" };
  for (const resolve of complete) resolve(result);
  await Promise.all([...pending, other]);
});
