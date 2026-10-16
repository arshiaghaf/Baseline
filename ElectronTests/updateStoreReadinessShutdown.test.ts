// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolStatusService, type ToolStatusPatch } from "../src/main/toolStatusService";
import { UpdateStore } from "../src/main/updateStore";
import { SnapshotPersistence } from "../src/main/persistence";
import { defaultPersistedSnapshot } from "../src/shared/domain";
import type { CommandResult } from "../src/main/commandRunner";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const available: CommandResult = { success: true, status: 0, output: "" };

function statusHarness(
  brew: () => Promise<CommandResult>,
  mas: () => Promise<CommandResult>,
  onPatch?: (patch: ToolStatusPatch) => void
) {
  let state = { isChecking: false, isHomebrewInstalled: false, isMasInstalled: false };
  const release = vi.fn();
  const runBrewCommand = vi.fn(brew);
  const runMasCommand = vi.fn(mas);
  const markHomebrewAvailabilityChecked = vi.fn();
  const service = new ToolStatusService({
    patch: (patch) => {
      state = { ...state, ...patch };
      onPatch?.(patch);
    },
    reserveHomebrewCommandLock: () => release,
    runBrewCommand,
    runMasCommand,
    markHomebrewAvailabilityChecked
  });
  return {
    service,
    release,
    runBrewCommand,
    runMasCommand,
    markHomebrewAvailabilityChecked,
    get state() {
      return state;
    }
  };
}

function store(
  runBrewCommand: NonNullable<ConstructorParameters<typeof UpdateStore>[0]["runBrewCommand"]>,
  runMasCommand: NonNullable<
    ConstructorParameters<typeof UpdateStore>[0]["runMasCommand"]
  > = async () => available
) {
  return new UpdateStore({
    persistence: { save: async () => undefined } as unknown as SnapshotPersistence,
    persisted: { ...defaultPersistedSnapshot(), autoRefreshEnabled: false },
    openExternalURL: async () => false,
    openAppBundle: async () => undefined,
    runBrewCommand,
    runMasCommand,
    profileStatsIntegrity: {
      verifyOrInitialize: async (stats) => stats,
      seal: async (stats) => stats
    },
    successRefreshDelayMS: 0
  });
}

