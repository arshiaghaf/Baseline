// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TrayRefreshAnimation,
  trayRefreshFrameCount,
  trayRefreshFrameIntervalMs
} from "../src/main/trayRefreshAnimation";

describe("menu bar refresh animation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rotates at a bounded rate without restarting on repeated busy snapshots", () => {
    const render = vi.fn();
    const animation = new TrayRefreshAnimation(render);
    try {
      animation.update(true, false);
      vi.advanceTimersByTime(trayRefreshFrameIntervalMs / 2);
      animation.update(true, false);
      vi.advanceTimersByTime(trayRefreshFrameIntervalMs / 2 + 1);
      expect(render.mock.calls.map(([frame]) => frame)).toEqual([0, 1]);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(trayRefreshFrameIntervalMs * (trayRefreshFrameCount - 1));
      expect(render).toHaveBeenLastCalledWith(0);
    } finally {
      animation.dispose();
    }
  });

  it("restores idle after completion or failure and starts a later refresh once", () => {
    const render = vi.fn();
    const animation = new TrayRefreshAnimation(render);
    try {
      expect(vi.getTimerCount()).toBe(0);
      animation.update(true, false);
      vi.advanceTimersByTime(300);
      animation.update(false, false);
      expect(render).toHaveBeenLastCalledWith(undefined);
      const count = render.mock.calls.length;
      vi.advanceTimersByTime(10_000);
      animation.update(false, false);
      expect(render).toHaveBeenCalledTimes(count);
      expect(vi.getTimerCount()).toBe(0);
      animation.update(true, false);
      expect(render).toHaveBeenLastCalledWith(0);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      animation.dispose();
    }
  });

  it("skips obsolete frames after an event-loop stall instead of replaying them", () => {
    const render = vi.fn();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const animation = new TrayRefreshAnimation(render);
    try {
      animation.update(true, false);
      clock.mockReturnValue(trayRefreshFrameIntervalMs * 8);
      vi.advanceTimersByTime(trayRefreshFrameIntervalMs + 1);
      expect(render.mock.calls.map(([frame]) => frame)).toEqual([0, 8]);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      animation.dispose();
      clock.mockRestore();
    }
  });

  it("uses a static busy frame for Reduce Motion and responds to changes during refresh", () => {
    const render = vi.fn();
    const animation = new TrayRefreshAnimation(render);
    try {
      animation.update(true, true);
      expect(render).toHaveBeenLastCalledWith(0);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10_000);
      expect(render).toHaveBeenCalledTimes(1);
      animation.update(true, false);
      vi.advanceTimersByTime(trayRefreshFrameIntervalMs + 1);
      expect(render).toHaveBeenLastCalledWith(1);
      animation.update(true, true);
      expect(render).toHaveBeenLastCalledWith(0);
      expect(vi.getTimerCount()).toBe(0);
      animation.update(false, true);
      expect(render).toHaveBeenLastCalledWith(undefined);
    } finally {
      animation.dispose();
    }
  });

  it("stops callbacks on tray removal or shutdown, without affecting a replacement tray", () => {
    const oldRender = vi.fn();
    const old = new TrayRefreshAnimation(oldRender);
    old.update(true, false);
    old.dispose();
    old.update(true, false);
    const replacementRender = vi.fn();
    const replacement = new TrayRefreshAnimation(replacementRender);
    try {
      replacement.update(true, false);
      vi.advanceTimersByTime(trayRefreshFrameIntervalMs * 3);
      expect(oldRender).toHaveBeenCalledTimes(1);
      expect(replacementRender).toHaveBeenLastCalledWith(3);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      replacement.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
