// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseNotesPreview } from "../src/renderer/components/ReleaseNotesPreview";
import type { BaselineAPI } from "../src/shared/ipc";
import type { ReleaseNotesResult, ReleaseNotesTarget } from "../src/shared/releaseNotes";

const target: ReleaseNotesTarget = { kind: "homebrew", id: "formula:example", version: "2.0" };
const available: ReleaseNotesResult = {
  status: "available",
  title: "Example",
  version: "2.0",
  source: "GitHub",
  sourceURL: "https://github.com/example/tool/releases/tag/v2.0",
  blocks: [
    { type: "heading", text: "Improvements" },
    { type: "paragraph", text: "A faster search." }
  ]
};

function preview(
  value: ReleaseNotesTarget | undefined = target,
  title = "Example",
  sourceKey = ""
) {
  return (
    <ReleaseNotesPreview target={value} title={title} sourceKey={sourceKey}>
      <strong>{title}</strong>
      <p>{value?.version ?? "Current"}</p>
    </ReleaseNotesPreview>
  );
}

function hoverArea() {
  return screen.getByText("Example").closest(".release-notes-anchor")!;
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  window.baseline = {
    getReleaseNotes: vi.fn().mockResolvedValue(available),
    cancelReleaseNotes: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(true)
  } as unknown as BaselineAPI;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("release notes preview", () => {
  it.each([
    { status: "unavailable" as const },
    { status: "available" as const, blocks: [] },
    { status: "available" as const, blocks: [{ type: "paragraph" as const, text: "  " }] }
  ])("hides a confirmed absent or empty result until its source changes: %j", async (result) => {
    vi.mocked(window.baseline.getReleaseNotes).mockResolvedValue({ ...available, ...result });
    const { rerender } = render(preview());
    fireEvent.click(screen.getByRole("button", { name: "Release notes for Example" }));
    await advance(0);
    expect(screen.getByText("Release notes unavailable")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Release notes for Example" })
    ).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerEnter(hoverArea());
    await advance(600);
    expect(window.baseline.getReleaseNotes).toHaveBeenCalledTimes(1);
    rerender(preview(target, "Example", "new-source"));
    expect(screen.getByRole("button", { name: "Release notes for Example" })).toBeInTheDocument();
  });

  it("retains the lookup control while loading, on errors and on stale-target results", async () => {
    let resolve!: (value: ReleaseNotesResult) => void;
    vi.mocked(window.baseline.getReleaseNotes).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      })
    );
    render(preview());
    const trigger = screen.getByRole("button", { name: "Release notes for Example" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-busy", "true");
    await act(async () => resolve({ ...available, status: "error" }));
    expect(trigger).toBeInTheDocument();
    vi.mocked(window.baseline.getReleaseNotes).mockResolvedValueOnce({
      ...available,
      status: "unavailable",
      retryable: true
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await advance(0);
    expect(trigger).toBeInTheDocument();
  });

  it("omits known unsupported-source controls without making a request", () => {
    render(
      <ReleaseNotesPreview target={target} title="Unsupported" canRequestNotes={false}>
        {(previewButton) => <p>1 → 2{previewButton}</p>}
      </ReleaseNotesPreview>
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(window.baseline.getReleaseNotes).not.toHaveBeenCalled();
  });
  it("does not let passive hovering replace a panel holding keyboard focus", async () => {
    render(
      <>
        {preview()}
        {preview({ ...target, id: "formula:other" }, "Other")}
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: "Release notes for Example" }));
    await advance(0);
    const focused = screen.getByRole("button", { name: "Close release notes" });
    expect(focused).toHaveFocus();
    fireEvent.pointerEnter(screen.getByText("Other").closest(".release-notes-anchor")!);
    await advance(600);
    expect(focused).toHaveFocus();
    expect(window.baseline.getReleaseNotes).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Release notes for Other" }));
    await advance(0);
    expect(window.baseline.getReleaseNotes).toHaveBeenCalledTimes(2);
  });

  it("waits 600 ms, keeps focus unchanged on hover and deduplicates repeated entry", async () => {
    render(
      <>
        <button>Other control</button>
        {preview()}
      </>
    );
    const other = screen.getByRole("button", { name: "Other control" });
    other.focus();
    fireEvent.pointerEnter(hoverArea(), { pointerType: "mouse" });
    await advance(599);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.baseline.getReleaseNotes).not.toHaveBeenCalled();
    fireEvent.pointerEnter(hoverArea(), { pointerType: "mouse" });
    await advance(1);
    expect(screen.getByRole("dialog", { name: "Release notes" })).toBeInTheDocument();
    expect(screen.getByText("A faster search.")).toBeInTheDocument();
    expect(other).toHaveFocus();
    expect(window.baseline.getReleaseNotes).toHaveBeenCalledTimes(1);
    await advance(3000);
    expect(window.baseline.getReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it("cancels a short hover, permits another full hover and keeps the panel hoverable", async () => {
    render(preview());
    const area = hoverArea();
    fireEvent.pointerEnter(area);
    await advance(300);
    fireEvent.pointerLeave(area);
    await advance(1000);
    expect(window.baseline.getReleaseNotes).not.toHaveBeenCalled();
    fireEvent.pointerEnter(area);
    await advance(600);
    const panel = screen.getByRole("dialog");
    fireEvent.pointerLeave(area);
    fireEvent.pointerEnter(panel);
    await advance(500);
    expect(panel).toBeInTheDocument();
    fireEvent.pointerLeave(panel);
    await advance(181);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens immediately from its button, shows loading and restores focus after Escape", async () => {
    let resolve!: (value: ReleaseNotesResult) => void;
    vi.mocked(window.baseline.getReleaseNotes).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    render(preview());
    const trigger = screen.getByRole("button", { name: "Release notes for Example" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByText("Loading release notes…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close release notes" })).toHaveFocus();
    const request = vi.mocked(window.baseline.getReleaseNotes).mock.calls[0]![0];
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.baseline.cancelReleaseNotes).toHaveBeenCalledWith(request.requestID);
    await act(async () => {
      resolve(available);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("drops old results on target/source changes and cancels on unmount", async () => {
    const resolvers: Array<(value: ReleaseNotesResult) => void> = [];
    vi.mocked(window.baseline.getReleaseNotes).mockImplementation(
      () => new Promise((r) => resolvers.push(r))
    );
    const { rerender, unmount } = render(preview());
    fireEvent.click(screen.getByRole("button", { name: "Release notes for Example" }));
    const oldRequest = vi.mocked(window.baseline.getReleaseNotes).mock.calls[0]![0];
    rerender(preview({ ...target, version: "3.0" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.baseline.cancelReleaseNotes).toHaveBeenCalledWith(oldRequest.requestID);
    await act(async () => {
      resolvers[0]!(available);
    });
    expect(screen.queryByText("A faster search.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Release notes for Example" }));
    rerender(preview({ ...target, version: "3.0" }, "Example", "new-provider"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Release notes for Example" }));
    const lastRequest = vi.mocked(window.baseline.getReleaseNotes).mock.calls.at(-1)![0];
    unmount();
    expect(window.baseline.cancelReleaseNotes).toHaveBeenCalledWith(lastRequest.requestID);
    await act(async () => {
      resolvers.slice(1).forEach((r) => r(available));
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["source", "target", "scroll", "resize"])(
    "returns focus to the retained trigger when %s invalidates a focused panel",
    async (change) => {
      const { rerender } = render(preview());
      const trigger = screen.getByRole("button", { name: "Release notes for Example" });
      trigger.focus();
      fireEvent.click(trigger);
      await advance(0);
      expect(screen.getByRole("button", { name: "Close release notes" })).toHaveFocus();
      if (change === "source") rerender(preview(target, "Example", "refreshed-source"));
      else if (change === "target") rerender(preview({ ...target, version: "3.0" }));
      else fireEvent(window, new Event(change));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    }
  );

  it("does not move outside focus when a source change dismisses a passive preview", async () => {
    const { rerender } = render(
      <>
        <button>Outside</button>
        {preview()}
      </>
    );
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    fireEvent.pointerEnter(hoverArea());
    await advance(600);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(
      <>
        <button>Outside</button>
        {preview(target, "Example", "refreshed-source")}
      </>
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });

  it("closes a repeated passive hover after Escape removed a hovered panel", async () => {
    render(preview());
    const area = hoverArea();
    fireEvent.pointerEnter(area);
    await advance(600);
    fireEvent.pointerLeave(area);
    fireEvent.pointerEnter(screen.getByRole("dialog"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.pointerEnter(area);
    await advance(600);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.pointerLeave(area);
    await advance(181);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps only one panel, closes outside without stealing focus and closes on navigation", async () => {
    render(
      <>
        {preview()}
        {preview({ ...target, id: "formula:other" }, "Other")}
        <button>Navigation</button>
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: "Release notes for Example" }));
    fireEvent.click(screen.getByRole("button", { name: "Release notes for Other" }));
    await advance(0);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const nav = screen.getByRole("button", { name: "Navigation" });
    nav.focus();
    fireEvent.pointerDown(nav);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(nav).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Release notes for Other" }));
    fireEvent(window, new Event("hashchange"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders unavailable and rejected reads honestly, then retries through the same target", async () => {
    vi.mocked(window.baseline.getReleaseNotes)
      .mockResolvedValueOnce({
        status: "unavailable",
        title: "Example",
        version: "2.0",
        message: "No exact upstream release was found.",
        websiteURL: "https://example.com/tool"
      })
      .mockRejectedValueOnce(new Error("network failed"))
      .mockResolvedValueOnce(available);
    const { rerender } = render(preview());
    const trigger = screen.getByRole("button", { name: "Release notes for Example" });
    fireEvent.click(trigger);
    await advance(0);
    expect(screen.getByText("Release notes unavailable")).toBeInTheDocument();
    expect(screen.getByText("No exact upstream release was found.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Website" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close release notes" }));
    rerender(preview(target, "Example", "refreshed"));
    fireEvent.click(screen.getByRole("button", { name: "Release notes for Example" }));
    await advance(0);
    expect(screen.getByText("Couldn’t load release notes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await advance(0);
    expect(screen.getByText("A faster search.")).toBeInTheDocument();
    expect(vi.mocked(window.baseline.getReleaseNotes).mock.calls.at(-1)![0]).toMatchObject({
      target,
      force: true
    });
  });

  it("renders long returned text inertly and does not close when its content scrolls", async () => {
    const text = '<script>window.bad = true</script><img src="https://example.com/track">';
    vi.mocked(window.baseline.getReleaseNotes).mockResolvedValue({
      ...available,
      message: "Long release notes have been shortened.",
      blocks: [
        { type: "paragraph", text },
        { type: "paragraph", text: "Long notes ".repeat(2000) }
      ]
    });
    render(preview());
    fireEvent.click(screen.getByRole("button", { name: "Release notes for Example" }));
    await advance(0);
    const panel = screen.getByRole("dialog");
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText("Long release notes have been shortened.")).toBeInTheDocument();
    expect(panel.querySelector("script, img, iframe")).toBeNull();
    fireEvent.scroll(screen.getByLabelText("Release notes content"));
    expect(panel).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not expose a preview when no available target exists", () => {
    render(
      <ReleaseNotesPreview title="Example">
        <strong>Example</strong>
        <p>Current</p>
      </ReleaseNotesPreview>
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps provenance internal without rendering source-link controls", async () => {
    render(preview());
    fireEvent.click(screen.getByRole("button", { name: "Release notes for Example" }));
    await advance(0);
    expect(screen.getByText("A faster search.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Website" })).not.toBeInTheDocument();
    expect(window.baseline.openExternal).not.toHaveBeenCalled();
  });
});
