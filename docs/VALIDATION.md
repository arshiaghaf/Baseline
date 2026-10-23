# Validation

Use this checklist before preparing a release or validating risky app behavior changes.

## Manual Smoke Matrix

Validate at least one item in each category when possible:

- App Store app with an available update.
- Sparkle or DevMate app with a valid appcast.
- Homebrew cask app with an available update.
- Homebrew formula with an available update.
- Current app with no update.
- Ignored app and ignored Homebrew item.
- Unsupported app with only an external fallback.
- App with malformed or missing update metadata.
- Missing `mas` fallback path.
- Missing Homebrew fallback path.

## Release Artifact Check

```bash
scripts/prepare-unsigned-release.sh <version>
```

Confirm:

- The app executable, Electron Framework, and native admin helper contain only arm64 slices (`lipo -archs`).
- Release notes state that Apple Silicon and macOS 15 or later are required.

- `dist/Baseline-<version>-unsigned.dmg` exists.
- `dist/Baseline-<version>-unsigned-release-notes.md` contains the Apple Silicon requirement followed by the `Highlights`, `Added`, and/or `Fixed` subsections from the finalized changelog section.
- The DMG opens and `Baseline.app` can be copied to `/Applications`.

After the GitHub Release is created, verify its published assets and notes:

```bash
scripts/check-release-assets.sh v<version>
```

## Installed Preview Helper

Run `scripts/validate-preview.sh [preview-version]` only when an installed preview
is intended. Quit the installed app after its current operations finish before
replacement; the helper refuses to stop an existing user session. It stages the
copy beside the installation, checks its bundle identity and signing hash, then
moves the previous bundle into the reported recovery directory. A successful
installed preview stays running for inspection.

Copy and verification failures retain the previous bundle. Automatic restoration
is permitted only before any preview launch and while the installation path is
still absent. The mounted smoke already uses the ordinary user profile and may
persist migrations. After that first launch, failed or interrupted promotion
retains the old bundle in the recovery directory for a compatibility check before
manual restoration; the installation path may remain absent. Restoring a bundle
does not reverse user-data migrations. Recovery directories and launch logs are
retained after completion. If a crash leaves `.Baseline-preview-lock` in the
installation directory, confirm no helper is running before removing that empty
lock directory and retrying.
