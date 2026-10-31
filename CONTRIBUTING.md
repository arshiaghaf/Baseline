# Contributing to Baseline

Thanks for helping improve Baseline. This project is a macOS Electron app built
with Vite, React, TypeScript, and Tailwind.

## Development Setup

Requirements:

- macOS 15 or later on Apple Silicon for running and validating the app
- Node.js 24.22.2 (pinned in `.node-version` and CI)
- npm

Packages target only macOS arm64, including when built from another host. Native
packaging needs the macOS SDK. Type checking uses tsrs on macOS arm64
and Linux x64/arm64; other hosts fail with an unsupported-platform message.
TypeScript remains installed for typed ESLint rules.

Install dependencies:

```bash
npm ci
```

Run the app during development:

```bash
npm start
```

## Branches And Pull Requests

- Create focused branches for each change.
- Keep pull requests small enough to review.
- Include tests for behavior changes.
- Update docs when user-facing behavior or setup changes.
- Do not commit generated outputs such as `node_modules/`, `out/`, `.vite/`,
  `dist/`, `coverage/`, `test-results/`, or `playwright-report/`.

## Architecture Guidelines

Baseline is intentionally layered:

- `src/shared` defines stable domain contracts, IPC types, security policy,
  version logic, and shared parsers.
- `src/main` owns Electron lifecycle, windows/tray, persistence, filesystem
  access, network clients, subprocess execution, and update policy.
- `src/main/preload.ts` exposes the narrow typed `window.baseline` API.
- `src/renderer` renders React state and dispatches user intents only.
- `ElectronTests` and `e2e` cover unit and Electron smoke behavior.

Avoid adding networking, filesystem scanning, subprocess execution, shell access,
or update-source policy directly inside React components.

## Validation

Run these before opening a pull request:

```bash
npm run prepare:sparkle
npm run typecheck
npm test
npm run lint
npm run format
npm run build
npm run test:electron
```

Production dependency audit:

```bash
npm audit --omit=dev --audit-level=high
```

If a command cannot run in your environment, mention that in the PR and include
the failure output.

## Security-Sensitive Changes

Be careful with code that:

- Runs `brew`, `mas`, or other local executables.
- Parses remote update metadata.
- Opens external URLs.
- Writes persisted app state.
- Expands the preload/IPC API.

Prefer typed inputs, validated executable resolution, argument arrays,
allowlisted external URLs, and conservative fallback behavior.
