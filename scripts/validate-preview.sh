#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Arshia Ghaf
# SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail

APP_NAME="Baseline"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_PATH="/Applications/${APP_NAME}.app"
VERSION="${1:-0.0.0-preview}"
ARCH="arm64"
if [[ "$(uname -m)" != "$ARCH" ]]; then
  echo "Installed previews require an Apple Silicon Mac."
  exit 1
fi
PACKAGE_APP_PATH="$ROOT_DIR/out/${APP_NAME}-darwin-${ARCH}/${APP_NAME}.app"
DMG_PATH="$ROOT_DIR/dist/${APP_NAME}-${VERSION}-unsigned.dmg"
MOUNT_DIR=""

cd "$ROOT_DIR"

cleanup_mount() {
  if [[ -n "$MOUNT_DIR" && -d "$MOUNT_DIR" ]]; then
    hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
    rm -rf "$MOUNT_DIR"
  fi
}

source "$ROOT_DIR/scripts/preview-install.sh"
TRANSACTION_DIR=""
PREVIEW_PID=""
PREVIEW_LAUNCH_STARTED=false
cleanup_preview() {
  if [[ -n "$TRANSACTION_DIR" ]]; then recover_preview; fi
  cleanup_mount
  if [[ "${INSTALL_LOCK_HELD:-false}" == true ]]; then rmdir "$INSTALL_LOCK"; fi
}
trap cleanup_preview EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Checking generated artifacts are ignored"
for ignored_path in "node_modules" "out" ".vite" "dist"; do
  git check-ignore -q "$ignored_path" || {
    echo "Expected $ignored_path to be ignored."
    exit 1
  }
done

echo "Linting scripts"
bash -n scripts/create-unsigned-dmg.sh
bash -n scripts/prepare-unsigned-release.sh
bash -n scripts/validate-preview.sh
bash -n scripts/preview-install.sh

echo "Running Electron validation"
npm run typecheck
npm test
npm run lint
npm run format
npm run build
npm run test:electron

echo "Creating unsigned preview DMG"
scripts/create-unsigned-dmg.sh "$VERSION"

if [[ ! -f "$DMG_PATH" ]]; then
  echo "Unsigned preview DMG was not found at $DMG_PATH"
  exit 1
fi

echo "Verifying unsigned preview DMG"
MOUNT_DIR="$(mktemp -d "$ROOT_DIR/dist/dmg-mount.XXXXXX")"
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_DIR" -nobrowse -readonly -quiet

if [[ ! -d "$MOUNT_DIR/${APP_NAME}.app" ]]; then
  echo "Mounted DMG did not contain ${APP_NAME}.app"
  exit 1
fi

if [[ ! -L "$MOUNT_DIR/Applications" ]]; then
  echo "Mounted DMG did not contain an Applications symlink."
  exit 1
fi

INSTALL_LOCK="$(dirname "$INSTALL_PATH")/.Baseline-preview-lock"
if ! mkdir "$INSTALL_LOCK"; then
  echo "Another preview installation may be active. Inspect $INSTALL_LOCK before retrying."
  exit 1
fi
INSTALL_LOCK_HELD=true
TRANSACTION_DIR="$(mktemp -d "$(dirname "$INSTALL_PATH")/.Baseline-preview.XXXXXX")"
# Check before the mounted smoke too: another copy can hold the shared app lock.
if [[ -e "$INSTALL_PATH" || -L "$INSTALL_PATH" ]]; then
  require_app_stopped "$INSTALL_PATH"
fi
verify_preview_bundle "$MOUNT_DIR/${APP_NAME}.app" "$PACKAGE_APP_PATH"
smoke_launch_app "$MOUNT_DIR/${APP_NAME}.app" "mounted preview app"

if [[ ! -d "$PACKAGE_APP_PATH" ]]; then
  echo "Packaged app bundle was not found at $PACKAGE_APP_PATH"
  exit 1
fi

echo "Installing mounted app to $INSTALL_PATH"
install_preview "$MOUNT_DIR/${APP_NAME}.app"
echo "Known-good preview validation completed."
