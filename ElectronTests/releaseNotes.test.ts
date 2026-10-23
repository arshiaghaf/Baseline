// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const compatibilityNotice =
  "Requires an Apple Silicon Mac (M1 or later) running macOS 15 or later. Intel Macs are not supported.\n\n";

function prepareNotes(changelog: string, checkAssets = false): string {
  const root = mkdtempSync(path.join(tmpdir(), "baseline-release-notes-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(
      path.resolve("scripts/prepare-unsigned-release.sh"),
      path.join(root, "scripts/prepare-unsigned-release.sh")
    );
    // Exercise the real release entry point without packaging an application.
    writeFileSync(
      path.join(root, "scripts/create-unsigned-dmg.sh"),
      '#!/usr/bin/env bash\nset -eu\nmkdir -p dist\nprintf fixture > "dist/Baseline-$1-unsigned.dmg"\n',
      { mode: 0o755 }
    );
    for (const file of ["package.json", "package-lock.json"]) {
      writeFileSync(path.join(root, file), JSON.stringify({ version: "0.8.0" }));
    }
    writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
    execFileSync("bash", ["scripts/prepare-unsigned-release.sh", "0.8.0"], {
      cwd: root,
      stdio: "pipe"
    });
    const notes = readFileSync(
      path.join(root, "dist/Baseline-0.8.0-unsigned-release-notes.md"),
      "utf8"
    );
    if (checkAssets) {
      // The checker consumes exactly the producer output; GitHub is a local fixture.
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "gh"), '#!/usr/bin/env bash\ncat "$RELEASE_FIXTURE"\n', {
        mode: 0o755
      });
      const release = path.join(root, "release.json");
      writeFileSync(
        release,
        JSON.stringify({
          tagName: "v0.8.0",
          name: "Baseline 0.8.0",
          body: notes,
          assets: ["Baseline-0.8.0-unsigned.dmg", "Baseline-0.8.0-unsigned.dmg.sha256"].map(
            (name) => ({ name })
          )
        })
      );
      execFileSync("bash", [path.resolve("scripts/check-release-assets.sh"), "v0.8.0"], {
        cwd: root,
        stdio: "pipe",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_FIXTURE: release }
      });
    }
    return notes;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("release note extraction", () => {
  it.each(["Highlights", "Added", "Fixed"])(
    "passes generated %s-only notes through the release checker",
    (heading) => {
      const notes = `### ${heading}\n\n- Release entry.\n`;
      expect(prepareNotes(`## 0.8.0 — 2026-10-18\n\n${notes}`, true)).toBe(
        compatibilityNotice + notes
      );
    }
  );
  it("preserves Highlights and detailed sections in order, including links", () => {
    const notes = `### Highlights

- **Find updates sooner.** Results appear during refresh. ([#1](https://github.com/example/app/pull/1))

### Added

- New refresh control.

### Fixed

- Recover failed checks.
`;
    expect(prepareNotes(`# Changelog\n\n## 0.8.0 — 2026-10-18\n\n${notes}`)).toBe(
      compatibilityNotice + notes
    );
  });

  it("keeps Added entries and prepends the architecture requirement", () => {
    const notes = "### Added\n\n- Existing release entry.\n";
    expect(prepareNotes(`## 0.8.0 — 2026-10-18\n\n${notes}`)).toBe(compatibilityNotice + notes);
  });

  it("excludes neighboring releases and unsupported subsections", () => {
    expect(
      prepareNotes(`## 0.9.0 — Unreleased

### Highlights

- Future entry.

## 0.8.0 — 2026-10-18

### Highlights

- Current highlight.

### Internal

- Private preparation detail.

### Fixed

- Current fix.

## 0.7.1 — 2026-10-16

### Fixed

- Previous fix.
`)
    ).toBe(
      compatibilityNotice +
        "### Highlights\n\n- Current highlight.\n\n### Fixed\n\n- Current fix.\n"
    );
  });

  it("still rejects an Unreleased section instead of preparing artifacts", () => {
    expect(() => prepareNotes("## 0.8.0 — Unreleased\n\n### Highlights\n\n- Pending.\n")).toThrow();
  });
});
