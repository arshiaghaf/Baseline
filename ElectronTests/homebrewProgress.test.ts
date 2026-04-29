import { describe, expect, it } from "vitest";
import {
  HomebrewMaintenanceOutputParser,
  HomebrewMaintenanceProgressStage
} from "../src/shared/homebrewProgress";

describe("HomebrewMaintenanceOutputParser", () => {
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
