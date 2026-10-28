// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultPersistedSnapshot,
  type BaselineSnapshot,
  type HomebrewManagedItem
} from "../src/shared/domain";
import { version } from "../src/shared/version";
import {
  cliExit,
  validateCLIRequest,
  type CLIOperation,
  type CLIRequest,
  type CLIResponse
} from "../src/shared/cli";
import { parseCLIArguments } from "../src/cli/arguments";
import { CLIService } from "../src/main/cliService";
import { startCLIServer } from "../src/main/cliServer";
import { sendCLIRequest } from "../src/cli/client";
import { cliEndpoint, verifyCLIEndpointDirectory } from "../src/cli/endpoint";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const req = (command: CLIRequest["command"], extra: Partial<CLIRequest> = {}): CLIRequest => ({
  schemaVersion: 1,
  command,
  ...extra
});
const data = <T>(response: CLIResponse) => response.data as T;

function fixture() {
  let time = Date.parse("2026-01-01T00:00:00Z");
  const item: HomebrewManagedItem = {
    id: "formula:example-tool",
    token: "example-tool",
    name: "Example Tool",
    kind: "formula",
    installedVersion: version("1"),
    latestVersion: version("2"),
    isOutdated: true,
    formulaIdentity: {
      name: "example-tool",
      fullName: "example-tool",
      tap: "homebrew/core",
      oldNames: []
    }
  };
  const snapshot = {
    ...defaultPersistedSnapshot(),
    apps: [
      {
        id: "/Applications/Example.app",
        displayName: "Example",
        bundlePath: "/Applications/Example.app",
        sourceHint: "sparkle",
        localVersion: version("1")
      }
    ],
    updates: [
      {
        id: "example-update",
        appID: "/Applications/Example.app",
        source: "sparkle",
        supportLevel: "supported",
        localVersion: version("1"),
        remoteVersion: version("2"),
        checkedAt: new Date(time).toISOString()
      }
    ],
    homebrewItems: [item],
    isRefreshing: false,
    appDiscoveryComplete: true,
    isHomebrewInstalled: true,
    homebrewCheckStatus: "complete",
    defaultScanDirectories: [],
    lastRefreshDate: new Date(time).toISOString(),
    appUpdatingIDs: [],
    homebrewUpdatingItemIDs: [],
    homebrewQueuedItemIDs: [],
    homebrewUninstallingItemIDs: [],
    homebrewDiscoverInstallingItemIDs: []
  } as unknown as BaselineSnapshot;
  let guiBusy = false;
  const store = {
    getSnapshot: () => structuredClone(snapshot),
    hasActiveUpdateOperation: () => guiBusy,
    refreshToolStatus: vi.fn(async () => undefined),
    refresh: vi.fn(async () => {
      snapshot.lastRefreshDate = new Date(time).toISOString();
    }),
    performCLIAppHandoff: vi.fn(async () => undefined),
    performHomebrewUpdate: vi.fn(async (id: string) => {
      const target = snapshot.homebrewItems.find((i) => i.id === id)!;
      target.installedVersion = version("2");
      target.isOutdated = false;
    })
  };
  const service = new CLIService(store, "1.0.0", () => time);
  return {
    service,
    snapshot,
    store,
    advance: (ms: number) => {
      time += ms;
    },
    busy: (value: boolean) => {
      guiBusy = value;
    }
  };
}

