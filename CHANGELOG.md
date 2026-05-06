# Changelog

All notable changes to Baseline will be documented in this file.

This project follows a lightweight changelog format inspired by Keep a Changelog. Versioning policy may evolve before 1.0.

## Unreleased

- Initial open-source repository preparation.
- Migrated Baseline from Swift/Tuist to Electron, Vite, React, TypeScript, and Tailwind.
- Added a full app window alongside the compact menu bar tray window.
- Added Electron tests and Playwright Electron smoke coverage.
- Added Homebrew cask/formula inventory, update, install, discovery, and uninstall flows.
- Preserved public update detection through App Store lookup, Sparkle/DevMate appcasts, and Homebrew metadata.
- Added a local diagnostics report from Settings for support and troubleshooting.
- Added preview validation and unsigned release preparation scripts.
- Added GitHub Actions CI and unsigned DMG release publishing.
- Documented the preview validation checklist.
- Removed the legacy Swift/Tuist source from `main`; the previous implementation is archived at branch `legacy/swift-tuist` and tag `swift-tuist-final`.
