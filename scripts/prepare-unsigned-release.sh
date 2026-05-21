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

if [[ ! "$VERSION" =~ ^[0-9]+[.][0-9]+[.][0-9]+([-+][A-Za-z0-9._-]+)?$ ]]; then
  echo "Version must look like 0.1.0 or 0.1.0-beta.1"
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

if ! grep -Eq '^## (Unreleased|[0-9]+[.][0-9]+[.][0-9]+([-+][A-Za-z0-9._-]+)? — Unreleased)$' CHANGELOG.md; then
  echo "CHANGELOG.md must contain an Unreleased section heading before preparing a release."
  exit 1
fi

scripts/create-unsigned-dmg.sh "$VERSION"

if [[ ! -f "$DMG_PATH" ]]; then
  echo "Expected DMG was not created at $DMG_PATH"
  exit 1
fi

CHECKSUM="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"

echo "${CHECKSUM}  ${APP_NAME}-${VERSION}-unsigned.dmg" > "$CHECKSUM_PATH"

cat > "$NOTES_PATH" <<NOTES
# Baseline ${VERSION} unsigned preview

This is an unsigned preview build. It is not notarized by Apple, and macOS may show an unidentified-developer warning.

## Download

- ${APP_NAME}-${VERSION}-unsigned.dmg

## SHA-256

\`\`\`text
${CHECKSUM}  ${APP_NAME}-${VERSION}-unsigned.dmg
\`\`\`

## Install

Open the DMG and drag ${APP_NAME}.app to /Applications.
NOTES

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
