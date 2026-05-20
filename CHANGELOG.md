# Changelog

## 0.1.0 — Unreleased

### Added

- Installed app and installed Homebrew search matches now render as cards while Discover results keep the existing row layout. [#69](https://github.com/arshiaghaf/baseline/pull/69)
- Packaged macOS identity and icon assets were updated, including the Baseline Icon Composer source project, generated `.icns` packaging, refreshed app icon artwork, and the `com.arshiaghaf.baseline` bundle identifier. [#68](https://github.com/arshiaghaf/baseline/pull/68), [#67](https://github.com/arshiaghaf/baseline/pull/67), [#66](https://github.com/arshiaghaf/baseline/pull/66)
- Appearance settings now support System Default, Light Mode, and Dark Mode through Electron `nativeTheme`. [#65](https://github.com/arshiaghaf/baseline/pull/65)
- README positioning, screenshots, status, install guidance, release-tooling notes, and first-release documentation now reflect the current beta OSS app state. [#64](https://github.com/arshiaghaf/baseline/pull/64), [#61](https://github.com/arshiaghaf/baseline/pull/61), [#57](https://github.com/arshiaghaf/baseline/pull/57)
- Settings now include a persisted toggle for showing or hiding the menu bar icon, with tray lifecycle behavior that destroys the compact popover while hidden. [#58](https://github.com/arshiaghaf/baseline/pull/58)
- Ignored macOS apps and ignored Homebrew items now appear together in an Ignored sidebar tab, and installed app/Homebrew sections use card layouts in the full window. [#45](https://github.com/arshiaghaf/baseline/pull/45)
- GPL-3.0-only licensing and copyright ownership are clearer across source, docs, SPDX headers, and the native macOS About panel. [#56](https://github.com/arshiaghaf/baseline/pull/56)
- Dependabot configuration and dependency maintenance now cover GitHub Actions updates, app/tooling package groups, Electron 42.1.0, Tailwind CSS 4.3.0, `fast-uri`, and npm overrides for reported `tar`, `tmp`, and `@tootallnate/once` alerts. [#46](https://github.com/arshiaghaf/baseline/pull/46), [#47](https://github.com/arshiaghaf/baseline/pull/47), [#48](https://github.com/arshiaghaf/baseline/pull/48), [#49](https://github.com/arshiaghaf/baseline/pull/49), [#50](https://github.com/arshiaghaf/baseline/pull/50), [#51](https://github.com/arshiaghaf/baseline/pull/51), [#52](https://github.com/arshiaghaf/baseline/pull/52), [#53](https://github.com/arshiaghaf/baseline/pull/53), [#54](https://github.com/arshiaghaf/baseline/pull/54), [#55](https://github.com/arshiaghaf/baseline/pull/55)
- Homebrew presentation metadata now distinguishes formulae, app casks, CLI casks, package casks, and generic casks without changing command semantics. [#44](https://github.com/arshiaghaf/baseline/pull/44)
- Minimal renderer scrollbar styling was added for light and dark themes. [#41](https://github.com/arshiaghaf/baseline/pull/41)
- Full-window update, Recently Updated, and Ignored surfaces were redesigned as responsive card grids while the compact menu bar view stays list-based. [#39](https://github.com/arshiaghaf/baseline/pull/39)
- The update store was formatted with Prettier. [#40](https://github.com/arshiaghaf/baseline/pull/40)
- The All sidebar tab now uses the `Server` icon. [#38](https://github.com/arshiaghaf/baseline/pull/38)
- GitHub issue auto-labeling now classifies core labels, UI/theme reports, and explicit existing label matches. [#37](https://github.com/arshiaghaf/baseline/pull/37)
- `fast-xml-parser` and the lockfile were updated to clear the production dependency audit finding for the transitive XML builder package. [#36](https://github.com/arshiaghaf/baseline/pull/36)
- Sidebar iconography, spacing, installed-section grouping, toolbar icon styling, and count badges were polished. [#31](https://github.com/arshiaghaf/baseline/pull/31)
- Baseline migrated from the legacy Swift/Tuist app to Electron, Vite, React, TypeScript, and Tailwind while preserving the macOS full window, compact menu bar tray window, and public update detection through App Store lookup, Sparkle/DevMate appcasts, and Homebrew metadata. [#19](https://github.com/arshiaghaf/baseline/pull/19)
- Public contributor/support documentation now reflects the Electron stack, and stale Xcode/Tuist generated artifact ignore rules were removed. [#21](https://github.com/arshiaghaf/baseline/pull/21)
- GitHub Actions CI, unsigned DMG release publishing infrastructure, CI/release documentation, and release preparation tooling were added. [#18](https://github.com/arshiaghaf/baseline/pull/18)
- Preview validation tooling now builds, tests, packages, installs, smoke-launches Baseline, and prepares unsigned release notes with checksums. [#12](https://github.com/arshiaghaf/baseline/pull/12)
- Settings now include a local diagnostics report for support and troubleshooting, including report counts, source summaries, and optional tool status. [#10](https://github.com/arshiaghaf/baseline/pull/10)
- README screenshots and feature placement were updated for Search, Apps, Homebrew, ignored items, optional `mas`/`brew` behavior, and fallback behavior when CLI tooling is unavailable. [#8](https://github.com/arshiaghaf/baseline/pull/8), [#9](https://github.com/arshiaghaf/baseline/pull/9), [#13](https://github.com/arshiaghaf/baseline/pull/13)
- The legacy Swift/Tuist source was removed from `main`; the previous implementation is archived at branch `legacy/swift` and tag `swift-final`. [#19](https://github.com/arshiaghaf/baseline/pull/19), [#21](https://github.com/arshiaghaf/baseline/pull/21)

### Fixed

- Toolbar search now works consistently across Apps, Homebrew, Installed, Ignored, and Discovery; selecting a sidebar tab or Settings exits active search while preserving the query for next use. [#70](https://github.com/arshiaghaf/baseline/pull/70)
- Sidebar update badges keep the All, Apps, and Homebrew counts stable while search filtering is active. [#60](https://github.com/arshiaghaf/baseline/pull/60)
- Ignored item action menus stay fully saturated while ignored card and row content remains visually muted. [#59](https://github.com/arshiaghaf/baseline/pull/59)
- Homebrew cask/app linking now persists explicit app links, avoids CLI/binary target false matches, suppresses duplicate app-backed cask rows, and prunes stale recently updated records. [#43](https://github.com/arshiaghaf/baseline/pull/43)
- Homebrew recently updated retention tests now use an injected cutoff clock for deterministic results. [#42](https://github.com/arshiaghaf/baseline/pull/42)
- Sparkle appcast URL policy now rejects IPv4-mapped loopback/private hosts and unspecified hosts such as `0.0.0.0` and `::`. [#35](https://github.com/arshiaghaf/baseline/pull/35)
- Self-updated Homebrew cask state now reconciles installed casks with scanned app bundle versions only when cask metadata proves the app match. [#32](https://github.com/arshiaghaf/baseline/pull/32)
- Recently Updated now de-duplicates cask-backed app rows while preserving standalone Homebrew recent rows. [#30](https://github.com/arshiaghaf/baseline/pull/30)
- The compact menu bar dashboard no longer preselects Search on first tray open. [#29](https://github.com/arshiaghaf/baseline/pull/29)
- Toolbar search collapse now handles outside clicks, ignores inside-control clicks, preserves active search text until cleared, and lets adjacent toolbar actions fire. [#27](https://github.com/arshiaghaf/baseline/pull/27), [#28](https://github.com/arshiaghaf/baseline/pull/28)
- Compact menu bar window positioning now aligns to the tray item, clamps to the display work area, and shows as a focused popover. [#25](https://github.com/arshiaghaf/baseline/pull/25)
- Successful Homebrew single-item retries and maintenance cycles now clear affected failure markers. [#24](https://github.com/arshiaghaf/baseline/pull/24)
- Electron migration review fixes now recursively scan configured app directories without descending into discovered `.app` bundles and add a typed tool-readiness refresh IPC/preload API for Settings. [#20](https://github.com/arshiaghaf/baseline/pull/20)
- Homebrew placeholder icons now use explicit light/dark appearance, appearance-aware cache keys, and compact menu icon rendering that follows the SwiftUI color scheme. [#17](https://github.com/arshiaghaf/baseline/pull/17)
- Cached update results are preserved when lightweight refresh lookups fail transiently. [#16](https://github.com/arshiaghaf/baseline/pull/16)
