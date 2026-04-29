#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Baseline"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_PATH="/Applications/${APP_NAME}.app"
VERSION="${1:-0.0.0-preview}"
ARCH="$(uname -m)"
PACKAGE_APP_PATH="$ROOT_DIR/out/${APP_NAME}-darwin-${ARCH}/${APP_NAME}.app"

cd "$ROOT_DIR"

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

if [[ ! -d "$PACKAGE_APP_PATH" ]]; then
  echo "Packaged app bundle was not found at $PACKAGE_APP_PATH"
  exit 1
fi

echo "Installing packaged app to $INSTALL_PATH"
stop_existing_app
rm -rf "$INSTALL_PATH"
ditto "$PACKAGE_APP_PATH" "$INSTALL_PATH"

echo "Launching installed app"
open "$INSTALL_PATH"

for _ in {1..40}; do
  if pgrep -x "$APP_NAME" >/dev/null; then
    echo "Smoke launch succeeded."
    echo "Known-good preview validation completed."
    exit 0
  fi
  sleep 0.25
done

echo "Smoke launch failed; ${APP_NAME} process was not detected."
exit 1
