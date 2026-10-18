// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import type { AppRecord, UpdateRecord, AppProviderCheck } from "../src/shared/domain";
import { emptyHomebrewCaskIndex } from "../src/shared/domain";
import { version } from "../src/shared/version";
import { lookupAppUpdates } from "../src/main/appUpdateLookupService";

const app: AppRecord = {
  id: "example",
  bundlePath: "/Applications/Example.app",
  displayName: "Example",
  bundleIdentifier: "com.example.app",
  localVersion: version("1.0"),
  sparkleFeedURL: "https://example.com/appcast.xml",
  sourceHint: "unknown"
};

function input(previousUpdates: UpdateRecord[] = []) {
  return {
    apps: [app],
    previousUpdates: new Map(previousUpdates.map((update) => [update.appID, update])),
    homebrewItems: [],
    homebrewIndex: emptyHomebrewCaskIndex,
    now: "2026-10-16T00:00:00.000Z",
    force: true,
    signal: new AbortController().signal,
    isCurrent: () => true,
    isSelfApp: () => false,
    canUseHomebrewAppUpdate: () => false
  };
}

describe("lookupAppUpdates", () => {
  it("keeps App Store precedence when all sources could offer an update", async () => {
    const sparkle = vi.fn();
    const homebrew = vi.fn();
    const updates = await lookupAppUpdates(
      {
        appStore: {
          lookupOutcome: vi.fn().mockResolvedValue({
            type: "completed",
            value: { remoteVersion: version("2.0") }
          })
        },
        sparkle: { lookupOutcome: sparkle },
        homebrew: { lookupUpdate: homebrew }
      },
      input()
    );
    expect(updates).toMatchObject([{ appID: "example", source: "appStore" }]);
    expect(sparkle).not.toHaveBeenCalled();
    expect(homebrew).not.toHaveBeenCalled();
  });

  it("retains a still-valid App Store update on transient failure", async () => {
    const previous: UpdateRecord = {
      id: app.id,
      appID: app.id,
      source: "appStore",
      supportLevel: "supported",
      localVersion: app.localVersion,
      remoteVersion: version("2.0"),
      checkedAt: "2026-10-15T00:00:00.000Z"
    };
    const sparkle = vi.fn();
    const updates = await lookupAppUpdates(
      {
        appStore: { lookupOutcome: vi.fn().mockResolvedValue({ type: "transientFailure" }) },
        sparkle: { lookupOutcome: sparkle },
        homebrew: { lookupUpdate: vi.fn() }
      },
      input([previous])
    );
    expect(updates).toEqual([previous]);
    expect(sparkle).not.toHaveBeenCalled();
  });

  it("discards partial results when the generation is superseded during lookup", async () => {
    let current = true;
    const updates = await lookupAppUpdates(
      {
        appStore: {
          lookupOutcome: vi.fn().mockImplementation(async () => {
            current = false;
            return { type: "completed", value: { remoteVersion: version("2.0") } };
          })
        },
        sparkle: { lookupOutcome: vi.fn() },
        homebrew: { lookupUpdate: vi.fn() }
      },
      { ...input(), isCurrent: () => current }
    );
    expect(updates).toBeUndefined();
  });
});

