// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileSection } from "../src/renderer/components/SettingsView";
import { defaultPersistedSnapshot, type BaselineSnapshot } from "../src/shared/domain";

afterEach(cleanup);

describe("profile history coverage", () => {
  it("keeps the history caveat beside Stats and outside the metric grid", () => {
    const snapshot = defaultPersistedSnapshot() as BaselineSnapshot;
    snapshot.profileStats.lifetime = { coverage: "lowerBound", entries: [] };
    render(<ProfileSection snapshot={snapshot} />);
    const info = screen.getByLabelText(
      "Recorded history may omit earlier activity. Totals and rankings may be incomplete."
    );
    expect(info.closest(".panel-title")).toContainElement(
      screen.getByRole("heading", { name: "Stats" })
    );
    expect(info.closest(".profile-panel-box")).toBeNull();
    info.focus();
    expect(info).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Recorded history may omit earlier activity."
    );
    expect(document.querySelector(".profile-panel-box")?.firstElementChild).toHaveClass(
      "profile-stat-grid"
    );
    expect(screen.getByText("Total updates")).toBeInTheDocument();
  });

  it("shows unavailable verification without presenting first-run history as incomplete", () => {
    const snapshot = defaultPersistedSnapshot() as BaselineSnapshot;
    snapshot.profileStats.lifetime = { coverage: "complete", entries: [] };
    snapshot.profileStats.integrityStatus = "unavailable";
    render(<ProfileSection snapshot={snapshot} />);
    expect(
      screen.getByText(/New activity cannot be recorded until verification recovers/)
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Recorded history may omit/)).not.toBeInTheDocument();
  });
});
