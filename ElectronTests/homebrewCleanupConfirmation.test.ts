// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const showMessageBox = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ dialog: { showMessageBox } }));
import { confirmHomebrewCleanup } from "../src/main/homebrewCleanupConfirmation";

beforeEach(() => {
  showMessageBox.mockReset();
});

describe("Homebrew cleanup confirmation", () => {
  it("accepts only the explicit Clean up response and explains global removal scope", async () => {
    const window = {} as BrowserWindow;
    showMessageBox.mockResolvedValue({ response: 1 });
    expect(await confirmHomebrewCleanup(window)).toBe(true);
    expect(showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        type: "warning",
        buttons: ["Cancel", "Clean up"],
        defaultId: 0,
        cancelId: 0,
        detail: expect.stringContaining("Unused dependencies may also be removed")
      })
    );
    const options = showMessageBox.mock.calls[0]![1];
    expect(options.detail).toContain("including ignored items");
    expect(options.detail).toContain("your Homebrew settings");
    expect(options.detail).toContain("It cannot be undone");
  });

  it("cancels safely without a parent window", async () => {
    showMessageBox.mockResolvedValue({ response: 0 });
    expect(await confirmHomebrewCleanup()).toBe(false);
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ defaultId: 0, cancelId: 0 })
    );
  });

  it("does not authorize cleanup when the dialog rejects", async () => {
    showMessageBox.mockRejectedValue(new Error("Synthetic dialog failure"));
    await expect(confirmHomebrewCleanup()).rejects.toThrow("Synthetic dialog failure");
  });
});
