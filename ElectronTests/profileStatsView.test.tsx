// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileSection } from "../src/renderer/components/SettingsView";
import { defaultPersistedSnapshot, type BaselineSnapshot } from "../src/shared/domain";

afterEach(cleanup);

describe("profile history coverage", () => {
  it("explains that migrated counts are a known minimum beside the metrics", () => {
    const snapshot = defaultPersistedSnapshot() as BaselineSnapshot;
    snapshot.profileStats.lifetime = { coverage: "lowerBound", entries: [] };
    render(<ProfileSection snapshot={snapshot} />);
    expect(
      screen.getByText(/Earlier activity may be missing, so counts are a known minimum/)
    ).toBeInTheDocument();
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
    expect(screen.queryByText(/known minimum/)).not.toBeInTheDocument();
  });
});
