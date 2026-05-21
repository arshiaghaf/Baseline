#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
# SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail

APP_NAME="Baseline"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_PATH="/Applications/${APP_NAME}.app"
VERSION="${1:-0.0.0-preview}"
ARCH="$(uname -m)"
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

trap cleanup_mount EXIT

stop_existing_app() {
  if ! pgrep -x "$APP_NAME" >/dev/null; then
    return
  fi

  echo "Stopping existing ${APP_NAME} process"
  osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true

  for _ in {1..20}; do
    if ! pgrep -x "$APP_NAME" >/dev/null; then
      return
    fi
    sleep 0.25
  done

  pkill -x "$APP_NAME" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    if ! pgrep -x "$APP_NAME" >/dev/null; then
      return
    fi
    sleep 0.25
  done

  echo "Could not stop existing ${APP_NAME} process before smoke launch."
  exit 1
}

smoke_launch_app() {
  local app_path="$1"
  local label="$2"

  echo "Launching $label"
  stop_existing_app
  open "$app_path"

  for _ in {1..40}; do
    if pgrep -x "$APP_NAME" >/dev/null; then
      echo "Smoke launch succeeded for $label."
      stop_existing_app
      return
    fi
    sleep 0.25
  done

  echo "Smoke launch failed for $label; ${APP_NAME} process was not detected."
  exit 1
}

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

smoke_launch_app "$MOUNT_DIR/${APP_NAME}.app" "mounted preview app"

if [[ ! -d "$PACKAGE_APP_PATH" ]]; then
  echo "Packaged app bundle was not found at $PACKAGE_APP_PATH"
  exit 1
fi

echo "Installing mounted app to $INSTALL_PATH"
stop_existing_app
rm -rf "$INSTALL_PATH"
ditto "$MOUNT_DIR/${APP_NAME}.app" "$INSTALL_PATH"

smoke_launch_app "$INSTALL_PATH" "installed preview app"
echo "Known-good preview validation completed."
