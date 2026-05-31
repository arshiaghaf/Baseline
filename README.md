# Baseline

![Release: Pending](https://img.shields.io/badge/release-pending-0a0a0c?style=flat-square)
&nbsp;
![Project status: Beta](https://img.shields.io/badge/status-beta-blue?style=flat-square)
&nbsp;
![Minimum macOS version: 14.0+](https://img.shields.io/badge/macOS-14.0%2B-0a0a0c?style=flat-square)
&nbsp;
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-6e5aff?style=flat-square)](https://github.com/arshiaghaf/Baseline/blob/main/LICENSE)

Baseline is a macOS app for managing and updating installed Mac apps and Homebrew packages from one place. It supports App Store apps, direct downloads, Sparkle-enabled apps, and Homebrew casks and formulae.

You can check for app updates, run Homebrew upgrades, search and install Homebrew packages, ignore specific items so they no longer appear as available updates, and open update pages for apps that require manual action.

![Baseline full app window showing app and Homebrew updates](docs/images/baseline-main-window.png)

## What Baseline Does

Baseline scans installed apps from system, user, and custom app directories, then checks public update sources for newer versions. It shows available updates, recently updated items, ignored items, and Homebrew discovery results without requiring a backend service or private APIs.

When the required local tooling is available, Baseline can run update and install actions through Homebrew or `mas`. When that tooling is unavailable, it provides external fallback links.

## Features

- Detects updates from App Store lookup, Sparkle and DevMate appcasts, and Homebrew metadata
- Provides unified update views for Mac apps, Homebrew casks, and Homebrew formulae
- Shows recently updated items so you can see what was updated and when
- Lets you ignore specific apps or Homebrew items so they stay out of the main update list
- Supports uninstalling Homebrew-managed casks and formulae from item actions
- Supports Homebrew search from the main window and menu bar tray to discover installable casks and formulae
- Lets you search installed apps and filter available updates
- Provides external fallback links when local CLI tooling is unavailable
  
![Baseline Ignored tab showing app and Homebrew item actions](docs/images/baseline-ignored-updates.png)

![Baseline main window Homebrew search showing installable casks](docs/images/baseline-homebrew-search.png)
  
![Baseline menu bar tray showing app and Homebrew updates](docs/images/baseline-menu-bar.png)

## Project Status

Baseline is currently in beta. The core app experience works end to end, with ongoing polish focused on UI, packaging, and release quality.

Packaged unsigned DMGs are available on the [GitHub Releases](https://github.com/arshiaghaf/Baseline/releases) page.

## Install

Download the latest unsigned DMG from the [GitHub Releases](https://github.com/arshiaghaf/Baseline/releases) page. Unsigned builds are not notarized by Apple, so macOS Gatekeeper may warn when opening them.

## Build from Source

Requirements:

- macOS 14.0 or newer
- Node.js 25 or newer
- npm

## Build and Test

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:electron
```

Run the app during development:

```bash
npm start
```

## Limitations

- Update detection is best-effort and depends on public update sources exposed by installed apps, Apple lookup endpoints, and Homebrew metadata.
- Homebrew actions require Homebrew to be installed. Without it, Baseline opens external Homebrew or app pages instead.
- App Store update actions use optional local `mas` support when available. Without `mas`, Baseline opens the App Store page externally.
- Packaged releases are not signed or notarized yet.

## Privacy and Security

Baseline uses public update sources and local tooling. It does not require private Apple frameworks, a backend service, or an API key.

The app may query public services such as Apple lookup endpoints, Sparkle or appcast URLs declared by installed apps, and Homebrew metadata endpoints. Homebrew and `mas` actions run locally when you choose those update paths.

Report suspected security issues using the process in [SECURITY.md](SECURITY.md).

## Architecture

Baseline keeps update logic outside React views:

- `src/shared` defines domain contracts, persistence snapshots, security policy, and shared parsers.
- `src/main` contains Electron lifecycle, windows/tray, privileged IO, scanning, network lookup, subprocess execution, persistence, and IPC.
- `src/renderer` renders React state and dispatches user intents through the preload API.
- `ElectronTests` covers parsers, version logic, security checks, renderer behavior, persistence, store behavior, Homebrew app linking, and source-client fixtures.
- `e2e` covers Electron launch smoke tests.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for more detail.
See [docs/VALIDATION.md](docs/VALIDATION.md) for preview validation.

## Release Tooling

For a fuller local release preview, run:

```bash
scripts/validate-preview.sh 0.0.0-preview
```

This builds, tests, packages an unsigned DMG, installs `/Applications/Baseline.app`, and smoke-launches the installed copy.

## Package an Unsigned DMG

```bash
scripts/create-unsigned-dmg.sh 0.1.0
```

The script builds a Release app, creates `dist/Baseline-0.1.0-unsigned.dmg`, and prints a SHA-256 checksum. See [docs/RELEASING.md](docs/RELEASING.md) for release steps and limitations.

To create the unsigned DMG plus release-note checksum text:

```bash
scripts/prepare-unsigned-release.sh 0.1.0
```

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), follow the pull request template, and run the validation commands before opening a PR.

## License

Baseline is licensed under `GPL-3.0-only`. See [LICENSE](LICENSE) for the full
GNU General Public License v3.0 text.

Copyright (C) 2026 Arshia Ghaffarian.

Distributed modified versions must remain licensed under the GPL and include
the corresponding source code, license text, copyright notices, and other notices
required by the license.
