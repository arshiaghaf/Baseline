# Continuous Integration

This repository uses GitHub Actions for pull request and `main` branch validation.

Baseline is an Electron app that targets macOS first, so CI runs across
GitHub's macOS hosted runners: `macos-26`, `macos-26-intel`, `macos-15`,
`macos-15-intel`, and `macos-14`.

The CI workflow:

- Installs Node dependencies with `npm ci`.
- Lints release scripts with `bash -n`.
- Typechecks the Electron main/preload/renderer TypeScript.
- Runs Vitest unit tests.
- Packages the unsigned Electron app.
- Runs a Playwright Electron smoke test with initial refresh disabled.
- Runs a production dependency audit.

CI intentionally does not launch the app or interact with the tray. Installed-app smoke validation still requires the local desktop session.

The local equivalent for build and test validation is:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:electron
```

For full preview validation, run:

```bash
scripts/validate-preview.sh 0.0.0-preview
```

That command also creates an unsigned DMG and smoke-launches the installed `/Applications/Baseline.app` copy.

Unsigned DMG release publishing is handled by `.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed.