async function finished(service: CLIService, response: CLIResponse): Promise<CLIOperation> {
  expect(response.ok, JSON.stringify(response)).toBe(true);
  const id = data<{ operation: CLIOperation }>(response).operation.id;
  for (let i = 0; i < 200; i++) {
    const op = data<{ operation: CLIOperation }>(
      await service.handle(req("operation", { operationID: id }))
    ).operation;
    if (op.finishedAt) return op;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Fixture operation did not settle");
}
async function check(f: ReturnType<typeof fixture>) {
  return finished(f.service, await f.service.handle(req("check")));
}

describe("CLI admission and output contract", () => {
  it.each(
    [
      [],
      ["--help"],
      ["update", "--help"],
      ["--version"],
      ["--version", "--json"],
      ["--json", "--version"]
    ].map((args) => ({ args }))
  )("answers local discovery %j without a backend", ({ args }) => {
    expect(parseCLIArguments(args).local).toBeDefined();
  });
  it("accepts exact IDs containing spaces and keeps global options independent of placement", () => {
    expect(
      parseCLIArguments([
        "--json",
        "update",
        "app:/Applications/Example App.app",
        "brew:formula:example-tool",
        "--yes",
        "--timeout",
        "30"
      ]).request
    ).toMatchObject({
      command: "update",
      ids: ["app:/Applications/Example App.app", "brew:formula:example-tool"],
      yes: true
    });
  });
  it.each(
    [
      ["update"],
      ["inspect"],
      ["check", "all"],
      ["update", "x", "x"],
      ["list", "--yes"],
      ["list", "--timeout", "2"],
      ["check", "--timeout", "NaN"],
      ["check", "--timeout", "0"],
      ["check", "--timeout", "3601"],
      ["operation", "bad"],
      ["operation", randomUUID(), "extra"],
      ["update", "x", "--expect-plan", "bad"],
      ["list", "--json", "--json"],
      ["list", "--unknown"],
      ["inspect", "x\n"]
    ].map((args) => ({ args }))
  )("rejects malformed arguments %j before contacting the app", ({ args }) => {
    expect(() => parseCLIArguments(args)).toThrow();
  });
  it.each([
    null,
    [],
    {},
    { schemaVersion: 2, command: "list" },
    { schemaVersion: 1, command: ["list"] },
    { schemaVersion: 1, command: "status", ids: [] },
    { schemaVersion: 1, command: "update", ids: ["x"], yes: "true" },
    { schemaVersion: 1, command: "list", shell: "run" },
    { schemaVersion: 1, command: "update", ids: Array.from({ length: 51 }, (_, i) => String(i)) }
  ])("validates untrusted IPC input %j", (input) => {
    expect(() => validateCLIRequest(input)).toThrow();
  });
  it("does not publish bundle paths, feed URLs, icons, profile history or raw command output in listings", async () => {
    const f = fixture();
    f.snapshot.apps[0]!.iconDataURL = "secret-icon";
    f.snapshot.apps[0]!.sparkleFeedURL = "https://example.test/private-feed";
    f.snapshot.operationFailureDetails = {
      x: { attemptID: "attempt", outputTail: "private-output" }
    };
    const response = await f.service.handle(req("list"));
    expect(response).toMatchObject({
      schemaVersion: 1,
      ok: true,
      exitCode: 0,
      data: { cached: true, freshForUpdates: false, targets: expect.any(Array) }
    });
    expect(JSON.stringify(response)).not.toMatch(
      /secret-icon|private-feed|private-output|profileStats/
    );
    expect(data<{ targets: { id: string }[] }>(response).targets.map((t) => t.id)).toEqual([
      "app:/Applications/Example.app",
      "brew:formula:example-tool"
    ]);
  });
  it("exposes capabilities and errors as structured versioned data", async () => {
    const f = fixture();
    expect(await f.service.handle(req("doctor"))).toMatchObject({
      data: { capabilities: { directUpdates: ["homebrew"] }, exitCodes: cliExit }
    });
    expect(await f.service.handle(req("inspect", { ids: ["example-tool"] }))).toMatchObject({
      ok: false,
      exitCode: 2,
      error: { code: "unknown-target" }
    });
  });
});

describe("shared backend operations", () => {
  it("does not renew explicit-check admission through later GUI refreshes", async () => {
    const f = fixture();
    await check(f);
    f.advance(16 * 60_000);
    await f.store.refresh();
    expect(await f.service.handle(req("status"))).toMatchObject({
      data: { checkedThisSession: true, freshForUpdates: false }
    });
    expect(
      await finished(
        f.service,
        await f.service.handle(req("update", { ids: ["brew:formula:example-tool"], yes: true }))
      )
    ).toMatchObject({ results: [{ status: "blocked" }] });
    expect(f.store.performHomebrewUpdate).not.toHaveBeenCalled();
  });
  it.each(["2", "latest", ""])(
    "returns user action before mutating an unverifiable cask version %s",
    async (latest) => {
      const f = fixture();
      await check(f);
      Object.assign(f.snapshot.homebrewItems[0]!, {
        kind: "cask",
        fullToken: "example-tool",
        tap: "homebrew/cask",
        installedVersion: version("2"),
        latestVersion: version(latest)
      });
      expect(
        await finished(
          f.service,
          await f.service.handle(
            req("update", { ids: ["brew:formula:example-tool"], yes: true, interactive: true })
          )
        )
      ).toMatchObject({
        state: "requires-user-action",
        results: [
          { status: "requires-user-action", message: expect.stringContaining("verifiable") }
        ]
      });
      expect(f.store.performHomebrewUpdate).not.toHaveBeenCalled();
    }
  );
  it("matches equivalent retry options regardless of flag order", async () => {
    const f = fixture();
    await check(f);
    const id = randomUUID();
    const first = parseCLIArguments([
      "update",
      "app:/Applications/Example.app",
      "--operation-id",
      id,
      "--yes",
      "--interactive"
    ]).request!;
    const retry = parseCLIArguments([
      "update",
      "app:/Applications/Example.app",
      "--interactive",
      "--yes",
      "--operation-id",
      id
    ]).request!;
    await finished(f.service, await f.service.handle(first));
    expect(await f.service.handle(retry)).toMatchObject({
      ok: true,
      data: { operation: { id, state: "requires-user-action" } }
    });
    expect(f.store.performCLIAppHandoff).toHaveBeenCalledOnce();
  });
  it("rejects a target that changes while an earlier update is in flight", async () => {
    const f = fixture();
    await check(f);
    f.snapshot.homebrewItems.push({
      ...f.snapshot.homebrewItems[0]!,
      id: "formula:second",
      token: "second",
      formulaIdentity: { name: "second", fullName: "second", tap: "homebrew/core", oldNames: [] }
    });
    f.store.performHomebrewUpdate.mockImplementation(async () => {
      f.snapshot.homebrewItems[0]!.installedVersion = version("2");
      f.snapshot.homebrewItems[0]!.isOutdated = false;
      f.snapshot.homebrewItems[1]!.pinned = true;
    });
    expect(
      await finished(
        f.service,
        await f.service.handle(
          req("update", { ids: ["brew:formula:example-tool", "brew:formula:second"], yes: true })
        )
      )
    ).toMatchObject({ state: "partial", results: [{ status: "updated" }, { status: "blocked" }] });
    expect(f.store.performHomebrewUpdate).toHaveBeenCalledOnce();
  });
  it("checks with forced metadata, reports partial sources, and preserves actual provider timestamps", async () => {
    const f = fixture();
    f.snapshot.appProviderChecks = {
      "/Applications/Example.app": {
        fingerprint: "fixture",
        status: "failed",
        checkedAt: "2025-01-01T00:00:00Z"
      }
    };
    expect(await check(f)).toMatchObject({ state: "partial", exitCode: 1 });
    expect(f.store.refresh).toHaveBeenCalledWith(false, { forceMetadata: true });
    expect(
      await f.service.handle(req("inspect", { ids: ["app:/Applications/Example.app"] }))
    ).toMatchObject({
      data: { target: { checkedAt: "2025-01-01T00:00:00Z", checkStatus: "failed" } }
    });
  });
  it("dry runs never refresh, launch apps or execute packages, and stale plans fail closed", async () => {
    const f = fixture();
    await check(f);
    const plan = data<{ planID: string }>(
      await f.service.handle(req("update", { ids: ["brew:formula:example-tool"], dryRun: true }))
    );
    expect(f.store.performHomebrewUpdate).not.toHaveBeenCalled();
    expect(f.store.performCLIAppHandoff).not.toHaveBeenCalled();
    f.snapshot.homebrewItems[0]!.pinned = true;
    expect(
      await f.service.handle(
        req("update", { ids: ["brew:formula:example-tool"], yes: true, expectPlan: plan.planID })
      )
    ).toMatchObject({ ok: false, error: { code: "stale-plan" } });
  });
  it("requires explicit confirmation and a fresh check in this session", async () => {
    const f = fixture();
    expect(
      await f.service.handle(req("update", { ids: ["brew:formula:example-tool"] }))
    ).toMatchObject({ ok: false, error: { code: "confirmation-required" } });
    expect(
      await finished(
        f.service,
        await f.service.handle(req("update", { ids: ["brew:formula:example-tool"], yes: true }))
      )
    ).toMatchObject({ state: "failed", results: [{ status: "blocked" }] });
    expect(f.store.performHomebrewUpdate).not.toHaveBeenCalled();
    await check(f);
    f.advance(15 * 60_000);
    expect(
      await finished(
        f.service,
        await f.service.handle(req("update", { ids: ["brew:formula:example-tool"], yes: true }))
      )
    ).toMatchObject({ results: [{ status: "blocked" }] });
  });
  it.each(["pinned", "ignored", "self", "unverified", "quarantine", "configuration", "incomplete"])(
    "preserves %s protection",
    async (scenario) => {
      const f = fixture();
      await check(f);
      const item = f.snapshot.homebrewItems[0]!;
      if (scenario === "pinned") item.pinned = true;
      if (scenario === "ignored") {
        item.appID = f.snapshot.apps[0]!.id;
        f.snapshot.ignoredIDs = [item.appID];
      }
      if (scenario === "self") item.isSelf = true;
      if (scenario === "unverified") item.formulaIdentityVerified = false;
      if (scenario === "quarantine") f.snapshot.isHomebrewCleanupLocked = true;
      if (scenario === "configuration") f.snapshot.homebrewConfigurationBlocked = true;
      if (scenario === "incomplete") f.snapshot.homebrewCheckStatus = "incomplete";
      expect(
        await finished(
          f.service,
          await f.service.handle(req("update", { ids: ["brew:formula:example-tool"], yes: true }))
        )
      ).toMatchObject({ results: [{ status: "blocked" }] });
      expect(f.store.performHomebrewUpdate).not.toHaveBeenCalled();
    }
  );
  it("never claims an app handoff installed an update and never opens it without interactive consent", async () => {
    const f = fixture();
    await check(f);
    const first = await finished(
      f.service,
      await f.service.handle(req("update", { ids: ["app:/Applications/Example.app"], yes: true }))
    );
    expect(first).toMatchObject({ state: "requires-user-action", exitCode: 3 });
    expect(f.store.performCLIAppHandoff).not.toHaveBeenCalled();
    expect(
      await finished(
        f.service,
        await f.service.handle(
          req("update", { ids: ["app:/Applications/Example.app"], yes: true, interactive: true })
        )
      )
    ).toMatchObject({ state: "requires-user-action", exitCode: 3 });
    expect(f.store.performCLIAppHandoff).toHaveBeenCalledOnce();
    expect(f.store.performHomebrewUpdate).not.toHaveBeenCalled();
  });
  it("requires interactive consent before any cask command", async () => {
    const f = fixture();
    await check(f);
    Object.assign(f.snapshot.homebrewItems[0]!, {
      kind: "cask",
      fullToken: "example-tool",
      tap: "homebrew/cask"
    });
    expect(
      await finished(
        f.service,
        await f.service.handle(req("update", { ids: ["brew:formula:example-tool"], yes: true }))
      )
    ).toMatchObject({ exitCode: 3 });
    expect(f.store.performHomebrewUpdate).not.toHaveBeenCalled();
  });
  it.each(["unchanged", "outdated", "failed", "incomplete"])(
    "does not treat a returned command as success when reconciliation is %s",
    async (scenario) => {
      const f = fixture();
      await check(f);
      f.store.performHomebrewUpdate.mockImplementation(async () => {
        if (scenario !== "unchanged") f.snapshot.homebrewItems[0]!.installedVersion = version("2");
        f.snapshot.homebrewItems[0]!.isOutdated = scenario === "outdated";
        if (scenario === "failed")
          f.snapshot.operationFailures = [
            {
              id: "failure",
              entityID: "formula:example-tool",
              operation: "update",
              reason: "command",
              status: 1,
              occurredAt: new Date().toISOString()
            }
          ];
        if (scenario === "incomplete") f.snapshot.homebrewCheckStatus = "incomplete";
      });
      expect(
        await finished(
          f.service,
          await f.service.handle(req("update", { ids: ["brew:formula:example-tool"], yes: true }))
        )
      ).toMatchObject({ state: "failed", exitCode: 1, results: [{ status: "failed" }] });
    }
  );
  it("reports mixed outcomes and keeps successful items when a later command fails", async () => {
    const f = fixture();
    await check(f);
    f.snapshot.homebrewItems.push({
      ...f.snapshot.homebrewItems[0]!,
      id: "formula:second",
      token: "second",
      name: "Second",
      formulaIdentity: { name: "second", fullName: "second", tap: "homebrew/core", oldNames: [] }
    });
    f.store.performHomebrewUpdate.mockImplementation(async (id) => {
      if (id === "formula:second") throw new Error("private details");
      f.snapshot.homebrewItems[0]!.installedVersion = version("2");
      f.snapshot.homebrewItems[0]!.isOutdated = false;
    });
    const op = await finished(
      f.service,
      await f.service.handle(
        req("update", { ids: ["brew:formula:example-tool", "brew:formula:second"], yes: true })
      )
    );
    expect(op).toMatchObject({
      state: "partial",
      exitCode: 1,
      results: [{ status: "updated" }, { status: "failed" }]
    });
    expect(JSON.stringify(op)).not.toContain("private details");
  });
  it("deduplicates identical requests, rejects ID conflicts and concurrent writers while reads remain responsive", async () => {
    const f = fixture();
    await check(f);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.store.performHomebrewUpdate.mockImplementation(async () => {
      await gate;
    });
    const request = req("update", {
      ids: ["brew:formula:example-tool"],
      yes: true,
      operationID: randomUUID()
    });
    let accepted: CLIResponse;
    try {
      accepted = await f.service.handle(request);
      const responses = await Promise.all(
        Array.from({ length: 100 }, () => f.service.handle(request))
      );
      expect(responses.every((r) => r.ok)).toBe(true);
      expect(f.store.performHomebrewUpdate).toHaveBeenCalledOnce();
      expect(await f.service.handle(req("check"))).toMatchObject({ exitCode: 4 });
      expect(await f.service.handle({ ...request, interactive: true })).toMatchObject({
        error: { code: "operation-conflict" }
      });
      expect(await f.service.handle(req("list"))).toMatchObject({ ok: true });
      f.snapshot.homebrewOperation = { id: "fixture", itemIDs: [], appIDs: [], phase: "waiting" };
      expect(
        await f.service.handle(req("operation", { operationID: request.operationID }))
      ).toMatchObject({ data: { operation: { state: "waiting-for-user" } } });
    } finally {
      release();
    }
    await finished(f.service, accepted!);
  });
  it("respects GUI operations, closes admission on shutdown and does not invent restart outcomes", async () => {
    const f = fixture();
    f.busy(true);
    expect(await f.service.handle(req("check"))).toMatchObject({ exitCode: 4 });
    f.busy(false);
    f.snapshot.isRefreshing = true;
    expect(await f.service.handle(req("check"))).toMatchObject({ exitCode: 4 });
    expect(await f.service.handle(req("operation", { operationID: randomUUID() }))).toMatchObject({
      error: { code: "unknown-operation" }
    });
    f.service.close();
    expect(await f.service.handle(req("list"))).toMatchObject({ error: { code: "closing" } });
  });
});

describe("private local IPC", () => {
  async function setup() {
    const profile = await mkdtemp(path.join(os.tmpdir(), "baseline-cli-test-"));
    const endpoint = cliEndpoint(profile);
    cleanups.push(
      () => rm(profile, { recursive: true, force: true }),
      () => rm(endpoint.directory, { recursive: true, force: true })
    );
    const f = fixture();
    const close = await startCLIServer(profile, f.service);
    cleanups.push(close);
    return { ...f, profile, endpoint, close };
  }
  it("uses private sockets and survives repeated clients, fragmented JSON and invalid frames", async () => {
    const f = await setup();
    expect((await lstat(f.endpoint.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(f.endpoint.socket)).mode & 0o777).toBe(0o600);
    for (let round = 0; round < 10; round++) {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => sendCLIRequest(f.profile, req("list")))
      );
      expect(results.every((r) => r.ok)).toBe(true);
    }
    const raw = (chunks: string[]) =>
      new Promise<string>((resolve, reject) => {
        const socket = createConnection(f.endpoint.socket);
        let output = "";
        socket.on("error", reject);
        socket.on("data", (chunk) => {
          output += chunk.toString();
        });
        socket.on("end", () => resolve(output));
        socket.on("connect", () => {
          void (async () => {
            for (const chunk of chunks) {
              socket.write(chunk);
              await new Promise((r) => setTimeout(r, 1));
            }
          })();
        });
      });
    expect(JSON.parse(await raw(['{"schemaVersion":1,', '"command":"status"}\n']))).toMatchObject({
      ok: true
    });
    expect(JSON.parse(await raw(["{invalid}\n"]))).toMatchObject({ exitCode: 2 });
    expect(JSON.parse(await raw(["{}\n{}\n"]))).toMatchObject({ error: { code: "invalid-json" } });
    expect(await sendCLIRequest(f.profile, req("status"))).toMatchObject({ ok: true });
  });
  it("rejects unsafe endpoint permissions and symlinked directories without following them", async () => {
    const f = await setup();
    await chmod(f.endpoint.directory, 0o755);
    await expect(sendCLIRequest(f.profile, req("status"))).rejects.toThrow(/private/);
    await chmod(f.endpoint.directory, 0o700);
    const link = path.join(f.profile, "link");
    await symlink(f.endpoint.directory, link);
    await expect(verifyCLIEndpointDirectory(link)).rejects.toThrow(/private/);
  });
  it("does not overwrite a regular file at the expected endpoint", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "baseline-cli-test-"));
    const endpoint = cliEndpoint(profile);
    cleanups.push(
      () => rm(profile, { recursive: true, force: true }),
      () => rm(endpoint.directory, { recursive: true, force: true })
    );
    await verifyCLIEndpointDirectory(endpoint.directory, true);
    await writeFile(endpoint.socket, "keep this");
    await expect(startCLIServer(profile, fixture().service)).rejects.toThrow(/refusing/);
    expect(await readFile(endpoint.socket, "utf8")).toBe("keep this");
  });
});
