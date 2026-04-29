import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppStoreLookupClient } from "../src/main/appStoreLookupClient";
import { HomebrewCaskClient } from "../src/main/homebrewCaskClient";
import { HomebrewFormulaClient } from "../src/main/homebrewFormulaClient";
import { HomebrewInventoryParser } from "../src/main/homebrewInventoryClient";
import { SparkleAppcastClient } from "../src/main/sparkleAppcastClient";
import { version } from "../src/shared/version";

const fixtures = path.join(process.cwd(), "Tests", "Fixtures");

describe("ported clients", () => {
  it("parses App Store lookup fixtures", () => {
    const data = readFileSync(path.join(fixtures, "app_store_lookup.json"));
    const result = new AppStoreLookupClient().parseLookupResponse(data, version("2.0.0"));
    expect(result?.remoteVersion.raw).toBe("2.3.1");
    expect(result?.appStoreItemID).toBe(123456789);
  });

  it("parses Sparkle appcast fixtures", () => {
    const data = readFileSync(path.join(fixtures, "sparkle_appcast.xml"));
    const result = new SparkleAppcastClient().parseAppcast(data, version("1.0.0"));
    expect(result?.remoteVersion.raw).toBe("2.0.0");
    expect(result?.updateURL).toBe("https://example.com/download/2.0.0.zip");
  });

  it("parses Homebrew cask schema drift fixtures", () => {
    const data = readFileSync(path.join(fixtures, "homebrew_cask_drift.json"));
    const index = new HomebrewCaskClient().parseIndex(data);
    expect(index.byBundleIdentifier["com.example.app"]?.token).toBe("example-app");
    expect(index.byAppBundleName["example.app"]?.[0]?.token).toBe("example-app");
  });

  it("searches formulae", () => {
    const client = new HomebrewFormulaClient();
    const index = client.parseIndex(
      Buffer.from(
        JSON.stringify([
          {
            name: "ripgrep",
            versions: { stable: "14.1.0" },
            homepage: "https://github.com/BurntSushi/ripgrep",
            desc: "Search tool"
          }
        ])
      )
    );
    expect(client.searchFormulae("rip", index, new Set()).at(0)?.token).toBe("ripgrep");
  });

  it("builds Homebrew inventory from installed and outdated output", () => {
    const inventory = new HomebrewInventoryParser().buildInventory(
      "ripgrep 14.0.0\n",
      "notion 4.0.0\n",
      JSON.stringify({ formulae: [{ name: "ripgrep", current_version: "14.1.0" }] }),
      JSON.stringify({ casks: [{ token: "notion", current_version: "4.1.0" }] })
    );
    expect(inventory.find((item) => item.token === "ripgrep")?.isOutdated).toBe(true);
    expect(inventory.find((item) => item.token === "notion")?.latestVersion?.raw).toBe("4.1.0");
  });
});
