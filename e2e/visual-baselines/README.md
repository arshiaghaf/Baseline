# Electron renderer visual baselines

The source baseline is `a3292e0b3a5b0735b681eb5f9568023ecbcb9ac2`.
Application source is unchanged in the baseline PR. Keep its committed PNGs
unchanged throughout the renderer extraction stack.

The retained comparison lane is local macOS 27.2 build 26B5112a, Apple Silicon,
DPR 2, Electron 44.7.0 / Chromium 152.0.7977.130. Its 176 original PNGs are in
`macos-27-arm64-software-srgb`; the 16 cases use main content viewports 660×760
and 1280×900, and tray 360×560 and 440×640. Visual launches use
`--disable-gpu --force-color-profile=srgb`. This software-rendered lane does not
establish production GPU/backdrop rendering equivalence.

CI screenshot portability is deferred with user approval. Ordinary CI retains all
five macOS lanes and its existing tests, build and default-GPU Electron smoke
coverage; it does not run or establish screenshot acceptance. The macOS 27.0.1
CI image produced stable per-launch differences on partially transparent toolbar
edges despite unchanged measured layout/styles/animations. Those CI references
were rejected and are not committed. No rendering experiments or temporary CI
capture/probe behavior remain.

Comparisons use a 0.01 per-pixel perceptual color threshold and allow zero pixels
above it. This accounts for measured local 1–3/255 channel rounding on a few
opaque disclosure edges; it is not an allowed-pixel budget or mask. Missing
baselines fail; comparisons never create or update expected images.

`provenance.json` records original source, fixture, configuration and packaged
renderer hashes; `png-sha256.json` records every original PNG's SHA-256.
`comparison-policy.json` records the current comparison configuration separately
from the original capture configuration. Original PNGs and capture provenance
remain unchanged. Every visual preflight rebuilds with Forge's renderer
configuration and verifies every packaged non-map renderer byte matches the
current checkout, rejecting stale `out/` builds. Per-run environment files are
saved before dimension/pixel assertions, including display/work area, native
content/window bounds, viewport/DPR, fonts, locale/timezone and runtime identity.

Run comparisons after building the intended checkout:

```sh
npm ci
npm run build
npm run test:electron
npx playwright test --config playwright.visual.config.ts
npx playwright test --config playwright.visual.config.ts
```

Use Node 24 and the installed Xcode developer directory. A host whose global
developer directory points at command line tools can pass `DEVELOPER_DIR` for
these commands without changing system settings. Writable temporary Swift module
caches can be supplied with `CLANG_MODULE_CACHE_PATH`. Native desktop tests need
an available, authorized GUI session. Do not bypass existing full-screen/focus
checks when the desktop prevents them.

Initial capture only, with the original application source:

```sh
npm run build
npx playwright test --config playwright.visual.config.ts --update-snapshots
npx playwright test --config playwright.visual.config.ts
npx playwright test --config playwright.visual.config.ts
```

Explicit snapshot updates reject tracked or untracked application-source changes
from the original baseline. Never regenerate baselines from extracted code. The retained local
originals are the visual references for this refactor; ordinary CI acceptance
does not claim pixel portability to another platform.

The matrix covers actual packaged Electron full-window and native tray popover
renderer surfaces, two native content widths, light/dark, and normal/reduced
motion. Full-window cases cover All, Apps, Homebrew, Installed, Ignored, General,
Profile, Appearance and Diagnostics. Both surfaces cover failure details, report
preview, search, a floating row menu, and install/uninstall confirmations. The
compact route always shows the combined updates view; it does not offer separate
sidebar tabs. Fixtures use generic data, fixed timestamps/clock, en-US/UTC, local
fallback icons and the production system font stack, with font/image readiness.
No content masks, font substitutions or injected application CSS are used.

Screenshots compare viewport pixels, including clipping and overflow; they do
not include macOS window chrome, the status-bar tray icon or native OS dialogs.
They render the production React tree through the real preload bridge; test-only
main-process IPC handlers supply deterministic data and reject unexpected
operation intents. Existing smoke tests retain native focus, full-screen and
behavior coverage. Visual assertions disable finite CSS animations and hide the
caret for settled frames; they do not measure animation timing. Progress states,
very long labels, linked app-backed casks and self-update availability are outside
this initial fixture's coverage.

An existing compact-search behavior is deliberately untouched: clicking a row's
Actions button dismisses search and removes that menu. Tray menu/uninstall
captures use a normal outdated cask row instead.