describe("tool readiness lifecycle", () => {
  it("releases brew independently and keeps the successful mas result after brew rejects", async () => {
    const brew = deferred<CommandResult>();
    const mas = deferred<CommandResult>();
    const h = statusHarness(
      () => brew.promise,
      () => mas.promise
    );
    const checking = h.service.check();

    try {
      await vi.waitFor(() => {
        expect(h.runBrewCommand).toHaveBeenCalledWith(["--version"]);
        expect(h.runMasCommand).toHaveBeenCalledWith(["version"]);
      });
      brew.reject(new Error("brew probe rejected"));
      await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());
      expect(h.state.isChecking).toBe(true);
      mas.resolve(available);
      await expect(checking).rejects.toThrow("brew probe rejected");
      expect(h.state).toEqual({
        isChecking: false,
        isHomebrewInstalled: false,
        isMasInstalled: true
      });
      expect(h.markHomebrewAvailabilityChecked).not.toHaveBeenCalled();
    } finally {
      brew.resolve(available);
      mas.resolve(available);
      await Promise.allSettled([checking]);
    }
  });

  it("waits for brew and retains its successful result when mas rejects", async () => {
    const brew = deferred<CommandResult>();
    const mas = deferred<CommandResult>();
    const h = statusHarness(
      () => brew.promise,
      () => mas.promise
    );
    const checking = h.service.check();

    try {
      await vi.waitFor(() => {
        expect(h.runBrewCommand).toHaveBeenCalledOnce();
        expect(h.runMasCommand).toHaveBeenCalledOnce();
      });
      mas.reject(new Error("mas probe rejected"));
      await Promise.resolve();
      expect(h.state.isChecking).toBe(true);
      brew.resolve(available);
      await expect(checking).rejects.toThrow("mas probe rejected");
      expect(h.release).toHaveBeenCalledOnce();
      expect(h.state).toEqual({
        isChecking: false,
        isHomebrewInstalled: true,
        isMasInstalled: false
      });
      expect(h.markHomebrewAvailabilityChecked).toHaveBeenCalledOnce();
    } finally {
      brew.resolve(available);
      mas.resolve(available);
      await Promise.allSettled([checking]);
    }
  });

  it("coalesces overlapping and snapshot-reentrant checks into one pair of probes", async () => {
    const brew = deferred<CommandResult>();
    const mas = deferred<CommandResult>();
    let reentrant: Promise<void> | undefined;
    const h = statusHarness(
      () => brew.promise,
      () => mas.promise,
      (patch) => {
        if (patch.isChecking) reentrant = h.service.check();
      }
    );
    const first = h.service.check();
    const second = h.service.check();

    try {
      expect(second).toBe(first);
      expect(reentrant).toBe(first);
      brew.resolve(available);
      mas.resolve(available);
      await Promise.all([first, second, reentrant]);
      expect(h.runBrewCommand).toHaveBeenCalledTimes(1);
      expect(h.runMasCommand).toHaveBeenCalledTimes(1);
      expect(h.release).toHaveBeenCalledTimes(1);
      expect(h.state.isChecking).toBe(false);
    } finally {
      brew.resolve(available);
      mas.resolve(available);
      await Promise.allSettled([first, second, reentrant]);
    }
  });

  it("settles a failed lock reservation and permits a later check", async () => {
    let reservations = 0;
    let isChecking = false;
    const runBrewCommand = vi.fn(async () => available);
    const runMasCommand = vi.fn(async () => available);
    const service = new ToolStatusService({
      patch: (patch) => {
        if (patch.isChecking !== undefined) isChecking = patch.isChecking;
      },
      reserveHomebrewCommandLock: () => {
        if (++reservations === 1) throw new Error("reservation publication failed");
        return () => undefined;
      },
      runBrewCommand,
      runMasCommand,
      markHomebrewAvailabilityChecked: () => undefined
    });

    await expect(service.check()).rejects.toThrow("reservation publication failed");
    expect(isChecking).toBe(false);
    expect(runBrewCommand).not.toHaveBeenCalled();
    expect(runMasCommand).not.toHaveBeenCalled();

    await expect(service.check()).resolves.toBeUndefined();
    expect(reservations).toBe(2);
    expect(runBrewCommand).toHaveBeenCalledOnce();
    expect(runMasCommand).toHaveBeenCalledOnce();
    expect(isChecking).toBe(false);
  });

  it("settles the original checking-publication error even when lock release throws", async () => {
    let failPublication = true;
    let failRelease = true;
    let isChecking = false;
    const release = vi.fn(() => {
      if (failRelease) throw new Error("release publication failed");
    });
    const runBrewCommand = vi.fn(async () => available);
    const runMasCommand = vi.fn(async () => available);
    const service = new ToolStatusService({
      patch: (patch) => {
        if (patch.isChecking !== undefined) isChecking = patch.isChecking;
        if (patch.isChecking && failPublication) {
          throw new Error("checking publication failed");
        }
      },
      reserveHomebrewCommandLock: () => release,
      runBrewCommand,
      runMasCommand,
      markHomebrewAvailabilityChecked: () => undefined
    });

    await expect(service.check()).rejects.toThrow("checking publication failed");
    expect(release).toHaveBeenCalledOnce();
    expect(isChecking).toBe(false);
    expect(runBrewCommand).not.toHaveBeenCalled();
    expect(runMasCommand).not.toHaveBeenCalled();

    failPublication = false;
    failRelease = false;
    await expect(service.check()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
    expect(isChecking).toBe(false);
  });

  it("observes both probes and retains their results when release publication throws", async () => {
    const mas = deferred<CommandResult>();
    let isChecking = false;
    let homebrewInstalled = false;
    let masInstalled = false;
    let failRelease = true;
    const release = vi.fn(() => {
      if (failRelease) throw new Error("release publication failed");
    });
    const service = new ToolStatusService({
      patch: (patch) => {
        if (patch.isChecking !== undefined) isChecking = patch.isChecking;
        if (patch.isHomebrewInstalled !== undefined) homebrewInstalled = patch.isHomebrewInstalled;
        if (patch.isMasInstalled !== undefined) masInstalled = patch.isMasInstalled;
      },
      reserveHomebrewCommandLock: () => release,
      runBrewCommand: async () => available,
      runMasCommand: () => mas.promise,
      markHomebrewAvailabilityChecked: () => undefined
    });
    const checking = service.check();

    try {
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      expect(isChecking).toBe(true);
      mas.resolve(available);
      await expect(checking).rejects.toThrow("release publication failed");
      expect({ isChecking, homebrewInstalled, masInstalled }).toEqual({
        isChecking: false,
        homebrewInstalled: true,
        masInstalled: true
      });

      failRelease = false;
      await expect(service.check()).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      mas.resolve(available);
      await Promise.allSettled([checking]);
    }
  });

  it.each(["brew", "mas"] as const)(
    "clears the store checking state when the %s probe rejects",
    async (rejecting) => {
      const updateStore = store(
        async () => {
          if (rejecting === "brew") throw new Error("brew rejected");
          return available;
        },
        async () => {
          if (rejecting === "mas") throw new Error("mas rejected");
          return available;
        }
      );

      await expect(updateStore.refreshToolStatus()).rejects.toThrow(`${rejecting} rejected`);
      expect(updateStore.getSnapshot()).toMatchObject({
        isChecking: false,
        isHomebrewCommandLocked: false,
        ...(rejecting === "brew" ? { isMasInstalled: true } : { isHomebrewInstalled: true })
      });
    }
  );

  it("shares one store readiness check across overlapping callers", async () => {
    const brew = deferred<CommandResult>();
    const mas = deferred<CommandResult>();
    const runBrewCommand = vi.fn(() => brew.promise);
    const runMasCommand = vi.fn(() => mas.promise);
    const updateStore = store(runBrewCommand, runMasCommand);
    const first = updateStore.refreshToolStatus();
    const second = updateStore.refreshToolStatus();

    try {
      brew.resolve(available);
      mas.resolve(available);
      await Promise.all([first, second]);
      expect(runBrewCommand).toHaveBeenCalledTimes(1);
      expect(runMasCommand).toHaveBeenCalledTimes(1);
      expect(updateStore.getSnapshot()).toMatchObject({
        isChecking: false,
        isHomebrewInstalled: true,
        isMasInstalled: true
      });
    } finally {
      brew.resolve(available);
      mas.resolve(available);
      await Promise.allSettled([first, second]);
    }
  });
});