describe("durable provider routing", () => {
  const identity = { productID: 123, platform: "mac" as const, storefront: "us" };
  const base = { ...app, sparkleFeedURL: undefined, providerFingerprint: "installation-a" };
  const checkedAt = "2026-10-15T00:00:00.000Z";
  function clients(outcome: object = { type: "completed" }) {
    return {
      appStore: {
        lookupOutcome: vi.fn().mockResolvedValue(outcome),
        lookupOutcomes: vi.fn(async () => [outcome])
      },
      sparkle: {
        lookupOutcome: vi.fn().mockResolvedValue({ type: "completed", providerFound: true })
      },
      homebrew: { lookupUpdate: vi.fn() }
    } as unknown as Parameters<typeof lookupAppUpdates>[0];
  }
  function prior(patch: Partial<AppProviderCheck> = {}) {
    return {
      [base.id]: {
        fingerprint: "installation-a",
        storefront: "us",
        status: "unresolved" as const,
        discoveryCheckedAt: input().now,
        ...patch
      }
    };
  }
  async function run(
    source: ReturnType<typeof clients>,
    patch: Partial<Parameters<typeof lookupAppUpdates>[1]> = {}
  ) {
    let checks: Record<string, AppProviderCheck> = {};
    const updates = await lookupAppUpdates(source, {
      ...input(),
      apps: [base],
      ...patch,
      onProgress: (next) => {
        checks = next;
      }
    });
    return { updates, checks };
  }

  it("retains a current product identity without creating an update and refreshes it after relaunch", async () => {
    const source = clients({ type: "completed", identity, checkedAt: input().now });
    const first = await run(source);
    expect(first.updates).toEqual([]);
    expect(first.checks[base.id]).toMatchObject({
      appStoreIdentity: identity,
      status: "checked",
      checkedAt: input().now
    });
    const secondSource = clients({
      type: "completed",
      identity,
      value: { remoteVersion: version("2"), appStoreItemID: 123 }
    });
    const second = await run(secondSource, {
      previousChecks: JSON.parse(JSON.stringify(first.checks))
    });
    expect(secondSource.appStore.lookupOutcomes).toHaveBeenCalledWith(
      [expect.objectContaining({ identity, localVersion: version("1.0") })],
      expect.objectContaining({ force: true })
    );
    expect(second.updates).toMatchObject([
      { appID: base.id, source: "appStore", remoteVersion: version("2") }
    ]);
  });

  it.each([false, true])(
    "keeps checking an actionable Apple source without a product ID (force=%s)",
    async (force) => {
      const currentApp = { ...base, sparkleFeedURL: app.sparkleFeedURL };
      const source = clients({
        type: "completed",
        value: { remoteVersion: version("2") },
        checkedAt: input().now
      });
      const first = await run(source, {
        apps: [currentApp],
        forceAppDiscovery: true,
        previousChecks: prior({
          status: "checked",
          source: "sparkle",
          sparkleFeedURL: app.sparkleFeedURL,
          checkedAt
        })
      });
      expect(first.checks[base.id]).toMatchObject({ source: "appStore", status: "checked" });
      expect(first.checks[base.id]?.appStoreIdentity).toBeUndefined();

      const nextCheck = "2026-10-16T00:01:00.000Z";
      vi.mocked(source.appStore.lookupOutcomes!).mockResolvedValue([
        { type: "completed", value: { remoteVersion: version("3") }, checkedAt: nextCheck }
      ]);
      const second = await run(source, {
        apps: [currentApp],
        force,
        now: nextCheck,
        previousChecks: first.checks,
        previousUpdates: new Map(first.updates!.map((update) => [update.appID, update]))
      });
      expect(source.appStore.lookupOutcomes).toHaveBeenCalledTimes(2);
      expect(second.updates).toMatchObject([
        { appID: base.id, source: "appStore", remoteVersion: version("3"), checkedAt: nextCheck }
      ]);
      expect(second.checks[base.id]).toMatchObject({
        source: "appStore",
        status: "checked",
        checkedAt: nextCheck
      });
      expect(source.sparkle.lookupOutcome).not.toHaveBeenCalled();
    }
  );

  const previousAppleUpdate: UpdateRecord = {
    id: base.id,
    appID: base.id,
    source: "appStore",
    supportLevel: "supported",
    localVersion: base.localVersion,
    remoteVersion: version("2"),
    appStoreItemID: identity.productID,
    checkedAt
  };

  it.each([
    { forceAppDiscovery: false, now: "2026-10-16T06:00:00.000Z", expectedForce: false },
    { forceAppDiscovery: true, now: "2026-10-16T00:01:00.000Z", expectedForce: true }
  ])(
    "confirms a known product when broader discovery omits it: %j",
    async ({ expectedForce, ...patch }) => {
      const source = clients({ type: "completed", discovered: true, checkedAt: patch.now });
      const numericCheckedAt = new Date(Date.parse(patch.now) + 1000).toISOString();
      vi.mocked(source.appStore.lookupOutcome).mockResolvedValue({
        type: "completed",
        discovered: false,
        identity,
        checkedAt: numericCheckedAt,
        value: { remoteVersion: version("3"), appStoreItemID: identity.productID }
      });
      const result = await run(source, {
        ...patch,
        force: false,
        previousChecks: prior({
          status: "checked",
          source: "appStore",
          appStoreIdentity: identity
        }),
        previousUpdates: new Map([[base.id, previousAppleUpdate]])
      });
      expect(source.appStore.lookupOutcomes).toHaveBeenCalledWith(
        [expect.objectContaining({ identity: undefined })],
        expect.anything()
      );
      expect(source.appStore.lookupOutcome).toHaveBeenCalledWith(
        base.bundleIdentifier,
        base.localVersion,
        expect.objectContaining({ identity, force: expectedForce })
      );
      expect(result.updates).toMatchObject([
        { source: "appStore", remoteVersion: version("3"), checkedAt: numericCheckedAt }
      ]);
      expect(result.checks[base.id]).toMatchObject({
        status: "checked",
        appStoreIdentity: identity,
        checkedAt: numericCheckedAt,
        discoveryCheckedAt: patch.now
      });
    }
  );

  it.each([
    {
      name: "current",
      numericOutcome: { type: "completed", identity, discovered: false, checkedAt: input().now },
      status: "checked",
      retained: false,
      product: identity
    },
    {
      name: "missing",
      numericOutcome: { type: "completed", discovered: false, checkedAt: input().now },
      status: "unresolved",
      retained: false,
      product: undefined
    },
    {
      name: "failed",
      numericOutcome: { type: "transientFailure" },
      status: "failed",
      retained: true,
      product: identity
    }
  ] as const)(
    "handles a $name numeric confirmation after a broader no-match",
    async ({ numericOutcome, status, retained, product }) => {
      const source = clients({ type: "completed", discovered: true, checkedAt: input().now });
      vi.mocked(source.appStore.lookupOutcome).mockResolvedValue(numericOutcome);
      const result = await run(source, {
        forceAppDiscovery: true,
        previousChecks: prior({
          status: "checked",
          source: "appStore",
          appStoreIdentity: identity,
          checkedAt
        }),
        previousUpdates: new Map([[base.id, previousAppleUpdate]])
      });
      expect(source.appStore.lookupOutcome).toHaveBeenCalledTimes(1);
      expect(result.updates).toEqual(retained ? [previousAppleUpdate] : []);
      expect(result.checks[base.id]).toMatchObject({ status, discoveryCheckedAt: input().now });
      expect(result.checks[base.id]?.appStoreIdentity).toEqual(product);
      if (retained) expect(result.checks[base.id]?.checkedAt).toBe(checkedAt);
    }
  );

  it("adopts a confirmed replacement from broader discovery without reusing the old product", async () => {
    const replacement = { ...identity, productID: 456 };
    const source = clients({
      type: "completed",
      discovered: true,
      identity: replacement,
      checkedAt: input().now,
      value: { remoteVersion: version("4"), appStoreItemID: replacement.productID }
    });
    const result = await run(source, {
      forceAppDiscovery: true,
      previousChecks: prior({ status: "checked", source: "appStore", appStoreIdentity: identity }),
      previousUpdates: new Map([[base.id, previousAppleUpdate]])
    });
    expect(source.appStore.lookupOutcome).not.toHaveBeenCalled();
    expect(result.checks[base.id]?.appStoreIdentity).toEqual(replacement);
    expect(result.updates).toMatchObject([{ remoteVersion: version("4"), appStoreItemID: 456 }]);
  });

  it("drains a started product confirmation before completing a cancelled generation", async () => {
    const source = clients({ type: "completed", discovered: true, checkedAt: input().now });
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let started = false;
    vi.mocked(source.appStore.lookupOutcome).mockImplementation(async () => {
      started = true;
      await gate;
      return { type: "completed", identity, value: { remoteVersion: version("3") } };
    });
    const task = run(source, {
      forceAppDiscovery: true,
      signal: controller.signal,
      previousChecks: prior({ status: "checked", source: "appStore", appStoreIdentity: identity }),
      previousUpdates: new Map([[base.id, previousAppleUpdate]])
    });
    let settled = false;
    const observed = task.then((result) => {
      settled = true;
      return result;
    });
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      controller.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      expect((await observed).updates).toBeUndefined();
    } finally {
      release();
      await Promise.allSettled([task, observed]);
    }
  });

  it("keeps cached no-match searches visibly unresolved and forces an explicit source search", async () => {
    const source = clients();
    const result = await run(source, { previousChecks: prior(), force: false });
    expect(source.appStore.lookupOutcomes).not.toHaveBeenCalled();
    expect(result.checks[base.id]).toMatchObject({
      status: "unresolved",
      discoveryCheckedAt: input().now
    });
    expect(result.checks[base.id]?.checkedAt).toBeUndefined();
    await run(source, { previousChecks: result.checks, forceAppDiscovery: true });
    expect(source.appStore.lookupOutcomes).toHaveBeenCalledTimes(1);
    await run(source, {
      previousChecks: prior({ discoveryCheckedAt: "2026-10-15T18:00:00.000Z" })
    });
    expect(source.appStore.lookupOutcomes).toHaveBeenCalledTimes(2);
  });

  it.each([
    { fingerprint: "replaced-installation" },
    { status: "failed" as const },
    { discoveryCheckedAt: "2099-01-01T00:00:00.000Z" }
  ])("retries changed, failed or invalid-age source discovery immediately: %j", async (patch) => {
    const source = clients();
    await run(source, { previousChecks: prior(patch) });
    expect(source.appStore.lookupOutcomes).toHaveBeenCalledTimes(1);
  });

  it("invalidates a prior positive when installation evidence changes", async () => {
    const source = clients();
    const result = await run(source, {
      previousChecks: prior({ fingerprint: "old", appStoreIdentity: identity })
    });
    expect(source.appStore.lookupOutcomes).toHaveBeenCalledWith(
      [expect.objectContaining({ identity: undefined })],
      expect.anything()
    );
    expect(result.checks[base.id]?.appStoreIdentity).toBeUndefined();
  });

  it("never turns a failed known-source check into a current version or advances its timestamp", async () => {
    const source = clients({ type: "transientFailure" });
    const result = await run(source, {
      previousChecks: prior({ appStoreIdentity: identity, status: "checked", checkedAt })
    });
    expect(result.checks[base.id]).toMatchObject({
      status: "failed",
      checkedAt,
      appStoreIdentity: identity
    });
    expect(result.updates).toEqual([]);
  });

  it("preserves lower-source actionable coverage when a verified Apple product is current", async () => {
    const source = clients({ type: "completed", identity });
    vi.mocked(source.sparkle.lookupOutcome).mockResolvedValue({
      type: "completed",
      providerFound: true,
      value: { remoteVersion: version("3"), updateURL: "https://example.com/release.zip" }
    });
    const result = await run(source, { apps: [{ ...base, sparkleFeedURL: app.sparkleFeedURL }] });
    expect(result.checks[base.id]?.appStoreIdentity).toEqual(identity);
    expect(result.updates).toMatchObject([{ source: "sparkle", remoteVersion: version("3") }]);
  });

  it("keeps empty declared feeds unresolved and does not infer Homebrew ownership from a catalogue match", async () => {
    const source = clients();
    vi.mocked(source.sparkle.lookupOutcome).mockResolvedValue({
      type: "completed",
      providerFound: false
    });
    vi.mocked(source.homebrew.lookupUpdate).mockReturnValue({
      token: "example",
      remoteVersion: version("2")
    });
    const result = await run(source, { apps: [{ ...base, sparkleFeedURL: app.sparkleFeedURL }] });
    expect(result.updates).toEqual([]);
    expect(result.checks[base.id]?.status).toBe("unresolved");
  });

  it("publishes a useful independent-source result while a provider remains pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = clients();
    vi.mocked(source.appStore.lookupOutcomes!).mockImplementation(async () => {
      await gate;
      return [{ type: "completed" }];
    });
    vi.mocked(source.sparkle.lookupOutcome).mockResolvedValue({
      type: "completed",
      providerFound: true,
      value: { remoteVersion: version("2") }
    });
    const quick = {
      ...base,
      id: "quick",
      bundleIdentifier: undefined,
      sparkleFeedURL: app.sparkleFeedURL
    };
    const progress: Array<{
      checks: Record<string, AppProviderCheck>;
      updates: UpdateRecord[];
    }> = [];
    const task = lookupAppUpdates(source, {
      ...input(),
      apps: [base, quick],
      onProgress: (checks, updates) => progress.push({ checks, updates })
    });
    try {
      await vi.waitFor(() =>
        expect(
          progress.some((entry) => entry.updates.some((update) => update.appID === "quick"))
        ).toBe(true)
      );
      expect(progress.at(-1)?.checks[base.id]?.status).toBe("pending");
    } finally {
      release();
      await task;
    }
  });
  it("keeps prior actionable rows through a superseding pending generation and later source failure", async () => {
    const previous: UpdateRecord = {
      id: base.id,
      appID: base.id,
      source: "appStore",
      supportLevel: "supported",
      localVersion: base.localVersion,
      remoteVersion: version("2"),
      checkedAt
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = clients();
    vi.mocked(source.appStore.lookupOutcomes!).mockImplementation(async () => {
      await gate;
      return [{ type: "completed" }];
    });
    let current = true;
    let pendingChecks: Record<string, AppProviderCheck> = prior({
      appStoreIdentity: identity,
      status: "checked",
      checkedAt
    });
    let pendingUpdates = [previous];
    const obsolete = lookupAppUpdates(source, {
      ...input([previous]),
      apps: [base],
      previousChecks: pendingChecks,
      isCurrent: () => current,
      onProgress: (checks, updates) => {
        pendingChecks = checks;
        pendingUpdates = updates;
      }
    });
    try {
      expect(pendingUpdates).toEqual([previous]);
      current = false;
      const winner = await run(clients({ type: "transientFailure" }), {
        previousChecks: pendingChecks,
        previousUpdates: new Map(pendingUpdates.map((update) => [update.appID, update]))
      });
      expect(winner.updates).toEqual([previous]);
      expect(winner.checks[base.id]).toMatchObject({ status: "failed", checkedAt });
      release();
      expect(await obsolete).toBeUndefined();
    } finally {
      release();
      await Promise.allSettled([obsolete]);
    }
  });

  it("continues to a fresh embedded updater when a previously current Apple product fails", async () => {
    const source = clients({ type: "transientFailure" });
    vi.mocked(source.sparkle.lookupOutcome).mockResolvedValue({
      type: "completed",
      providerFound: true,
      value: { remoteVersion: version("3") }
    });
    const result = await run(source, {
      apps: [{ ...base, sparkleFeedURL: app.sparkleFeedURL }],
      previousChecks: prior({ appStoreIdentity: identity, status: "checked", checkedAt })
    });
    expect(result.updates).toMatchObject([{ source: "sparkle", remoteVersion: version("3") }]);
    expect(result.checks[base.id]).toMatchObject({ status: "failed", appStoreIdentity: identity });
  });

  it("does not call preserved cask ownership a fresh version check after inventory or catalogue failure", async () => {
    const source = clients();
    const result = await run(source, {
      homebrewVersionCheckSucceeded: false,
      canUseHomebrewAppUpdate: () => true,
      homebrewItems: [
        {
          id: "cask:example",
          token: "example",
          name: "Example",
          kind: "cask",
          installedVersion: version("1"),
          isOutdated: false
        }
      ]
    });
    expect(result.checks[base.id]?.status).toBe("failed");
    expect(result.checks[base.id]?.checkedAt).toBeUndefined();
  });

  it("retries an interrupted persisted discovery instead of reusing its old no-match date", async () => {
    const source = clients();
    const { normalizeAppProviderChecks } = await import("../src/main/appProviderChecks");
    await run(source, { previousChecks: normalizeAppProviderChecks(prior({ status: "pending" })) });
    expect(source.appStore.lookupOutcomes).toHaveBeenCalledTimes(1);
  });

  it("streams a later positive past four omitted apps but waits for the provider batch to drain", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = clients();
    const positive = {
      type: "completed" as const,
      identity,
      value: { remoteVersion: version("2") }
    };
    vi.mocked(source.appStore.lookupOutcomes!).mockImplementation(async (_requests, options) => {
      options?.onOutcome?.(4, positive);
      await gate;
      return [
        { type: "completed" },
        { type: "completed" },
        { type: "completed" },
        { type: "completed" },
        positive
      ];
    });
    const apps = Array.from({ length: 5 }, (_, index) => ({
      ...base,
      id: `app-${index}`,
      bundleIdentifier: `com.example.application${index}`
    }));
    const progress: UpdateRecord[][] = [];
    let settled = false;
    const task = lookupAppUpdates(source, {
      ...input(),
      apps,
      onProgress: (_checks, updates) => progress.push(updates)
    });
    const observed = task.finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() =>
        expect(progress.some((updates) => updates.some((update) => update.appID === "app-4"))).toBe(
          true
        )
      );
      expect(settled).toBe(false);
      release();
      expect(await observed).toMatchObject([{ appID: "app-4", source: "appStore" }]);
    } finally {
      release();
      await Promise.allSettled([task, observed]);
    }
  });
  it("freshly discovers unresolved sources on every manual refresh, while background may reuse a dated search", async () => {
    const source = clients();
    const previousChecks = prior();
    await run(source, { previousChecks, force: true });
    expect(source.appStore.lookupOutcomes).toHaveBeenCalledTimes(1);
    await run(source, { previousChecks, force: false });
    expect(source.appStore.lookupOutcomes).toHaveBeenCalledTimes(1);
  });

  it("refreshes a verified embedded route every manual check and renews broader discovery independently", async () => {
    const source = clients();
    const previousChecks = prior({
      status: "checked",
      source: "sparkle",
      sparkleFeedURL: app.sparkleFeedURL,
      checkedAt
    });
    const currentApp = { ...base, sparkleFeedURL: app.sparkleFeedURL };
    await run(source, { apps: [currentApp], previousChecks });
    expect(source.appStore.lookupOutcomes).not.toHaveBeenCalled();
    expect(source.sparkle.lookupOutcome).toHaveBeenCalledWith(
      app.sparkleFeedURL,
      base.localVersion,
      undefined,
      expect.objectContaining({ force: true })
    );
    await run(source, { apps: [currentApp], previousChecks, now: "2026-10-16T06:00:00.000Z" });
    expect(source.appStore.lookupOutcomes).toHaveBeenCalledTimes(1);
  });

  it("refreshes currently proven healthy cask routes without repeating Apple discovery until renewal", async () => {
    const source = clients();
    const previousChecks = prior({ status: "checked", source: "homebrew", checkedAt });
    const patch = {
      previousChecks,
      homebrewVersionCheckSucceeded: true,
      canUseHomebrewAppUpdate: () => true,
      homebrewItems: [
        {
          id: "cask:example",
          token: "example",
          name: "Example",
          kind: "cask" as const,
          installedVersion: version("1"),
          isOutdated: false
        }
      ]
    };
    await run(source, patch);
    expect(source.appStore.lookupOutcomes).not.toHaveBeenCalled();
    await run(source, { ...patch, homebrewVersionCheckSucceeded: false });
    expect(source.appStore.lookupOutcomes).toHaveBeenCalledTimes(1);
  });

  it("keeps numeric version freshness separate from bundle discovery renewal", async () => {
    const discoveryCheckedAt = "2026-10-15T23:00:00.000Z";
    const source = clients({
      type: "completed",
      identity,
      discovered: false,
      checkedAt: input().now
    });
    const first = await run(source, {
      previousChecks: prior({ status: "checked", appStoreIdentity: identity, discoveryCheckedAt })
    });
    expect(first.checks[base.id]).toMatchObject({ discoveryCheckedAt, checkedAt: input().now });
    expect(source.appStore.lookupOutcomes).toHaveBeenLastCalledWith(
      [expect.objectContaining({ identity })],
      expect.anything()
    );
    await run(source, { previousChecks: first.checks, now: "2026-10-16T05:00:00.000Z" });
    expect(source.appStore.lookupOutcomes).toHaveBeenLastCalledWith(
      [expect.objectContaining({ identity: undefined })],
      expect.anything()
    );
  });

  it("invalidates both positive and no-match history when the current storefront changes", async () => {
    const source = { ...clients(), appStore: { ...clients().appStore, storefront: "gb" } };
    await run(source, { force: false, previousChecks: prior() });
    expect(source.appStore.lookupOutcomes).toHaveBeenCalledTimes(1);
    await run(source, {
      force: false,
      previousChecks: prior({ appStoreIdentity: identity, status: "checked" })
    });
    expect(source.appStore.lookupOutcomes).toHaveBeenLastCalledWith(
      [expect.objectContaining({ identity: undefined })],
      expect.anything()
    );
  });
});

