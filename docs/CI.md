# Continuous Integration

This repository uses GitHub Actions for pull request and `main` branch validation.

Baseline is an Electron app that targets macOS first, so CI runs across
GitHub's macOS hosted runners: `macos-26`, `macos-26-intel`, `macos-15`,
and `macos-15-intel`.

The CI workflow:

- Installs Node dependencies with `npm ci`.
- Lints release scripts with `bash -n`.
- Typechecks the Electron main/preload/renderer TypeScript.
- Runs Vitest unit tests.
- Packages the unsigned Electron app.
- Runs Playwright Electron smoke tests with initial refresh disabled, temporary
  user data, and an injected test secret provider that never accesses Keychain.
- Runs a production dependency audit.

The smoke tests launch a disposable copy of the packaged app. Test setup rebuilds
only its main-process bundle with a test provider, preserving the production
HMAC verification and tamper handling. Before launch, setup verifies that the
production Keychain provider was excluded. The original package in `out/` keeps
the production provider and is never launched by these tests. Runtime environment
variables cannot select the test provider in a production build.

Installed-app and real Keychain validation still require a separate manual check.

The local equivalent for build and test validation is:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:electron
```

Unsigned DMG release artifact builds are handled by `.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed.
