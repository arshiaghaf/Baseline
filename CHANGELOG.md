# Changelog

## 0.4.0 — 2026-06-22

### Added

- Search now opens as a command-palette overlay in the main window, with keyboard shortcuts, focus restoration, and compact action results across apps, Homebrew, Discover, installed, and ignored items. ([#147](https://github.com/arshiaghaf/Baseline/pull/147))

### Fixed

- Sparkle appcast checks now block IPv6 hosts that hide loopback or private IPv4 addresses while still allowing public IPv6 feeds. ([#151](https://github.com/arshiaghaf/Baseline/pull/151))
- Available App Store and Sparkle updates no longer disappear during temporary lookup failures when the installed app has not changed. ([#152](https://github.com/arshiaghaf/Baseline/pull/152))
- Mac-capable UIKit App Store apps now stay on the Mac App Store update path, including mixed iPad/Mac metadata. ([#153](https://github.com/arshiaghaf/Baseline/pull/153))
- Development tooling now uses the patched `tar` version for GHSA-vmf3-w455-68vh / CVE-2026-53655. ([#154](https://github.com/arshiaghaf/Baseline/pull/154))
- Homebrew cask updates now use greedy upgrades where needed, matching Baseline's outdated detection while leaving formula updates unchanged. ([#156](https://github.com/arshiaghaf/Baseline/pull/156))
- `Update Brews` can now queue eligible visible updates while Homebrew is already busy. ([#157](https://github.com/arshiaghaf/Baseline/pull/157))
- Apps in added or removed scan folders now refresh immediately so the visible app list stays in sync. ([#159](https://github.com/arshiaghaf/Baseline/pull/159))

## 0.3.1 — 2026-06-14

### Fixed

- Release artifacts now use version-derived build numbers for stable releases while preserving explicit rebuild overrides and development fallbacks. ([#143](https://github.com/arshiaghaf/Baseline/pull/143))

## 0.3.0 — 2026-06-13

### Added

- Settings now include a private local Profile stats tab with update and install totals, source mix, top apps/tools, signed local history, and Keychain integrity checks. ([#138](https://github.com/arshiaghaf/Baseline/pull/138))
- App, Homebrew, and Profile stats icon treatments now use more consistent depth, alignment, and source-specific styling. ([#141](https://github.com/arshiaghaf/Baseline/pull/141))

### Fixed

- Symlinked `.app` entries are now scanned when they resolve to directories, with canonical-path deduplication to avoid duplicate app rows. ([#128](https://github.com/arshiaghaf/Baseline/pull/128))
- Baseline now trims unused tool-status channels, stale setup state, and duplicated renderer action-state wiring while preserving existing row and card behavior. ([#142](https://github.com/arshiaghaf/Baseline/pull/142))
- Homebrew commands now run through a shared lock so installs, refreshes, updates, uninstalls, and tool checks do not overlap; app update clicks can queue while Homebrew is busy. ([#126](https://github.com/arshiaghaf/Baseline/pull/126))

## 0.2.0 — 2026-06-07

### Added

- Baseline now supports iOS and iPad App Store apps that run on Mac, using local App Store evidence and UIKit idiom metadata to choose the correct App Store lookup path. ([#121](https://github.com/arshiaghaf/Baseline/pull/121)), ([#122](https://github.com/arshiaghaf/Baseline/pull/122))
- Release automation now publishes changelog-derived release notes and can dispatch the Homebrew cask update workflow after the GitHub Release is available. ([#119](https://github.com/arshiaghaf/Baseline/pull/119)), ([#120](https://github.com/arshiaghaf/Baseline/pull/120))

### Fixed

- Overlapping refreshes no longer allow stale scan or lookup results to overwrite newer snapshot state. ([#111](https://github.com/arshiaghaf/Baseline/pull/111))
- Recently Updated entries now require real installed-version progress, including Sparkle build-version advances when the marketing version is unchanged. ([#109](https://github.com/arshiaghaf/Baseline/pull/109)), ([#114](https://github.com/arshiaghaf/Baseline/pull/114))
- Homebrew and `mas` controls now disable cleanly when their tools are unavailable, including inventory fetches, Discover installs, and the App Store update preference. ([#123](https://github.com/arshiaghaf/Baseline/pull/123)), ([#124](https://github.com/arshiaghaf/Baseline/pull/124)), ([#132](https://github.com/arshiaghaf/Baseline/pull/132))
- Homebrew-backed app actions now avoid unsafe fallback upgrades, keep hidden app-backed casks out of batch updates, and return failed Discover installs to a retryable state. ([#110](https://github.com/arshiaghaf/Baseline/pull/110)), ([#113](https://github.com/arshiaghaf/Baseline/pull/113)), ([#125](https://github.com/arshiaghaf/Baseline/pull/125))
- Sparkle-origin apps now require installed Homebrew cask ownership before using Homebrew fallback updates, while unowned cask rows remain visible. ([#131](https://github.com/arshiaghaf/Baseline/pull/131))
- Reused Electron windows no longer accumulate duplicate setup listeners, and main/settings navigation stays synced through the preload bridge. ([#112](https://github.com/arshiaghaf/Baseline/pull/112))
- Refresh interval edits now commit reliably after typing. ([#127](https://github.com/arshiaghaf/Baseline/pull/127))

## 0.1.0 — 2026-05-31

### Added

- Baseline now checks GitHub Releases for app updates and shows a main-window toolbar shortcut when a newer release is available. ([#115](https://github.com/arshiaghaf/Baseline/pull/115))
- Renderer card typography, action menu sizing, and Settings dividers were refined for a cleaner full-window interface. ([#95](https://github.com/arshiaghaf/Baseline/pull/95))
- Settings now use a dedicated in-app sidebar with General, Appearance, and Diagnostics sections, including grouped Update Tools, refresh, scan-directory, and version details. ([#87](https://github.com/arshiaghaf/Baseline/pull/87))
- Version and build metadata now flow through shared app metadata, macOS `CFBundleVersion`, Settings, About, diagnostics, release preparation, and Electron smoke coverage. ([#86](https://github.com/arshiaghaf/Baseline/pull/86))
- Release validation now runs broader macOS CI coverage, production audit checks, deterministic Electron smoke coverage, unsigned preview validation, and stricter changelog heading guards for release preparation. ([#78](https://github.com/arshiaghaf/Baseline/pull/78)), ([#81](https://github.com/arshiaghaf/Baseline/pull/81)), ([#74](https://github.com/arshiaghaf/Baseline/pull/74)), ([#76](https://github.com/arshiaghaf/Baseline/pull/76))
- README polish, static GPL badge handling, refreshed badge cache behavior, and regenerated app icon packaging assets keep the public project presentation and packaged macOS icon current. ([#85](https://github.com/arshiaghaf/Baseline/pull/85)), ([#80](https://github.com/arshiaghaf/Baseline/pull/80)), ([#77](https://github.com/arshiaghaf/Baseline/pull/77)), ([#79](https://github.com/arshiaghaf/Baseline/pull/79))
- Installed app and installed Homebrew search matches now render as cards while Discover results keep the existing row layout. ([#69](https://github.com/arshiaghaf/Baseline/pull/69))
- Packaged macOS identity and icon assets were updated, including the Baseline Icon Composer source project, generated `.icns` packaging, refreshed app icon artwork, and the `com.arshiaghaf.baseline` bundle identifier. ([#68](https://github.com/arshiaghaf/Baseline/pull/68)), ([#67](https://github.com/arshiaghaf/Baseline/pull/67)), ([#66](https://github.com/arshiaghaf/Baseline/pull/66))
- Appearance settings now support System Default, Light Mode, and Dark Mode through Electron `nativeTheme`. ([#65](https://github.com/arshiaghaf/Baseline/pull/65))
- README positioning, screenshots, status, install guidance, release-tooling notes, and first-release documentation now reflect the current OSS app state. ([#64](https://github.com/arshiaghaf/Baseline/pull/64)), ([#61](https://github.com/arshiaghaf/Baseline/pull/61)), ([#57](https://github.com/arshiaghaf/Baseline/pull/57))
- Settings now include a persisted toggle for showing or hiding the menu bar icon, with tray lifecycle behavior that destroys the compact popover while hidden. ([#58](https://github.com/arshiaghaf/Baseline/pull/58))
- Ignored macOS apps and ignored Homebrew items now appear together in an Ignored sidebar tab, and installed app/Homebrew sections use card layouts in the full window. ([#45](https://github.com/arshiaghaf/Baseline/pull/45))
- GPL-3.0-only licensing and copyright ownership are clearer across source, docs, SPDX headers, and the native macOS About panel. ([#56](https://github.com/arshiaghaf/Baseline/pull/56))
- Homebrew presentation metadata now distinguishes formulae, app casks, CLI casks, package casks, and generic casks without changing command semantics. ([#44](https://github.com/arshiaghaf/Baseline/pull/44))
- Minimal renderer scrollbar styling was added for light and dark themes. ([#41](https://github.com/arshiaghaf/Baseline/pull/41))
- Full-window update, Recently Updated, and Ignored surfaces were redesigned as responsive card grids while the compact menu bar view stays list-based. ([#39](https://github.com/arshiaghaf/Baseline/pull/39))
- The All sidebar tab now uses the `Server` icon. ([#38](https://github.com/arshiaghaf/Baseline/pull/38))
- GitHub issue auto-labeling now classifies core labels, UI/theme reports, and explicit existing label matches. ([#37](https://github.com/arshiaghaf/Baseline/pull/37))
- `fast-xml-parser` and the lockfile were updated to clear the production dependency audit finding for the transitive XML builder package. ([#36](https://github.com/arshiaghaf/Baseline/pull/36))
- Sidebar iconography, spacing, installed-section grouping, toolbar icon styling, and count badges were polished. ([#31](https://github.com/arshiaghaf/Baseline/pull/31))
- Baseline migrated from the legacy Swift/Tuist app to Electron, Vite, React, TypeScript, and Tailwind while preserving the macOS full window, compact menu bar tray window, and public update detection through App Store lookup, Sparkle/DevMate appcasts, and Homebrew metadata. ([#19](https://github.com/arshiaghaf/Baseline/pull/19))
- Public contributor/support documentation now reflects the Electron stack, and stale Xcode/Tuist generated artifact ignore rules were removed. ([#21](https://github.com/arshiaghaf/Baseline/pull/21))
- GitHub Actions CI, unsigned DMG release publishing infrastructure, CI/release documentation, and release preparation tooling were added. ([#18](https://github.com/arshiaghaf/Baseline/pull/18))
- Preview validation tooling now builds, tests, packages, installs, smoke-launches Baseline, and prepares unsigned release notes with checksums. ([#12](https://github.com/arshiaghaf/Baseline/pull/12))
- Settings now include a local diagnostics report for support and troubleshooting, including report counts, source summaries, and optional tool status. ([#10](https://github.com/arshiaghaf/Baseline/pull/10))
- README screenshots and feature placement were updated for Search, Apps, Homebrew, ignored items, optional `mas`/`brew` behavior, and fallback behavior when CLI tooling is unavailable. ([#8](https://github.com/arshiaghaf/Baseline/pull/8)), ([#9](https://github.com/arshiaghaf/Baseline/pull/9)), ([#13](https://github.com/arshiaghaf/Baseline/pull/13))
- The legacy Swift/Tuist source was removed from `main`; the previous implementation is archived at branch `legacy/swift` and tag `swift-final`. ([#19](https://github.com/arshiaghaf/Baseline/pull/19)), ([#21](https://github.com/arshiaghaf/Baseline/pull/21))

### Fixed

- Homebrew outdated and inventory JSON parsing now reads valid JSON from stdout even when Homebrew emits warnings on stderr after wake or concurrent package-manager activity. ([#88](https://github.com/arshiaghaf/Baseline/pull/88))
- Failed Homebrew update indicators now clear for retries and fall back to a retryable Update state after a short delay. ([#83](https://github.com/arshiaghaf/Baseline/pull/83))
- Batch Homebrew updates now target only non-ignored, valid outdated tokens instead of letting a broad `brew upgrade` affect ignored items. ([#92](https://github.com/arshiaghaf/Baseline/pull/92))
- App rows/cards that update through matched Homebrew casks now show cask progress, completion, and failure states, including a brief successful state before refresh moves the item to Recently Updated. ([#91](https://github.com/arshiaghaf/Baseline/pull/91))
- Sidebar update badges are hidden when their count is zero. ([#93](https://github.com/arshiaghaf/Baseline/pull/93))
- Bundle icon extraction now preserves app icons when `sips` produces grayscale-only PNG output from ICNS conversion. ([#82](https://github.com/arshiaghaf/Baseline/pull/82))
- Toolbar search now works consistently across Apps, Homebrew, Installed, Ignored, and Discovery; selecting a sidebar tab or Settings exits active search while preserving the query for next use. ([#70](https://github.com/arshiaghaf/Baseline/pull/70))
- Sidebar update badges keep the All, Apps, and Homebrew counts stable while search filtering is active. ([#60](https://github.com/arshiaghaf/Baseline/pull/60))
- Ignored item action menus stay fully saturated while ignored card and row content remains visually muted. ([#59](https://github.com/arshiaghaf/Baseline/pull/59))
- Homebrew cask/app linking now persists explicit app links, avoids CLI/binary target false matches, suppresses duplicate app-backed cask rows, and prunes stale recently updated records. ([#43](https://github.com/arshiaghaf/Baseline/pull/43))
- Homebrew recently updated retention tests now use an injected cutoff clock for deterministic results. ([#42](https://github.com/arshiaghaf/Baseline/pull/42))
- Sparkle appcast URL policy now rejects IPv4-mapped loopback/private hosts and unspecified hosts such as `0.0.0.0` and `::`. ([#35](https://github.com/arshiaghaf/Baseline/pull/35))
- Self-updated Homebrew cask state now reconciles installed casks with scanned app bundle versions only when cask metadata proves the app match. ([#32](https://github.com/arshiaghaf/Baseline/pull/32))
- Recently Updated now de-duplicates cask-backed app rows while preserving standalone Homebrew recent rows. ([#30](https://github.com/arshiaghaf/Baseline/pull/30))
- The compact menu bar dashboard no longer preselects Search on first tray open. ([#29](https://github.com/arshiaghaf/Baseline/pull/29))
- Toolbar search collapse now handles outside clicks, ignores inside-control clicks, preserves active search text until cleared, and lets adjacent toolbar actions fire. ([#27](https://github.com/arshiaghaf/Baseline/pull/27)), ([#28](https://github.com/arshiaghaf/Baseline/pull/28))
- Compact menu bar window positioning now aligns to the tray item, clamps to the display work area, and shows as a focused popover. ([#25](https://github.com/arshiaghaf/Baseline/pull/25))
- Successful Homebrew single-item retries and maintenance cycles now clear affected failure markers. ([#24](https://github.com/arshiaghaf/Baseline/pull/24))
- Electron migration review fixes now recursively scan configured app directories without descending into discovered `.app` bundles and add a typed tool status refresh IPC/preload API for Settings. ([#20](https://github.com/arshiaghaf/Baseline/pull/20))
- Homebrew placeholder icons now use explicit light/dark appearance, appearance-aware cache keys, and compact menu icon rendering that follows the SwiftUI color scheme. ([#17](https://github.com/arshiaghaf/Baseline/pull/17))
- Cached update results are preserved when lightweight refresh lookups fail transiently. ([#16](https://github.com/arshiaghaf/Baseline/pull/16))
