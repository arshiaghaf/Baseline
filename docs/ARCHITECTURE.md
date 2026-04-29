# Architecture

Baseline is a standalone macOS Electron app. It scans installed apps, checks public update sources, and routes users to the safest available update action from both the full app window and a compact menu bar tray window.

## Layers

Baseline keeps IO and policy out of React views:

- `src/shared` contains domain contracts, version comparison, support levels, update records, persistence snapshots, security policy, and shared parsers.
- `src/main` contains Electron app lifecycle, windows/tray, IPC handlers, source-specific scanning, network lookup, parsing, subprocess execution, persistence, and update actions.
- `src/renderer` renders state and sends user intents through the narrow preload API.

The preload bridge exposes explicit methods such as `getSnapshot`, `refresh`, `performAppUpdate`, `performHomebrewUpdate`, `chooseDirectory`, and `copyDiagnostics`. Renderers do not receive direct Node or Electron access.

## Update Sources

Supported sources:

- App Store lookup API.
- Sparkle/DevMate appcast parsing.
- Homebrew cask and formula metadata.

Precedence for app updates is:

```text
App Store > Sparkle/Appcast > Homebrew
```

When a direct update action is unavailable or unsafe, Baseline should show an explicit external-update fallback instead of guessing.

## Safety Boundaries

Baseline should not use private Apple frameworks, bundled secrets, API keys, or a backend service.

Subprocess actions should use argument arrays and validated executable paths. Homebrew token input should pass existing validation before being used in commands.

React views should not perform networking, scanning, subprocess execution, or source-precedence decisions.
