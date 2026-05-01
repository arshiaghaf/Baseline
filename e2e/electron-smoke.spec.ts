import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("launches the Electron shell and renders the dashboard", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "baseline-e2e-"));
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      BASELINE_SKIP_INITIAL_REFRESH: "1",
      BASELINE_USER_DATA_DIR: userData
    }
  });

  const window = await app.firstWindow();
  await expect(window).toHaveTitle("Baseline");
  await expect(window.locator("h1")).toContainText("All");
  await expect(window.getByRole("button", { name: /^All\s+\d+$/u })).toBeVisible();
  await expect(window.getByRole("button", { name: /^Apps\s+\d+$/u })).toBeVisible();
  await expect(window.getByRole("button", { name: /^Homebrew\s+\d+$/u })).toBeVisible();

  await app.evaluate(async ({ app }) => {
    app.exit(0);
  });
});
