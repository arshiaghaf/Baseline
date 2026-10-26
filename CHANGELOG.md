# Changelog

## 0.10.0 — 2026-10-25

### Highlights

- **Apple Silicon is now required.** This release supports M1 or later Macs running macOS 15 or later; Intel builds are discontinued, while existing installations and historical downloads remain intact. ([#348](https://github.com/arshiaghaf/Baseline/pull/348))
- **Navigate menus and controls with the keyboard.** Menu-bar controls and Search action menus retain usable focus as results move, disappear, or become unavailable. ([#361](https://github.com/arshiaghaf/Baseline/pull/361))
- **Find Baseline by its new icon.** The redesigned app icon includes light, dark, and tinted appearances on supported macOS versions, with a matching fallback for macOS 15. ([#353](https://github.com/arshiaghaf/Baseline/pull/353))
- **See more of your desktop through Baseline.** Main-window, setup-guide, and menu-bar backgrounds use refined transparency in light and dark appearances. ([#349](https://github.com/arshiaghaf/Baseline/pull/349)), ([#350](https://github.com/arshiaghaf/Baseline/pull/350))
- **Read cached check times in your local time.** Homebrew catalogue warnings use your device's timezone and date format. ([#362](https://github.com/arshiaghaf/Baseline/pull/362))

### Added

- Maintainer documentation makes native Finder appearance review optional while retaining automated DMG integrity, read-only mount, Applications-link, metadata, artwork, and bundled-signature checks. ([#344](https://github.com/arshiaghaf/Baseline/pull/344))
- Typed linting rejects floating and misused promises across source and test TypeScript, retaining deliberate fire-and-forget calls with internal error handling. ([#346](https://github.com/arshiaghaf/Baseline/pull/346))
- Standalone no-emit type checks use pinned tsrs 0.18.0-ts7.1.0-dev.20260929 with the existing tsconfig. TypeScript 6 remains for typed ESLint and compiler consumers; unsupported hosts fail clearly, and checker errors never trigger fallback. ([#347](https://github.com/arshiaghaf/Baseline/pull/347)), ([#348](https://github.com/arshiaghaf/Baseline/pull/348))
- Application packages, native helpers, and disk images target Apple Silicon only, with arm64 app, framework, and helper checks across the three supported macOS CI runners. README and release requirements state Apple Silicon and macOS 15 or later; historical assets and user data remain untouched. ([#348](https://github.com/arshiaghaf/Baseline/pull/348))
- Main-window and App Management guide tints share 15% opacity in light appearance and 20% in dark appearance, preserving native vibrancy, colors, layout, and settings. ([#349](https://github.com/arshiaghaf/Baseline/pull/349)), ([#350](https://github.com/arshiaghaf/Baseline/pull/350))
- Menu-bar popup tints use 5% opacity in light appearance and 15% in dark appearance without changing popup layout or native materials. ([#349](https://github.com/arshiaghaf/Baseline/pull/349)), ([#350](https://github.com/arshiaghaf/Baseline/pull/350))
- Electron test failure reports preserve body and cleanup errors together, with bounded, fixture-secret-redacted process, window, quit-event, and shutdown-phase diagnostics retained in separate focused and full-suite CI logs. ([#351](https://github.com/arshiaghaf/Baseline/pull/351))
- The composed application icon ships native light, dark, and tinted catalog entries on macOS 26 or later, synchronized 16–1024-pixel ICNS fallbacks for macOS 15, matching DMG artwork, package checks, and regeneration documentation. ([#353](https://github.com/arshiaghaf/Baseline/pull/353))
- Row action menus support initial focus, arrow keys, Home/End, Escape, and focus return. Floating Search menus participate in the owning row's logical Tab and Shift+Tab order, dismissing when focus leaves their trigger/menu scope. ([#361](https://github.com/arshiaghaf/Baseline/pull/361))

### Fixed

- Native Electron test files run with one worker to avoid competing for desktop focus, preserving real visibility assertions, timeouts, retries, and unit-test parallelism. ([#345](https://github.com/arshiaghaf/Baseline/pull/345))
- Clipboard IPC calls await write completion and propagate rejection. ([#346](https://github.com/arshiaghaf/Baseline/pull/346))
- Command completion retains cleanup ordering and propagates unexpected close-listener rejection. ([#346](https://github.com/arshiaghaf/Baseline/pull/346))
- Self-update checks on unsupported architectures return an unavailable result and installation guidance instead of offering future releases. Already-shipped clients cannot receive this guard; no last-compatible Intel release is claimed. ([#348](https://github.com/arshiaghaf/Baseline/pull/348))
- Electron test cleanup explicitly requests quit and preserves unexpected invocation errors, requiring confirmed child exit after shutdown disconnections. Diagnostic listeners avoid unavailable BrowserWindow methods and tolerate closed stderr without interrupting quit; the five-second deadline and exit assertions remain intact. ([#351](https://github.com/arshiaghaf/Baseline/pull/351)), ([#352](https://github.com/arshiaghaf/Baseline/pull/352))
- Compact toolbar and row actions restore keyboard tab stops while pointer activation clears stale button focus and keeps menu targets mounted through click dispatch. ([#361](https://github.com/arshiaghaf/Baseline/pull/361))
- Keyboard focus recovers to a stable control in the active Search or dashboard after rows move, disappear, or become disabled, waiting for modal cleanup and preserving focus deliberately moved elsewhere. ([#361](https://github.com/arshiaghaf/Baseline/pull/361))
- The formula-rename history test fixture stays recent relative to execution so its retention assertions do not expire with the calendar; production history policy is unchanged. ([#361](https://github.com/arshiaghaf/Baseline/pull/361))
- Cached Homebrew catalogue warnings format dates in the device's local timezone and locale, select the oldest valid stale check, and omit missing or invalid timestamps while preserving unavailable-catalogue fallback and warning wording. ([#362](https://github.com/arshiaghaf/Baseline/pull/362))

## 0.9.0 — 2026-10-21

### Highlights

- **Get help setting up app updates.** A dismissible `App Management` guide explains when macOS approval is needed and helps you add Baseline in System Settings. ([#341](https://github.com/arshiaghaf/Baseline/pull/341))
- **Read and navigate more comfortably.** Dashboard cards adapt to available space, with larger text and centered content in the main window and `Settings`. ([#334](https://github.com/arshiaghaf/Baseline/pull/334)), ([#335](https://github.com/arshiaghaf/Baseline/pull/335))
- **Keep search results visible while installing.** Homebrew searches stay open so you can follow progress and see whether an installation succeeded or failed. ([#343](https://github.com/arshiaghaf/Baseline/pull/343))
- **Know what an update button will do.** Buttons distinguish downloading an installer, visiting a website, opening a link, and opening the installed app. ([#342](https://github.com/arshiaghaf/Baseline/pull/342))
- **Install Baseline with clearer guidance.** The disk image has a redesigned drag-to-Applications layout with larger targets and Retina artwork. ([#340](https://github.com/arshiaghaf/Baseline/pull/340))

### Added

- The menu bar context menu offers `Open Baseline` to open or focus the main window, groups related commands, and keeps navigation available during refresh; Settings and README describe the action. ([#333](https://github.com/arshiaghaf/Baseline/pull/333))
- Dashboard cards use available content width to switch between one, two, and three columns, including Ignored, while compact Search stays in one column. ([#334](https://github.com/arshiaghaf/Baseline/pull/334))
- Dashboard and Settings content are centered within an 860 CSS px cap, with larger app names, versions, navigation, headings, source labels, and warning text; long truncated names remain available in tooltips. ([#335](https://github.com/arshiaghaf/Baseline/pull/335))
- Dashboard and Settings workspaces sit in an inset floating panel with rounded corners beside the translucent sidebar. ([#336](https://github.com/arshiaghaf/Baseline/pull/336))
- Forge and unsigned release disk images share a 660 × 440-point drag-to-Applications layout, 112-point targets, concise instructions, and 1×/2× artwork, with documented artwork regeneration. Existing filenames, volume titles, compression, and ad-hoc app signing are preserved. ([#340](https://github.com/arshiaghaf/Baseline/pull/340))
- Packaging CI checks disk images through read-only mounts, verifies the Applications link and bundled signatures across the macOS matrix. ([#340](https://github.com/arshiaghaf/Baseline/pull/340))
- A dismissible first-use `App Management` guide follows the app theme in a movable, content-fitted panel, opens System Settings only on request, and preserves the caller's view when dismissed. ([#341](https://github.com/arshiaghaf/Baseline/pull/341))
- The guide's entire app card can drag the verified running packaged bundle into System Settings, including separately named previews, with manual navigation and app-picker alternatives. Navigation and dragging never imply permission was granted. ([#341](https://github.com/arshiaghaf/Baseline/pull/341))
- Settings and public documentation explain conditional App Management approval separately from administrator authorization and App Store sign-in, including optional `mas` limitations and permissions unnecessary for ordinary checks. ([#341](https://github.com/arshiaghaf/Baseline/pull/341))

### Fixed

- Generated release notes preserve Highlights alongside Added and Fixed, including Markdown links and subsection order, while retaining support for older entries. ([#332](https://github.com/arshiaghaf/Baseline/pull/332))
- Confirmation dialogs retain keyboard focus, support Escape, restore Search focus on cancellation, and keep compact Search open behind the dialog. ([#334](https://github.com/arshiaghaf/Baseline/pull/334))
- Update-failure notices wrap long unbroken app names instead of overflowing narrow views. ([#334](https://github.com/arshiaghaf/Baseline/pull/334))
- Refresh and failure notices and Settings headings align with scrollable content even when scrollbars reserve width; compact tray layout and Profile tooltips remain usable. ([#334](https://github.com/arshiaghaf/Baseline/pull/334)), ([#335](https://github.com/arshiaghaf/Baseline/pull/335))
- Electron is updated from 44.7.2 to 44.9.2 to ship the updated security runtime on the existing major line. ([#337](https://github.com/arshiaghaf/Baseline/pull/337))
- External update buttons reflect provider-declared download intent, including extensionless and redirect URLs, instead of claiming to open an app-specific updater. Legacy or unknown HTTPS targets use `Open link` until refreshed metadata proves download intent; explicit web actions use `Visit website`, and missing or unsafe routes use `Open app`. HTTPS validation, source precedence, persistence compatibility, and app fallback remain intact. ([#342](https://github.com/arshiaghaf/Baseline/pull/342))
- Unsigned disk-image creation maps Intel's `x86_64` architecture to Forge's `x64` output directory. ([#340](https://github.com/arshiaghaf/Baseline/pull/340))
- Homebrew search results remain visible through installation progress, completion, and failure in the main window and menu bar. Clicks inside nonempty menu-bar results keep Search open; empty queries, explicit closure, and uninstall dismissal retain their existing behavior. ([#343](https://github.com/arshiaghaf/Baseline/pull/343))

## 0.8.0 — 2026-10-18

### Highlights

- **Update password-protected apps without Terminal.** Apps updated through Homebrew that need your Mac password can now update directly in Baseline. ([#309](https://github.com/arshiaghaf/Baseline/pull/309))
- **See available updates sooner.** App results can appear while other refresh checks are still running. ([#328](https://github.com/arshiaghaf/Baseline/pull/328))
- **Review support details before sharing.** A preview shows the failure details before you open a GitHub issue. ([#287](https://github.com/arshiaghaf/Baseline/pull/287))
- **Keep longer-term activity totals.** `Profile` totals and rankings remain available beyond the latest 1,000 detailed events. ([#320](https://github.com/arshiaghaf/Baseline/pull/320))
- **Understand incomplete update checks.** The menu bar and update panels distinguish failed or unfinished checks from a completed healthy refresh. ([#329](https://github.com/arshiaghaf/Baseline/pull/329)), ([#330](https://github.com/arshiaghaf/Baseline/pull/330))

### Added

- Read-only, on-demand Homebrew diagnostics report safe configuration, Doctor categories, and service counts without exposing raw transcripts. ([#281](https://github.com/arshiaghaf/Baseline/pull/281)), ([#285](https://github.com/arshiaghaf/Baseline/pull/285))
- Verified installed-package context exposes observed install intent and dependency counts without granting removal authority. ([#282](https://github.com/arshiaghaf/Baseline/pull/282)), ([#285](https://github.com/arshiaghaf/Baseline/pull/285))
- Failed operations offer a selectable, copyable, bounded and redacted output tail. ([#287](https://github.com/arshiaghaf/Baseline/pull/287))
- An explicit issue preview shows exactly which support details will be opened on GitHub. ([#287](https://github.com/arshiaghaf/Baseline/pull/287))
- Contributor visual comparisons cover full-window and tray layouts against retained original screenshots. ([#288](https://github.com/arshiaghaf/Baseline/pull/288))
- Contributor bridge tests protect call-time forwarding, arguments, subscriptions, and errors. ([#301](https://github.com/arshiaghaf/Baseline/pull/301))
- Validated cask installs, updates, and removals can request the Mac administrator password through Baseline's app-provided masked native dialog, with answers sent directly to sudo. ([#304](https://github.com/arshiaghaf/Baseline/pull/304)), ([#308](https://github.com/arshiaghaf/Baseline/pull/308)), ([#309](https://github.com/arshiaghaf/Baseline/pull/309))
- Affected rows show `Waiting for admin password`, pause progress, and can return focus to the correlated prompt. ([#309](https://github.com/arshiaghaf/Baseline/pull/309))
- `Search sources again` in `Refresh options` explicitly refreshes alternative update-source discovery. ([#313](https://github.com/arshiaghaf/Baseline/pull/313)), ([#330](https://github.com/arshiaghaf/Baseline/pull/330))
- A compact toolbar control opens source-check coverage, affected-app details, last successful checks, and retry guidance. ([#330](https://github.com/arshiaghaf/Baseline/pull/330))
- Apps serviced by the operating system show `Managed by macOS` and stay outside ordinary update checks and Homebrew app associations. ([#331](https://github.com/arshiaghaf/Baseline/pull/331))

### Fixed

- Command output handles split UTF-8, carriage-return progress, and final unterminated lines correctly. ([#284](https://github.com/arshiaghaf/Baseline/pull/284))
- Bounded command capture and read deadlines prevent oversized or stuck responses from becoming accepted partial metadata. ([#284](https://github.com/arshiaghaf/Baseline/pull/284))
- Unconfirmed command-process cleanup blocks further Homebrew work and revokes stale targets instead of risking overlapping operations. ([#284](https://github.com/arshiaghaf/Baseline/pull/284))
- Validated Homebrew catalogue caches persist across launches while honoring expiry, explicit refreshes, and upstream caching rules. ([#283](https://github.com/arshiaghaf/Baseline/pull/283))
- Discovery ranks formula and cask relevance together so exact matches are not hidden by weaker results. ([#283](https://github.com/arshiaghaf/Baseline/pull/283))
- Oversized or malformed Homebrew catalogue entries are bounded without discarding healthy entries. ([#283](https://github.com/arshiaghaf/Baseline/pull/283))
- Installed Homebrew inventory avoids a redundant metadata subprocess while retaining independent per-kind recovery. ([#282](https://github.com/arshiaghaf/Baseline/pull/282))
- Failed and interrupted installations reconcile actual inventory while retaining original failure and save-error information. ([#285](https://github.com/arshiaghaf/Baseline/pull/285))
- Installation documentation explains macOS first launch and accurately distinguishes ad-hoc signing from Developer ID signing and notarization. ([#286](https://github.com/arshiaghaf/Baseline/pull/286))
- CI and release builds initialize Electron before parallel tests to prevent competing binary extractions. ([#304](https://github.com/arshiaghaf/Baseline/pull/304))
- Cancelled cask operations reconcile inventory quietly and preserve confirmed partial completions. ([#305](https://github.com/arshiaghaf/Baseline/pull/305)), ([#309](https://github.com/arshiaghaf/Baseline/pull/309))
- Conflicting Homebrew configuration is distinguished from a missing installation, blocks unsafe commands, and requires reconciled inventory before recovery. ([#306](https://github.com/arshiaghaf/Baseline/pull/306)), ([#309](https://github.com/arshiaghaf/Baseline/pull/309))
- Valid linked brew.env files and launcher-ignored records no longer block supported Homebrew configuration. ([#310](https://github.com/arshiaghaf/Baseline/pull/310))
- Blocked configuration offers a redacted reason and a working `Check for updates` recovery action. ([#310](https://github.com/arshiaghaf/Baseline/pull/310))
- Platform-aware App Store lookups confirm omitted grouped results and preserve valid identities without product IDs. ([#313](https://github.com/arshiaghaf/Baseline/pull/313))
- Known update sources retain independent discovery evidence, avoiding repeated broad searches without suppressing fresh unresolved-app checks. ([#313](https://github.com/arshiaghaf/Baseline/pull/313))
- Raw Homebrew command output no longer crosses into the renderer or fallback uninstall notices. ([#318](https://github.com/arshiaghaf/Baseline/pull/318))
- Unowned Homebrew siblings no longer hide eligible installed-cask updates. ([#317](https://github.com/arshiaghaf/Baseline/pull/317))
- Sparkle releases lacking a safe download or release-notes route no longer hide eligible releases. ([#317](https://github.com/arshiaghaf/Baseline/pull/317))
- Profile totals and rankings survive the latest 1,000 detailed events; older retained history is honestly labeled as a known minimum. ([#320](https://github.com/arshiaghaf/Baseline/pull/320))
- Clock changes no longer distort request pacing, metadata expiry, or Retry-After delays. ([#322](https://github.com/arshiaghaf/Baseline/pull/322))
- Completed updates reconcile inventory even when saving local history fails, without retrying package mutations. ([#319](https://github.com/arshiaghaf/Baseline/pull/319))
- A confirmed missing mas helper uses the safe fallback while inconclusive probes and genuine command failures remain visible. ([#319](https://github.com/arshiaghaf/Baseline/pull/319))
- Quit drains accepted state changes and saves durably; failed saves restore normal admission and required refresh strength. ([#321](https://github.com/arshiaghaf/Baseline/pull/321))
- Unchanged snapshots no longer trigger redundant cloning and broadcasts while preserving progress and persistence ordering. ([#323](https://github.com/arshiaghaf/Baseline/pull/323))
- All backend IPC requests authenticate trusted sender frames and validate arguments before actions or preference writes. ([#324](https://github.com/arshiaghaf/Baseline/pull/324))
- Proven app aliases preserve saved identity and Ignore state across overlapping folders and recovery. ([#326](https://github.com/arshiaghaf/Baseline/pull/326))
- Slow scan and metadata reads have time limits, and obsolete read work cancels promptly. ([#326](https://github.com/arshiaghaf/Baseline/pull/326))
- Timed-out icons no longer discard readable app records or stop later apps from scanning. ([#326](https://github.com/arshiaghaf/Baseline/pull/326))
- Slow Keychain reads stop waiting without authorizing a replacement history-signing secret. ([#326](https://github.com/arshiaghaf/Baseline/pull/326))
- Unavailable or damaged history cannot regain authentication through new activity, normalization, or legacy fallback. ([#320](https://github.com/arshiaghaf/Baseline/pull/320)), ([#325](https://github.com/arshiaghaf/Baseline/pull/325))
- Damaged snapshot fields no longer discard healthy settings, ignored items, scan directories, or package continuity. ([#325](https://github.com/arshiaghaf/Baseline/pull/325))
- Malformed cached remote versions cannot expose update actions. ([#325](https://github.com/arshiaghaf/Baseline/pull/325))
- Apps sharing a Sparkle feed reuse its download and XML decode within a refresh while retaining per-app eligibility and freshness. ([#327](https://github.com/arshiaghaf/Baseline/pull/327))
- Recently Updated comparison evidence survives streamed results, supersession, failed refreshes, preference saves, and relaunches. ([#322](https://github.com/arshiaghaf/Baseline/pull/322)), ([#328](https://github.com/arshiaghaf/Baseline/pull/328))
- Ready app update results appear while unrelated formula metadata and self-update checks continue. ([#328](https://github.com/arshiaghaf/Baseline/pull/328))
- The tray checkmark requires a completed healthy refresh and remains withheld after failed or unresolved checks. ([#329](https://github.com/arshiaghaf/Baseline/pull/329))
- Homebrew empty states distinguish incomplete checks, hidden app updates, ignored items, and pinned packages instead of falsely claiming everything is current. ([#329](https://github.com/arshiaghaf/Baseline/pull/329))
- The recorded-history caveat uses the accessible Stats information control and no longer disrupts Profile metric spacing. ([#330](https://github.com/arshiaghaf/Baseline/pull/330))
- Unavailable scan entries retain known apps without preserving unrelated deleted siblings. ([#326](https://github.com/arshiaghaf/Baseline/pull/326)), ([#331](https://github.com/arshiaghaf/Baseline/pull/331))

## 0.7.1 — 2026-10-16

### Highlights

- **Retry failed tool checks.** Homebrew and App Store helper checks finish after failures, preserve successful results, and allow another attempt. ([#275](https://github.com/arshiaghaf/Baseline/pull/275))
- **Avoid duplicate Homebrew checks.** Overlapping refreshes share package reads instead of starting the same work twice. ([#274](https://github.com/arshiaghaf/Baseline/pull/274))
- **Keep queued Homebrew work moving.** A failed lock notification no longer leaves pending operations stuck. ([#274](https://github.com/arshiaghaf/Baseline/pull/274))
- **Quit without delayed status changes.** Accepted shutdown cancels pending failure and progress updates. ([#276](https://github.com/arshiaghaf/Baseline/pull/276))

### Added

- Contributor regression tests now cover profile-history integrity, duplicate events, and recovery from failed saves. ([#269](https://github.com/arshiaghaf/Baseline/pull/269))
- Contributor regression tests now protect Homebrew reservation ownership and release ordering. ([#270](https://github.com/arshiaghaf/Baseline/pull/270))
- Contributor regression tests now cover queued Homebrew identity checks and update progress ordering. ([#271](https://github.com/arshiaghaf/Baseline/pull/271))
- Contributor regression tests now cover superseded refreshes and recovery from failed update lookups. ([#268](https://github.com/arshiaghaf/Baseline/pull/268)), ([#273](https://github.com/arshiaghaf/Baseline/pull/273))

### Fixed

- Contributor Homebrew maintenance tests now handle delayed saves without timing out or leaving unfinished work. ([#265](https://github.com/arshiaghaf/Baseline/pull/265))
- Overlapping refreshes now share Homebrew inventory reads instead of running metadata checks concurrently. ([#274](https://github.com/arshiaghaf/Baseline/pull/274))
- Failed Homebrew lock notifications no longer leave operations locked or prevent queued work from continuing. ([#274](https://github.com/arshiaghaf/Baseline/pull/274))
- Failed Homebrew or mas checks now finish, preserve successful results, and allow retry. ([#275](https://github.com/arshiaghaf/Baseline/pull/275))
- Overlapping tool checks now share probes instead of starting duplicate checks. ([#275](https://github.com/arshiaghaf/Baseline/pull/275))
- Quitting Baseline now cancels delayed failure and progress updates once shutdown is accepted. ([#276](https://github.com/arshiaghaf/Baseline/pull/276))

## 0.7.0 — 2026-10-10

### Highlights

- **Clean up Homebrew from `Settings`.** `Clean up Homebrew` explains its installation-wide effects and asks for confirmation. ([#256](https://github.com/arshiaghaf/Baseline/pull/256))
- **Choose whether Baseline appears in the Dock.** `Show Dock icon` includes safeguards that keep an app entry point available. ([#259](https://github.com/arshiaghaf/Baseline/pull/259))
- **Use shortcuts from the menu bar.** Right-click the icon to refresh, open `Settings`, check for Baseline updates, or quit. ([#259](https://github.com/arshiaghaf/Baseline/pull/259))
- **Keep pinned packages out of updates.** Pinned Homebrew packages are labeled and excluded from updates and queues. ([#255](https://github.com/arshiaghaf/Baseline/pull/255))

### Added

- General > Update Tools now offers a confirmed `Clean up Homebrew` action with an explanation of its installation-wide effects. ([#256](https://github.com/arshiaghaf/Baseline/pull/256))
- Settings now includes `Show Dock icon`, with safeguards that keep an entry point available. ([#259](https://github.com/arshiaghaf/Baseline/pull/259))
- The menu-bar icon now offers right-click actions for Refresh, Settings, Check for Updates, and Quit. ([#259](https://github.com/arshiaghaf/Baseline/pull/259))
- The compact popover now stays in the current full-screen Space. ([#259](https://github.com/arshiaghaf/Baseline/pull/259))

### Fixed

- Removed a vulnerable formatter from Electron download tooling while preserving proxy connections, TLS trust, and credentials. ([#253](https://github.com/arshiaghaf/Baseline/pull/253))
- Baseline's own updates now stay on its dedicated update route instead of appearing among ordinary app or Homebrew updates. ([#254](https://github.com/arshiaghaf/Baseline/pull/254))
- Homebrew actions now use verified installed package identities and avoid collisions between taps. ([#254](https://github.com/arshiaghaf/Baseline/pull/254)), ([#255](https://github.com/arshiaghaf/Baseline/pull/255))
- Saved package state now survives proven Homebrew package renames. ([#254](https://github.com/arshiaghaf/Baseline/pull/254)), ([#255](https://github.com/arshiaghaf/Baseline/pull/255))
- Pinned Homebrew packages are now labeled and excluded from updates and queues. ([#255](https://github.com/arshiaghaf/Baseline/pull/255))
- Ordinary Homebrew updates and installs now follow Homebrew's native cleanup policy without extra global cleanup or dependency-removal commands. ([#256](https://github.com/arshiaghaf/Baseline/pull/256))
- Explicit Homebrew cleanup now safely reconciles inventory and pending refreshes before allowing queued updates to continue. ([#256](https://github.com/arshiaghaf/Baseline/pull/256))
- Contributor regression tests now better cover package ownership, pins, and lifecycle behavior. ([#257](https://github.com/arshiaghaf/Baseline/pull/257))
- Asynchronous cleanup tests now finish their work before removing fixtures. ([#260](https://github.com/arshiaghaf/Baseline/pull/260))

## 0.6.3 — 2026-10-09

### Highlights

- **Keep settings and history through save failures.** Concurrent changes save safely, and a valid backup can recover a corrupt primary file. ([#245](https://github.com/arshiaghaf/Baseline/pull/245))
- **Keep failure details until they are resolved.** Update and install errors remain available after refresh or relaunch until retried or dismissed. ([#248](https://github.com/arshiaghaf/Baseline/pull/248))
- **Get more accurate version checks.** Sparkle checks avoid false updates while retaining valid build-only updates. ([#245](https://github.com/arshiaghaf/Baseline/pull/245)), ([#252](https://github.com/arshiaghaf/Baseline/pull/252))
- **Follow refresh progress more easily.** Refreshes reuse cached information and keep progress feedback responsive. ([#248](https://github.com/arshiaghaf/Baseline/pull/248))
- **Avoid a macOS launch crash.** The bundled Electron update fixes a startup crash on macOS. ([#246](https://github.com/arshiaghaf/Baseline/pull/246))

### Added

- Contributor checks now cover macOS 27 on Apple Silicon. ([#247](https://github.com/arshiaghaf/Baseline/pull/247))
- Update and install failure details now remain available after refresh or relaunch until retried or dismissed. ([#248](https://github.com/arshiaghaf/Baseline/pull/248))

### Fixed

- Settings and history now save safely during concurrent changes and recover from a valid backup when the primary file is corrupt. ([#245](https://github.com/arshiaghaf/Baseline/pull/245))
- Failed Homebrew inventory reads no longer remove installed items or their update routes. ([#245](https://github.com/arshiaghaf/Baseline/pull/245))
- Install queues recover when saving history fails. ([#245](https://github.com/arshiaghaf/Baseline/pull/245))
- Updated Electron to fix a macOS launch crash. ([#246](https://github.com/arshiaghaf/Baseline/pull/246))
- Contributor Electron smoke tests use isolated history-integrity providers instead of the host Keychain. ([#246](https://github.com/arshiaghaf/Baseline/pull/246))
- Refreshes reuse unchanged icons and cached metadata, cancel obsolete lookups, and keep progress updates responsive. ([#248](https://github.com/arshiaghaf/Baseline/pull/248))
- Packaged apps now have ad-hoc resource seals and must pass strict recursive signature verification. ([#251](https://github.com/arshiaghaf/Baseline/pull/251))
- Sparkle updates now compare marketing versions and builds consistently, avoid false updates from matching build annotations, and retain valid build-only updates after relaunch or temporary lookup failures. ([#245](https://github.com/arshiaghaf/Baseline/pull/245)), ([#252](https://github.com/arshiaghaf/Baseline/pull/252))

## 0.6.2 — 2026-10-04

### Highlights

- **macOS 15 or later is now required.** The supported minimum is reflected in the app and installation documentation. ([#236](https://github.com/arshiaghaf/Baseline/pull/236))
- **Patched tools prepare release downloads.** Archive-extraction tooling addresses known security advisories. ([#242](https://github.com/arshiaghaf/Baseline/pull/242)), ([#243](https://github.com/arshiaghaf/Baseline/pull/243))

### Added

- Baseline now requires macOS 15 or later. ([#236](https://github.com/arshiaghaf/Baseline/pull/236))

### Fixed

- Updated archive extraction dependencies to address security advisories and preserve safe extraction behavior in development tooling. ([#242](https://github.com/arshiaghaf/Baseline/pull/242)), ([#243](https://github.com/arshiaghaf/Baseline/pull/243))

## 0.6.1 — 2026-09-27

### Highlights

- **Contributor checks use fewer resources.** Large update-list tests reduce memory and search work without dropping size-limit coverage. ([#233](https://github.com/arshiaghaf/Baseline/pull/233))

### Fixed

- Formula index boundary tests now reduce fixture allocation and search work while preserving coverage above the cask byte limit. ([#233](https://github.com/arshiaghaf/Baseline/pull/233))

## 0.6.0 — 2026-07-23

### Highlights

- **See updates that change only a build number.** Homebrew app updates with unchanged marketing versions remain available and appear in `Recently Updated` after installation. ([#186](https://github.com/arshiaghaf/Baseline/pull/186))
- **Read long version changes without broken cards.** Update cards contain long version text and show the complete value on hover. ([#187](https://github.com/arshiaghaf/Baseline/pull/187))

### Fixed

- Long app and Homebrew version changes now stay within update cards while preserving the full old-to-new value on hover. ([#187](https://github.com/arshiaghaf/Baseline/pull/187))
- Homebrew cask updates that change only build metadata now remain visible, can be installed, and appear in Recently Updated after completion. ([#186](https://github.com/arshiaghaf/Baseline/pull/186))

## 0.5.2 — 2026-06-28

### Highlights

- **Keep apps on the right update route.** Apps installed outside Homebrew no longer get sent through unrelated Homebrew updates. ([#181](https://github.com/arshiaghaf/Baseline/pull/181))

### Fixed

- App updates now use Homebrew only when the installed cask actually owns the app, preventing direct-download or self-updating apps from being routed through unrelated cask catalog matches. ([#181](https://github.com/arshiaghaf/Baseline/pull/181))

## 0.5.1 — 2026-06-26

### Highlights

- **Check the right versions for Mac apps.** Native Mac App Store apps with iPad compatibility information no longer pick up iOS versions. ([#180](https://github.com/arshiaghaf/Baseline/pull/180))

### Fixed

- Native Mac App Store apps with UIKit compatibility metadata now stay on the Mac update path instead of accepting iOS catalog versions. ([#180](https://github.com/arshiaghaf/Baseline/pull/180))

## 0.5.0 — 2026-06-26

### Highlights

- **Follow Homebrew progress more smoothly.** Progress rings advance through each stage using reported command progress. ([#179](https://github.com/arshiaghaf/Baseline/pull/179))
- **Understand your `Profile` totals.** Toolbar guidance explains privacy, counting, and the source mix. ([#177](https://github.com/arshiaghaf/Baseline/pull/177))
- **Find updates for Safari web extensions.** Compatible extension apps can use App Store fallback results without changing ordinary Mac app checks. ([#176](https://github.com/arshiaghaf/Baseline/pull/176))
- **Clear cached downloads after successful work.** Homebrew updates and Discover installs treat cleanup failures as notices rather than failed installations. ([#178](https://github.com/arshiaghaf/Baseline/pull/178))

### Added

- Profile stats now surface privacy and counting guidance in toolbar controls, with clearer source-mix percentages and cleaner Profile layout. ([#177](https://github.com/arshiaghaf/Baseline/pull/177))
- Homebrew progress rings now advance smoothly through each stage while keeping Homebrew output as the source of truth. ([#179](https://github.com/arshiaghaf/Baseline/pull/179))

### Fixed

- Safari web extension apps can now use App Store software fallback results without allowing ordinary Mac App Store apps to pick up iOS-style versions. ([#176](https://github.com/arshiaghaf/Baseline/pull/176))
- Homebrew updates and Discover installs now clean up cached downloads after successful runs while treating cleanup failures as non-blocking notices. ([#178](https://github.com/arshiaghaf/Baseline/pull/178))

## 0.4.0 — 2026-06-22

### Highlights

- **Search from a focused overlay.** The main window offers keyboard shortcuts and compact action results in a command palette. ([#147](https://github.com/arshiaghaf/Baseline/pull/147))
- **Keep available updates during temporary failures.** A brief lookup failure no longer removes an App Store or Sparkle update for an unchanged app. ([#152](https://github.com/arshiaghaf/Baseline/pull/152))
- **Queue updates while Homebrew is busy.** `Update Brews` can queue eligible visible updates behind current work. ([#157](https://github.com/arshiaghaf/Baseline/pull/157))
- **Keep the app list in sync with scan folders.** Adding or removing a scan folder refreshes the visible app list immediately. ([#159](https://github.com/arshiaghaf/Baseline/pull/159))

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

### Highlights

- **Release downloads have consistent build numbers.** Stable downloads carry a build number derived from their release version. ([#143](https://github.com/arshiaghaf/Baseline/pull/143))

### Fixed

- Release artifacts now use version-derived build numbers for stable releases while preserving explicit rebuild overrides and development fallbacks. ([#143](https://github.com/arshiaghaf/Baseline/pull/143))

## 0.3.0 — 2026-06-13

### Highlights

- **See your local update and install activity.** The `Profile` tab shows totals, source mix, and top apps and tools using signed local history. ([#138](https://github.com/arshiaghaf/Baseline/pull/138))
- **Find apps reached through aliases.** Valid app links are scanned without showing duplicate copies of the same installation. ([#128](https://github.com/arshiaghaf/Baseline/pull/128))
- **Queue app updates while Homebrew is busy.** App update clicks can wait behind current work instead of starting overlapping commands. ([#126](https://github.com/arshiaghaf/Baseline/pull/126))
- **See more consistent app and activity icons.** App, Homebrew, and `Profile` icons have more consistent depth and alignment. ([#141](https://github.com/arshiaghaf/Baseline/pull/141))

### Added

- Settings now include a private local Profile stats tab with update and install totals, source mix, top apps/tools, signed local history, and Keychain integrity checks. ([#138](https://github.com/arshiaghaf/Baseline/pull/138))
- App, Homebrew, and Profile stats icon treatments now use more consistent depth, alignment, and source-specific styling. ([#141](https://github.com/arshiaghaf/Baseline/pull/141))

### Fixed

- Symlinked `.app` entries are now scanned when they resolve to directories, with canonical-path deduplication to avoid duplicate app rows. ([#128](https://github.com/arshiaghaf/Baseline/pull/128))
- Homebrew commands now run through a shared lock so installs, refreshes, updates, uninstalls, and tool checks do not overlap; app update clicks can queue while Homebrew is busy. ([#126](https://github.com/arshiaghaf/Baseline/pull/126))

## 0.2.0 — 2026-06-07

### Highlights

- **Check iPhone and iPad apps installed on Mac.** Supported App Store apps use the lookup path appropriate to their installed platform. ([#121](https://github.com/arshiaghaf/Baseline/pull/121)), ([#122](https://github.com/arshiaghaf/Baseline/pull/122))
- **Keep newer refresh results.** Older checks that finish late no longer replace the results of a newer refresh. ([#111](https://github.com/arshiaghaf/Baseline/pull/111))
- **See genuine updates in your recent history.** `Recently Updated` requires an installed version or supported build number to advance. ([#109](https://github.com/arshiaghaf/Baseline/pull/109)), ([#114](https://github.com/arshiaghaf/Baseline/pull/114))
- **Retry failed Discover installs.** Failed Homebrew installs return to an actionable state for another attempt. ([#110](https://github.com/arshiaghaf/Baseline/pull/110))
- **Avoid actions for unavailable tools.** Discover and App Store helper controls reflect whether their supporting tools are available. ([#124](https://github.com/arshiaghaf/Baseline/pull/124)), ([#132](https://github.com/arshiaghaf/Baseline/pull/132))

### Added

- Release automation now publishes changelog-derived release notes and can dispatch the Homebrew cask update workflow after the GitHub Release is available. ([#119](https://github.com/arshiaghaf/Baseline/pull/119)), ([#120](https://github.com/arshiaghaf/Baseline/pull/120))
- Baseline now supports iOS and iPad App Store apps that run on Mac, using local App Store evidence and UIKit idiom metadata to choose the correct App Store lookup path. ([#121](https://github.com/arshiaghaf/Baseline/pull/121)), ([#122](https://github.com/arshiaghaf/Baseline/pull/122))

### Fixed

- `Update Brews` excludes hidden app-backed casks, including ignored app-backed casks in search scopes. ([#113](https://github.com/arshiaghaf/Baseline/pull/113))
- Reused Electron windows no longer accumulate duplicate setup listeners. ([#112](https://github.com/arshiaghaf/Baseline/pull/112))
- Main-window and Settings navigation stay synchronized through the preload bridge. ([#112](https://github.com/arshiaghaf/Baseline/pull/112))
- Failed Discover installs clear stale failure state when retried and return to a retryable state after the transient failure delay. ([#110](https://github.com/arshiaghaf/Baseline/pull/110))
- Recently Updated entries now require real installed-version progress, including Sparkle build-version advances when the marketing version is unchanged. ([#109](https://github.com/arshiaghaf/Baseline/pull/109)), ([#114](https://github.com/arshiaghaf/Baseline/pull/114))
- Overlapping refreshes no longer allow stale scan or lookup results to overwrite newer snapshot state. ([#111](https://github.com/arshiaghaf/Baseline/pull/111))
- Homebrew inventory reads are skipped after the executable is confirmed unavailable, without presenting a failed inventory notice. ([#123](https://github.com/arshiaghaf/Baseline/pull/123))
- Discover install controls disable when Homebrew is unavailable, including a main-process guard against stale install requests. ([#124](https://github.com/arshiaghaf/Baseline/pull/124))
- Homebrew-backed app rows use validated external fallback pages unless installed inventory proves ownership; unmanaged `brew upgrade --cask` fallback is removed, and saved rows can derive a canonical fallback URL. ([#125](https://github.com/arshiaghaf/Baseline/pull/125))
- Sparkle-origin apps now require installed Homebrew cask ownership before using Homebrew fallback updates, while unowned cask rows remain visible. ([#131](https://github.com/arshiaghaf/Baseline/pull/131))
- The App Store `mas` preference retains its saved value but stays disabled until the helper becomes available. ([#132](https://github.com/arshiaghaf/Baseline/pull/132))
- Refresh interval edits now commit reliably after typing. ([#127](https://github.com/arshiaghaf/Baseline/pull/127))

## 0.1.0 — 2026-05-31

### Highlights

- **Use Baseline in a window or from the menu bar.** The rebuilt Mac app keeps both views and checks public App Store, Sparkle, and Homebrew update sources. ([#19](https://github.com/arshiaghaf/Baseline/pull/19))
- **Search consistently across the app.** Search works across the main sections, and choosing a section dismisses it without losing your query. ([#70](https://github.com/arshiaghaf/Baseline/pull/70))
- **Keep ignored items together.** Ignored Mac apps and Homebrew items appear in one sidebar view. ([#45](https://github.com/arshiaghaf/Baseline/pull/45))
- **Choose your appearance.** `Settings` can follow the system or use light or dark mode. ([#65](https://github.com/arshiaghaf/Baseline/pull/65))
- **Find new Baseline releases from the toolbar.** A shortcut appears in the main window when a newer release is available. ([#115](https://github.com/arshiaghaf/Baseline/pull/115))

### Added

- README screenshots and feature placement were updated for Search, Apps, Homebrew, ignored items, optional `mas`/`brew` behavior, and fallback behavior when CLI tooling is unavailable. ([#8](https://github.com/arshiaghaf/Baseline/pull/8)), ([#9](https://github.com/arshiaghaf/Baseline/pull/9)), ([#13](https://github.com/arshiaghaf/Baseline/pull/13))
- Settings now include a local diagnostics report for support and troubleshooting, including report counts, source summaries, and optional tool status. ([#10](https://github.com/arshiaghaf/Baseline/pull/10))
- Preview validation tooling now builds, tests, packages, installs, smoke-launches Baseline, and prepares unsigned release notes with checksums. ([#12](https://github.com/arshiaghaf/Baseline/pull/12))
- GitHub Actions CI validates pull requests and pushes to main. ([#18](https://github.com/arshiaghaf/Baseline/pull/18))
- Tag-driven unsigned DMG release infrastructure generates checksum sidecars, with public CI and release documentation. ([#18](https://github.com/arshiaghaf/Baseline/pull/18))
- Baseline migrated from the legacy Swift/Tuist app to Electron, Vite, React, TypeScript, and Tailwind while preserving the macOS full window, compact menu bar tray window, and public update detection through App Store lookup, Sparkle/DevMate appcasts, and Homebrew metadata. ([#19](https://github.com/arshiaghaf/Baseline/pull/19))
- Public contributor/support documentation now reflects the Electron stack, and stale Xcode/Tuist generated artifact ignore rules were removed. ([#21](https://github.com/arshiaghaf/Baseline/pull/21))
- The legacy Swift/Tuist source was removed from `main`; the previous implementation is archived at branch `legacy/swift` and tag `swift-final`. ([#19](https://github.com/arshiaghaf/Baseline/pull/19)), ([#21](https://github.com/arshiaghaf/Baseline/pull/21))
- Sidebar iconography, spacing, installed-section grouping, toolbar icon styling, and count badges were polished. ([#31](https://github.com/arshiaghaf/Baseline/pull/31))
- GitHub issue auto-labeling now classifies core labels, UI/theme reports, and explicit existing label matches. ([#37](https://github.com/arshiaghaf/Baseline/pull/37))
- The All sidebar tab now uses the `Server` icon. ([#38](https://github.com/arshiaghaf/Baseline/pull/38))
- Full-window update, Recently Updated, and Ignored surfaces were redesigned as responsive card grids while the compact menu bar view stays list-based. ([#39](https://github.com/arshiaghaf/Baseline/pull/39))
- Minimal renderer scrollbar styling was added for light and dark themes. ([#41](https://github.com/arshiaghaf/Baseline/pull/41))
- Homebrew presentation metadata now distinguishes formulae, app casks, CLI casks, package casks, and generic casks without changing command semantics. ([#44](https://github.com/arshiaghaf/Baseline/pull/44))
- GPL-3.0-only licensing and copyright ownership are clearer across source, docs, SPDX headers, and the native macOS About panel. ([#56](https://github.com/arshiaghaf/Baseline/pull/56))
- Ignored macOS apps and ignored Homebrew items appear together in an Ignored sidebar tab. ([#45](https://github.com/arshiaghaf/Baseline/pull/45))
- Installed app and Homebrew sections use card layouts while search results remain row-based. ([#45](https://github.com/arshiaghaf/Baseline/pull/45))
- Settings now include a persisted toggle for showing or hiding the menu bar icon, with tray lifecycle behavior that destroys the compact popover while hidden. ([#58](https://github.com/arshiaghaf/Baseline/pull/58))
- README positioning and screenshots describe the current full-window and menu bar app, with installation guidance, limitations, and first-release infrastructure documentation. ([#57](https://github.com/arshiaghaf/Baseline/pull/57)), ([#61](https://github.com/arshiaghaf/Baseline/pull/61)), ([#64](https://github.com/arshiaghaf/Baseline/pull/64))
- Appearance settings now support System Default, Light Mode, and Dark Mode through Electron `nativeTheme`. ([#65](https://github.com/arshiaghaf/Baseline/pull/65))
- The Baseline Icon Composer source, generated `.icns`, and refreshed app icon artwork are included in packaged apps. ([#66](https://github.com/arshiaghaf/Baseline/pull/66)), ([#67](https://github.com/arshiaghaf/Baseline/pull/67))
- The packaged macOS bundle identifier is `com.arshiaghaf.baseline`. ([#68](https://github.com/arshiaghaf/Baseline/pull/68))
- Installed app and installed Homebrew search matches now render as cards while Discover results keep the existing row layout. ([#69](https://github.com/arshiaghaf/Baseline/pull/69))
- Release preparation accepts exact unversioned or semver-versioned Unreleased headings and rejects malformed matches. ([#74](https://github.com/arshiaghaf/Baseline/pull/74)), ([#76](https://github.com/arshiaghaf/Baseline/pull/76))
- Scheduled and manual unsigned preview validation builds, mounts, installs, and smoke-launches the DMG. ([#78](https://github.com/arshiaghaf/Baseline/pull/78))
- The GPL-3.0-only badge uses a static value to avoid invalid dynamic license metadata, following the earlier badge-cache refresh. ([#77](https://github.com/arshiaghaf/Baseline/pull/77)), ([#80](https://github.com/arshiaghaf/Baseline/pull/80))
- The app icon source and packaged `.icns` artwork were refreshed, with contributor smoke-test shutdown stabilized. ([#79](https://github.com/arshiaghaf/Baseline/pull/79))
- Release validation runs broader macOS CI coverage, production dependency audits, and deterministic Electron smoke tests with graceful app shutdown. ([#78](https://github.com/arshiaghaf/Baseline/pull/78)), ([#81](https://github.com/arshiaghaf/Baseline/pull/81))
- README copy, structure, badges, screenshots, installation notes, and project status explain the app and its supported sources more clearly. ([#85](https://github.com/arshiaghaf/Baseline/pull/85))
- Version and build metadata now flow through shared app metadata, macOS `CFBundleVersion`, Settings, About, diagnostics, release preparation, and Electron smoke coverage. ([#86](https://github.com/arshiaghaf/Baseline/pull/86))
- Settings now use a dedicated in-app sidebar with General, Appearance, and Diagnostics sections, including grouped Update Tools, refresh, scan-directory, and version details. ([#87](https://github.com/arshiaghaf/Baseline/pull/87))
- App card typography now matches Settings row scale, including title, source, version, and detail spacing. ([#95](https://github.com/arshiaghaf/Baseline/pull/95))
- Action menus and update buttons use consistent text sizing, and action popovers are fully opaque. ([#95](https://github.com/arshiaghaf/Baseline/pull/95))
- Settings panel borders and row separators are softer. ([#95](https://github.com/arshiaghaf/Baseline/pull/95))
- Baseline now checks GitHub Releases for app updates and shows a main-window toolbar shortcut when a newer release is available. ([#115](https://github.com/arshiaghaf/Baseline/pull/115))

### Fixed

- Cached update results are preserved when lightweight refresh lookups fail transiently. ([#16](https://github.com/arshiaghaf/Baseline/pull/16))
- Homebrew placeholder icons now use explicit light/dark appearance, appearance-aware cache keys, and compact menu icon rendering that follows the SwiftUI color scheme. ([#17](https://github.com/arshiaghaf/Baseline/pull/17))
- Configured app directories are scanned recursively without descending into discovered `.app` bundles. ([#20](https://github.com/arshiaghaf/Baseline/pull/20))
- Settings can refresh tool readiness through a typed IPC/preload API. ([#20](https://github.com/arshiaghaf/Baseline/pull/20))
- Successful Homebrew single-item retries and maintenance cycles now clear affected failure markers. ([#24](https://github.com/arshiaghaf/Baseline/pull/24))
- Compact menu bar window positioning now aligns to the tray item, clamps to the display work area, and shows as a focused popover. ([#25](https://github.com/arshiaghaf/Baseline/pull/25))
- Toolbar search collapse now handles outside clicks, ignores inside-control clicks, preserves active search text until cleared, and lets adjacent toolbar actions fire. ([#27](https://github.com/arshiaghaf/Baseline/pull/27)), ([#28](https://github.com/arshiaghaf/Baseline/pull/28))
- The compact menu bar dashboard no longer preselects Search on first tray open. ([#29](https://github.com/arshiaghaf/Baseline/pull/29))
- Recently Updated now de-duplicates cask-backed app rows while preserving standalone Homebrew recent rows. ([#30](https://github.com/arshiaghaf/Baseline/pull/30))
- Self-updated Homebrew cask state now reconciles installed casks with scanned app bundle versions only when cask metadata proves the app match. ([#32](https://github.com/arshiaghaf/Baseline/pull/32))
- Sparkle appcast URL policy now rejects IPv4-mapped loopback/private hosts and unspecified hosts such as `0.0.0.0` and `::`. ([#35](https://github.com/arshiaghaf/Baseline/pull/35))
- `fast-xml-parser` and the lockfile were updated to clear the production dependency audit finding for the transitive XML builder package. ([#36](https://github.com/arshiaghaf/Baseline/pull/36))
- Homebrew recently updated retention tests now use an injected cutoff clock for deterministic results. ([#42](https://github.com/arshiaghaf/Baseline/pull/42))
- Homebrew cask/app linking now persists explicit app links, avoids CLI/binary target false matches, suppresses duplicate app-backed cask rows, and prunes stale recently updated records. ([#43](https://github.com/arshiaghaf/Baseline/pull/43))
- Ignored item action menus stay fully saturated while ignored card and row content remains visually muted. ([#59](https://github.com/arshiaghaf/Baseline/pull/59))
- Sidebar update badges keep the All, Apps, and Homebrew counts stable while search filtering is active. ([#60](https://github.com/arshiaghaf/Baseline/pull/60))
- Toolbar search now works consistently across Apps, Homebrew, Installed, Ignored, and Discovery; selecting a sidebar tab or Settings exits active search while preserving the query for next use. ([#70](https://github.com/arshiaghaf/Baseline/pull/70))
- Bundle icon extraction now preserves app icons when `sips` produces grayscale-only PNG output from ICNS conversion. ([#82](https://github.com/arshiaghaf/Baseline/pull/82))
- App rows/cards that update through matched Homebrew casks now show cask progress, completion, and failure states, including a brief successful state before refresh moves the item to Recently Updated. ([#91](https://github.com/arshiaghaf/Baseline/pull/91))
- Batch Homebrew updates now target only non-ignored, valid outdated tokens instead of letting a broad `brew upgrade` affect ignored items. ([#92](https://github.com/arshiaghaf/Baseline/pull/92))
- Sidebar update badges are hidden when their count is zero. ([#93](https://github.com/arshiaghaf/Baseline/pull/93))
- Failed Homebrew update indicators now clear for retries and fall back to a retryable Update state after a short delay. ([#83](https://github.com/arshiaghaf/Baseline/pull/83))
- Homebrew outdated and inventory JSON parsing now reads valid JSON from stdout even when Homebrew emits warnings on stderr after wake or concurrent package-manager activity. ([#88](https://github.com/arshiaghaf/Baseline/pull/88))
