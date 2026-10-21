#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Arshia Ghaf
# SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/create-unsigned-dmg.sh <version>"
  exit 1
fi

VERSION="$1"
APP_NAME="Baseline"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
DMG_PATH="$DIST_DIR/${APP_NAME}-${VERSION}-unsigned.dmg"
VOLUME_NAME="${APP_NAME} ${VERSION}"
ARCH="$(uname -m)"
if [[ "$ARCH" == "x86_64" ]]; then
  ARCH="x64"
fi
PACKAGE_APP_PATH="$ROOT_DIR/out/${APP_NAME}-darwin-${ARCH}/${APP_NAME}.app"

if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)[.](0|[1-9][0-9]?)[.](0|[1-9][0-9]?)(-preview)?$ ]]; then
  echo "Version must look like 0.1.0 or 0.0.0-preview with minor and patch below 100"
  exit 1
fi

command -v npm >/dev/null 2>&1 || {
  echo "npm is required."
  exit 1
}

command -v hdiutil >/dev/null 2>&1 || {
  echo "hdiutil is required to create a DMG."
  exit 1
}

cd "$ROOT_DIR"

echo "Building Electron app"
npm run typecheck
npm test
npm run package

if [[ ! -d "$PACKAGE_APP_PATH" ]]; then
  echo "Packaged app bundle was not found at $PACKAGE_APP_PATH"
  exit 1
fi

node scripts/package-dmg.mjs "$PACKAGE_APP_PATH" "$DMG_PATH" "$VOLUME_NAME"

echo "Created unsigned DMG:"
echo "$DMG_PATH"
echo
echo "SHA-256:"
shasum -a 256 "$DMG_PATH"
