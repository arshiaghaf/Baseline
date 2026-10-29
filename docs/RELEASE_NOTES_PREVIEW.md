# Release notes preview

This development preview runs the production renderer, preload bridge and release-note service in a separate Electron process. It uses labelled sample inventory rather than scanning this Mac. App updates, package operations, app launching, clipboard writes, directory access and settings persistence are disabled. No installed application is replaced.

Build the branch, then launch the preview:

```sh
npm run build
node scripts/preview-release-notes.mjs
```

The launcher creates a fresh temporary profile by default. To reuse its Chromium state, supply a dedicated empty directory on the first launch:

```sh
node scripts/preview-release-notes.mjs --profile /tmp/baseline-notes-preview-review
```

Only an empty directory or one marked by a prior preview launch is accepted. Ordinary application-data directories, the home directory and filesystem root are rejected. Profile setup happens before Electron becomes ready; user data, session data, logs and crash dumps are kept inside that profile. The preview never initializes production startup, Keychain integrity, app scanning, the CLI server, Homebrew commands or the self-updater.

The default examples obtain current public metadata for an App Store app, a Sparkle app and a GitHub-backed Homebrew formula. Publisher notes are real; the displayed installed versions and inventory are explicitly sample data. An unsupported-source example demonstrates the unavailable state. Requests reveal this preview's IP address and requested public source to those hosts. If a source is offline or rate limited, the preview reports the gap rather than inventing notes. Notes coverage depends on the publisher and exact selected version.

Hover a name or version for 600 ms, or use its Release notes button immediately. Click, Enter and Space can open the panel; Escape dismisses it. Source links are not displayed in the panel. Refresh and update controls cannot change real applications or packages.

The notes icon inherits the adjacent version text’s color and size. Known unsupported sources and empty App Store summaries omit it immediately. Remote coverage is checked lazily on interaction: confirmed unavailable or empty notes hide the icon for that source/version; a source refresh permits another lookup. Unknown remote coverage retains a lookup control until resolved. Loading is marked busy, and transient errors or stale-target responses keep the control retryable. Rendering the list does not start a background sweep of publisher sites.

## Hidden Electron verification

Prepare the harness without launching it:

```sh
node scripts/preview-release-notes.mjs --prepare
```

The single JSON output contains `root`, `entry`, `preload` and `renderer` absolute paths. A Playwright Electron runner can launch `entry` with these environment variables:

| Variable | Purpose |
| --- | --- |
| `BASELINE_NOTES_PREVIEW_ROOT` | Worktree path returned by preparation |
| `BASELINE_NOTES_PREVIEW_PROFILE` | Dedicated empty temporary directory |
| `BASELINE_NOTES_PREVIEW_HIDDEN=1` | Never show or activate the window; macOS activation policy is prohibited |
| `BASELINE_NOTES_PREVIEW_ROUTE` | `main` or `menubar` layout |
| `BASELINE_NOTES_PREVIEW_SNAPSHOT` | Optional local JSON snapshot for deterministic inventory |
| `BASELINE_NOTES_PREVIEW_FIXTURE_NOTES` | Optional local response-fixture JSON, clearly labelled Fixture mode |

The equivalent launcher flags are `--hidden`, `--profile`, `--route`, `--snapshot` and `--fixture-notes`. Hidden mode disables external link opening too. The harness does not show a Dock icon, create a tray, switch Spaces or activate any app in hidden mode. The visible launcher is for deliberate user review; automated checks should use hidden mode unless desktop use is authorised.

A response fixture maps target IDs to `{ "result": ReleaseNotesResult, "delayMs": 200, "error": "optional test failure" }`. Delay is bounded to 30 seconds and cancellation aborts the wait. Fixtures apply only to this harness; the application service has no fixture override. Do not use fixture responses as evidence that a publisher provides notes. Omit both fixture options for live-source review.

Do not rebuild renderer output while a preview or Electron test is loading it. Close the owned preview before rebuilding.
