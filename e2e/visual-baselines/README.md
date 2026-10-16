# Electron renderer visual baselines

The source baseline is `a3292e0b3a5b0735b681eb5f9568023ecbcb9ac2`.
Application source is unchanged in the baseline PR. Keep its committed PNGs
unchanged throughout the renderer extraction stack.

The authoritative comparison lane is `xcode-27` (macOS 27, Apple Silicon), selected
with `BASELINE_VISUAL_LANE=xcode-27`. It has its own named snapshot directory;
the original local captures remain in `macos-27-arm64-software-srgb`.
Visual launches use `--disable-gpu --force-color-profile=srgb` to make rasterization
deterministic; default-GPU Electron smoke coverage remains unchanged. This lane
does not establish production GPU/backdrop rendering equivalence.
Comparisons use a 0.01 per-pixel perceptual color threshold and allow zero pixels
above it. This accounts for observed 1–3/255 channel rounding on a few disclosure
edges in unchanged-source repeats; it is not an allowed-pixel budget or mask.
The original local captures use macOS 27.2. The macOS 27.0.1 CI image did not
match them: its desktop constrained main-window heights and tray pixels differed.
CI therefore needs separately captured original-source images and unchanged
repeat comparisons before this baseline unlocks source moves. Other CI runners keep
their existing Electron smoke coverage. Missing baselines fail; comparison never
creates or updates expected images. OS, architecture, viewport, native content
bounds, device scale factor, locale, timezone, fonts and Electron/Chromium runtime
are recorded alongside the snapshots. `provenance.json` records source, fixture,
configuration and packaged-renderer hashes. Every visual preflight rebuilds with
Forge's renderer configuration and verifies the packaged renderer matches it,
rejecting stale `out/` builds.
Environment is attached before dimension and pixel assertions, including display
work areas/scale factors, requested and actual native content/window bounds, and
renderer DPR. The CI lane requests fixed main content viewports of 660×640 and
1280×640, versus the retained local 660×760 and 1280×900. Both lanes retain tray
360×560 and 440×640. CI content origin is primary work-area x and work-area y+32;
the exact content bounds and viewport are asserted, with no adaptive sizing.
The shorter CI main viewport intentionally covers clipping/overflow on that
desktop; it does not replace the taller local coverage.
`png-sha256.json` records every retained original PNG's SHA-256.
`comparison-policy.json` records the final comparison threshold/configuration
separately from the original capture configuration; the PNGs were not regenerated
when the color-rounding policy was established.

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
from the original baseline. Never regenerate baselines from extracted code. A CI
image that renders differently needs original-source capture and repeat evidence
on that image before moving source, not an increased pixel tolerance.

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
