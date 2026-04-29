#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/create-unsigned-dmg.sh <version>"
  exit 1
fi

VERSION="$1"
APP_NAME="Baseline"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
STAGING_DIR="$DIST_DIR/dmg-staging"
DMG_PATH="$DIST_DIR/${APP_NAME}-${VERSION}-unsigned.dmg"
VOLUME_NAME="${APP_NAME} ${VERSION}"
ARCH="$(uname -m)"
PACKAGE_APP_PATH="$ROOT_DIR/out/${APP_NAME}-darwin-${ARCH}/${APP_NAME}.app"

if [[ ! "$VERSION" =~ ^[0-9]+[.][0-9]+[.][0-9]+([-+][A-Za-z0-9._-]+)?$ ]]; then
  echo "Version must look like 0.1.0 or 0.1.0-beta.1"
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

echo "Preparing DMG staging directory"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
ditto "$PACKAGE_APP_PATH" "$STAGING_DIR/${APP_NAME}.app"
ln -s /Applications "$STAGING_DIR/Applications"

mkdir -p "$DIST_DIR"
rm -f "$DMG_PATH"

echo "Creating $DMG_PATH"
hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

rm -rf "$STAGING_DIR"

echo "Created unsigned DMG:"
echo "$DMG_PATH"
echo
echo "SHA-256:"
shasum -a 256 "$DMG_PATH"
