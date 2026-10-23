// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  HomebrewMaintenanceOutputParser,
  HomebrewMaintenanceProgressStage
} from "../src/shared/homebrewProgress";

describe("HomebrewMaintenanceOutputParser", () => {
  it.each([
    "Warning: Not upgrading example, the latest version is already installed",
    "Warning: Not upgrading example, the downloaded artifact has not changed",
    "Warning: example 2.0 already installed",
    "example is up-to-date"
  ])("distinguishes unchanged packages from completed updates: %s", (line) => {
    const parser = new HomebrewMaintenanceOutputParser(["example", "other"]);
    expect(parser.parse(line, ["upgrade", "--cask", "example"])).toEqual([
      { token: "example", kindHint: "cask", kind: { type: "unchanged" } }
    ]);
  });

  it("distinguishes Homebrew's skipped cask warning from an installation", () => {
    const parser = new HomebrewMaintenanceOutputParser(["example", "example-helper"]);
    expect(
      parser.parse("Warning: The cask 'example' cannot be upgraded as-is. To fix this, run:", [
        "upgrade",
        "--cask",
        "--greedy",
        "example"
      ])
    ).toEqual([{ token: "example", kindHint: "cask", kind: { type: "skipped" } }]);
  });

  it("parses progress, completion, failure, and token boundaries", () => {
    const parser = new HomebrewMaintenanceOutputParser(["notion", "notion-helper"]);

    expect(parser.parse("Downloading notion", ["upgrade", "--cask"]).at(0)).toEqual({
      token: "notion",
      kindHint: "cask",
      kind: { type: "progress", progress: HomebrewMaintenanceProgressStage.downloading }
    });
    expect(
      parser.parse("🍺 notion was successfully installed", ["upgrade", "--cask"]).at(0)?.kind
    ).toEqual({
      type: "completed"
    });
    expect(
      parser.parse("Error: failed to install notion", ["upgrade", "--cask"]).at(0)?.kind
    ).toEqual({
      type: "failed"
    });
    expect(
      parser.parse("Downloading notion-helper", ["upgrade", "--cask"]).map((event) => event.token)
    ).toEqual(["notion-helper"]);
  });
});
