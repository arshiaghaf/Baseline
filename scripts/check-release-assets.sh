#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
# SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "Usage: scripts/check-release-assets.sh [tag]"
  exit 1
fi

TAG="${1:-$(git describe --tags --abbrev=0)}"
REPOSITORY="arshiaghaf/Baseline"

if [[ ! "$TAG" =~ ^v(0|[1-9][0-9]*)[.](0|[1-9][0-9]?)[.](0|[1-9][0-9]?)$ ]]; then
  echo "Tag must look like v0.1.0 with minor and patch below 100"
  exit 1
fi

command -v gh >/dev/null 2>&1 || {
  echo "gh is required."
  exit 1
}

VERSION="${TAG#v}"
DMG_ASSET="Baseline-${VERSION}-unsigned.dmg"
CHECKSUM_ASSET="${DMG_ASSET}.sha256"
RELEASE_JSON="$(gh release view "$TAG" --repo "$REPOSITORY" --json assets,body,name,tagName)"

release_tag="$(printf "%s" "$RELEASE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).tagName")"
release_name="$(printf "%s" "$RELEASE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).name")"
assets="$(printf "%s" "$RELEASE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).assets.map((asset) => asset.name).join('\n')")"
body="$(printf "%s" "$RELEASE_JSON" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).body")"

if [[ "$release_tag" != "$TAG" ]]; then
  echo "Release tag is $release_tag, expected $TAG"
  exit 1
fi

if [[ "$release_name" != "Baseline ${VERSION}" ]]; then
  echo "Release title is '$release_name', expected 'Baseline ${VERSION}'"
  exit 1
fi

for asset in "$DMG_ASSET" "$CHECKSUM_ASSET"; do
  if ! printf "%s\n" "$assets" | grep -Fxq "$asset"; then
    echo "Release $TAG is missing asset: $asset"
    exit 1
  fi
done

if ! printf "%s" "$body" | grep -Eq '^### (Added|Fixed)$'; then
  echo "Release notes must contain an Added and/or Fixed section."
  exit 1
fi

for forbidden in "# Baseline" "## What's Changed" "## Download" "## SHA-256" "## Install" "## Build Note"; do
  if printf "%s" "$body" | grep -Fq "$forbidden"; then
    echo "Release notes contain unexpected section: $forbidden"
    exit 1
  fi
done

echo "Release $TAG has expected Baseline assets and notes."
