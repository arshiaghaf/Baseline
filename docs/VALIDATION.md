# Validation

Use this checklist before handing off a local preview build, preparing a release, or validating risky app behavior changes.

## Known-Good Preview

```bash
scripts/validate-preview.sh 0.0.0-preview
```

The script checks ignored generated artifacts, lints release scripts, typechecks Electron code, runs Vitest and Playwright Electron tests, packages the app, creates an unsigned DMG, installs the packaged app to `/Applications/Baseline.app`, and smoke-launches the installed app.

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

- `dist/Baseline-<version>-unsigned.dmg` exists.
- `dist/Baseline-<version>-unsigned-release-notes.md` contains only the `Added` and/or `Fixed` subsections from the finalized changelog section.
- The DMG opens and `Baseline.app` can be copied to `/Applications`.