describe("refresh work bounds", () => {
  it("bounds independent app work and discards the whole generation after cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    let active = 0;
    let peak = 0;
    const lookupOutcome = vi.fn(async () => {
      peak = Math.max(peak, ++active);
      await gate;
      active--;
      return { type: "completed" as const, value: { remoteVersion: version("2") } };
    });
    const apps = Array.from({ length: 8 }, (_, index) => ({
      ...app,
      id: `copy-${index}`,
      bundleIdentifier: `com.example.application${index}`,
      sparkleFeedURL: undefined
    }));
    const task = lookupAppUpdates(
      {
        appStore: { lookupOutcome },
        sparkle: { lookupOutcome: vi.fn() },
        homebrew: { lookupUpdate: vi.fn() }
      },
      { ...input(), apps, signal: controller.signal }
    );
    try {
      await vi.waitFor(() => expect(lookupOutcome).toHaveBeenCalledTimes(4));
      expect(peak).toBe(4);
      controller.abort();
      release();
      expect(await task).toBeUndefined();
      expect(lookupOutcome).toHaveBeenCalledTimes(4);
    } finally {
      controller.abort();
      release();
      await Promise.allSettled([task]);
    }
  });
});

it("drains started workers before rejecting an unexpected source failure", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lookupOutcome = vi.fn(async (bundleID: string) => {
    if (bundleID === "com.example.slow") await gate;
    else throw new Error("Unexpected lookup failure");
    return { type: "completed" as const };
  });
  let settled = false;
  const task = lookupAppUpdates(
    {
      appStore: { lookupOutcome },
      sparkle: { lookupOutcome: vi.fn() },
      homebrew: { lookupUpdate: vi.fn() }
    },
    {
      ...input(),
      apps: [
        { ...app, id: "slow", bundleIdentifier: "com.example.slow", sparkleFeedURL: undefined },
        { ...app, id: "failed", bundleIdentifier: "com.example.failed", sparkleFeedURL: undefined }
      ]
    }
  );
  const observed = task.finally(() => {
    settled = true;
  });
  void observed.catch(() => undefined);
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release();
    await expect(observed).rejects.toThrow("Unexpected lookup failure");
  } finally {
    release();
    await Promise.allSettled([task, observed]);
  }
});
