#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Arshia Ghaf
# SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail

# Explicit local signing preparation only. Never exports a key or publishes a release.
if [[ $# -ne 1 || ! "$1" =~ ^(0|[1-9][0-9]*)[.](0|[1-9][0-9]?)[.](0|[1-9][0-9]?)$ ]]; then
  echo "Usage: scripts/prepare-signed-updates.sh <stable-version>" >&2
  exit 1
fi
version="$1"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
test "$(node -p 'require("./package.json").version')" = "$version"
if [[ -n "${BASELINE_SELF_UPDATE_PUBLIC_KEY+x}" || -n "${BASELINE_BUILD_NUMBER+x}" ]]; then
  echo "Production signing refuses public-key or build-number overrides." >&2
  exit 1
fi
destination="dist/signed-updates-${version}"
if [[ -e "$destination" ]]; then
  echo "Refusing to overwrite existing signed update preparation: $destination" >&2
  exit 1
fi
npm run prepare:sparkle
account="$(node -p 'require("./native/self-updater/publisher.json").keychainAccount')"
# Public-key-only lookup ensures this Mac's key matches the key embedded in builds.
public_key="$(node_modules/.cache/baseline-sparkle/2.10.1/upstream/bin/generate_keys --account "$account" -p)"
expected_key="$(node -p 'require("./native/self-updater/publisher.json").publicKey')"
if [[ "$public_key" != "$expected_key" ]]; then
  echo "This Mac's Keychain signing key does not match the approved publisher." >&2
  exit 1
fi
BASELINE_ENABLE_SIGNED_UPDATES=1 scripts/prepare-unsigned-release.sh "$version"
app="out/Baseline-darwin-arm64/Baseline.app"
embedded_key="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$app/Contents/Info.plist")"
if [[ "$embedded_key" != "$expected_key" ]]; then
  echo "The packaged app does not embed the approved publisher key." >&2
  exit 1
fi
mkdir "$destination"
/usr/bin/codesign --verify --deep --strict "$app"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app" "$destination/Baseline-${version}-arm64.zip"
cp "dist/Baseline-${version}-unsigned-release-notes.md" "$destination/Baseline-${version}-arm64.md"
node_modules/.cache/baseline-sparkle/2.10.1/upstream/bin/generate_appcast \
  --account "$account" \
  --download-url-prefix "https://github.com/arshiaghaf/Baseline/releases/download/v${version}/" \
  "$destination"
echo "Signed update artifacts prepared for review at $destination. Nothing was published."
