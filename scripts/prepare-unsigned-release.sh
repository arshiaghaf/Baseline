#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
# SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/prepare-unsigned-release.sh <version>"
  exit 1
fi

VERSION="$1"
APP_NAME="Baseline"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DMG_PATH="$ROOT_DIR/dist/${APP_NAME}-${VERSION}-unsigned.dmg"
CHECKSUM_PATH="$ROOT_DIR/dist/${APP_NAME}-${VERSION}-unsigned.dmg.sha256"
NOTES_PATH="$ROOT_DIR/dist/${APP_NAME}-${VERSION}-unsigned-release-notes.md"
CHANGELOG_SECTION_PATH="$(mktemp)"

trap 'rm -f "$CHANGELOG_SECTION_PATH"' EXIT

if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)[.](0|[1-9][0-9]?)[.](0|[1-9][0-9]?)$ ]]; then
  echo "Version must look like 0.1.0 with minor and patch below 100"
  exit 1
fi

cd "$ROOT_DIR"

command -v node >/dev/null 2>&1 || {
  echo "node is required."
  exit 1
}

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
PACKAGE_LOCK_VERSION="$(node -p "require('./package-lock.json').version")"

if [[ "$PACKAGE_VERSION" != "$VERSION" ]]; then
  echo "package.json version ($PACKAGE_VERSION) must match release version ($VERSION)."
  exit 1
fi

if [[ "$PACKAGE_LOCK_VERSION" != "$VERSION" ]]; then
  echo "package-lock.json version ($PACKAGE_LOCK_VERSION) must match release version ($VERSION)."
  exit 1
fi

VERSION="$VERSION" CHANGELOG_SECTION_PATH="$CHANGELOG_SECTION_PATH" node <<'NODE'
const fs = require("fs");

const version = process.env.VERSION;
const outputPath = process.env.CHANGELOG_SECTION_PATH;
const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
const lines = changelog.split(/\r?\n/);
const releaseNoteHeadings = new Set(["### Added", "### Fixed"]);
const headingPattern = new RegExp(
  `^## ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — \\d{4}-\\d{2}-\\d{2}$`,
);
const headingIndex = lines.findIndex((line) => headingPattern.test(line));

if (headingIndex === -1) {
  console.error(
    `CHANGELOG.md must contain a finalized section heading like "## ${version} — YYYY-MM-DD" before preparing a release.`,
  );
  process.exit(1);
}

let nextHeadingIndex = lines.findIndex(
  (line, index) => index > headingIndex && line.startsWith("## "),
);

if (nextHeadingIndex === -1) {
  nextHeadingIndex = lines.length;
}

const sectionLines = lines.slice(headingIndex + 1, nextHeadingIndex);
const releaseNoteLines = [];
let includeCurrentSubsection = false;

while (sectionLines.length > 0 && sectionLines[0].trim() === "") {
  sectionLines.shift();
}

while (
  sectionLines.length > 0 &&
  sectionLines[sectionLines.length - 1].trim() === ""
) {
  sectionLines.pop();
}

if (sectionLines.length === 0) {
  console.error(`CHANGELOG.md section for ${version} must not be empty.`);
  process.exit(1);
}

for (const line of sectionLines) {
  if (line.startsWith("### ")) {
    includeCurrentSubsection = releaseNoteHeadings.has(line);
  }

  if (includeCurrentSubsection) {
    releaseNoteLines.push(line);
  }
}

while (
  releaseNoteLines.length > 0 &&
  releaseNoteLines[releaseNoteLines.length - 1].trim() === ""
) {
  releaseNoteLines.pop();
}

if (releaseNoteLines.length === 0) {
  console.error(
    `CHANGELOG.md section for ${version} must contain an Added or Fixed section for release notes.`,
  );
  process.exit(1);
}

fs.writeFileSync(outputPath, `${releaseNoteLines.join("\n")}\n`);
NODE

scripts/create-unsigned-dmg.sh "$VERSION"

if [[ ! -f "$DMG_PATH" ]]; then
  echo "Expected DMG was not created at $DMG_PATH"
  exit 1
fi

CHECKSUM="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"

echo "${CHECKSUM}  ${APP_NAME}-${VERSION}-unsigned.dmg" > "$CHECKSUM_PATH"

cp "$CHANGELOG_SECTION_PATH" "$NOTES_PATH"

echo "Prepared unsigned release artifact:"
echo "$DMG_PATH"
echo
echo "Prepared checksum:"
echo "$CHECKSUM_PATH"
echo
echo "Prepared release notes:"
echo "$NOTES_PATH"
echo
echo "SHA-256:"
echo "${CHECKSUM}  ${APP_NAME}-${VERSION}-unsigned.dmg"
