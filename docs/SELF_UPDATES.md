# Baseline self-updates

The toolbar shortcut, tray **Check for Updates**, and Settings > Diagnostics
**Check for updates** use the same main-process check. The toolbar never opens an
old snapshot URL directly. Checks run independently of app scans at startup,
hourly, on wake, and when reopening Baseline after five minutes. A later-started
check supersedes an earlier response. Failed checks offer retry or the release page.

## Distribution and trust

Normal builds embed the approved public key in `native/self-updater/publisher.json`
and include unmodified upstream Sparkle 2.10.1. Sparkle's standard native update
window owns download progress, verification, installation and relaunch. Baseline
does not implement archive extraction or application replacement. Installing
dependencies, running tests and building never create keys or publish releases.

The fixed appcast URL is:

`https://github.com/arshiaghaf/Baseline/releases/latest/download/appcast.xml`

Sparkle requires authenticated archives before extraction and authenticated feeds
and release notes. Signed-feed verification has no expiration fallback. The helper
refuses package installers and non-HTTPS downloads. Automatic downloads,
installations and profiling are disabled. A manual check starts the native flow;
a GitHub availability badge never authorizes installation.

Existing installations must install the first updater-enabled build manually.
Their old binary cannot acquire an updater or its trust key remotely. The first
updater-enabled release must publish its ZIP and signed `appcast.xml`; that feed
endpoint is unavailable until the separately authorized release publication.

Ad-hoc Apple code signing remains the bundle-integrity policy. Sparkle's archive
signature authenticates the publisher against the key pinned in the installed
app. It does not supply Developer ID, notarization, Gatekeeper approval, or a stable
OS privacy/Keychain identity. macOS launch warnings, App Management permissions
and managed-device restrictions remain authoritative. No quarantine removal or
security-setting changes are performed.

Only canonical `/Applications/Baseline.app` and `~/Applications/Baseline.app`
locations are candidates. Development and isolated profiles are excluded. As an
initial conservative restriction, detectable Homebrew executables, standard
Caskroom directories, custom prefix variables and inconclusive reads retain the
manual route. This also excludes manual copies on Macs with Homebrew; it does not
claim receipt-backed ownership. Extending support requires a verified ownership
policy. No Homebrew command runs in the native helper.

The helper derives its host from its embedded location. IPC and arguments cannot
supply another app, download URL or trust key. Before permitting installation,
Baseline rejects active operations, fences new work, drains producers and saves
through its existing durable quit path. Only then does its private pipe allow
Sparkle to proceed, and Baseline quits. A refused save explicitly cancels the
staged installation through Sparkle's public Skip choice before helper exit.
Sparkle can install an already staged, authenticated update after the host crashes
or exits; the helper does not provide a crash-atomic persistence guarantee.
Baseline's normal quit path still saves durably. If the helper exits after quit
preparation, Baseline still quits safely; reopening and retrying may be necessary.
No custom rollback, privileged installer or relaunch command is added.

## Maintainer signing: local Keychain only

The approved publisher key lives in the maintainer Mac's login Keychain under
Sparkle's `https://sparkle-project.org` service and the account recorded in
`native/self-updater/publisher.json`. Only the public key belongs in source and
builds. The private key must never enter source, application bundles, logs, shell
arguments, CI secrets or pull-request jobs. The selected setup has no exported
backup: losing that Keychain can require a new manually installed trusted build.
Key rotation or compromise requires a separate recovery decision.

Prepare the pinned framework with `npm run prepare:sparkle`. Its SHA-256 is pinned
in `native/self-updater/upstream.json`. Packaging verifies the archive again and
extracts a fresh copy instead of trusting mutable cache files. The upstream license
is included. Normal packaging uses the tracked approved public key. An explicit
`BASELINE_ENABLE_SIGNED_UPDATES=0` build omits the helper and retains manual updates.
An enabled build with a missing or malformed key fails closed. Public-key overrides
are available for isolated fixtures; production signing refuses them.

For an explicitly authorized release, run
`scripts/prepare-signed-updates.sh <stable-version>` on the maintainer Mac. It
checks the Keychain's public identity against the tracked key, builds and verifies
the app, then uses upstream `generate_appcast` to sign the full ZIP and appcast
locally. It refuses to overwrite an existing preparation directory and does not
publish anything. Keychain may ask for ordinary access approval; do not broaden
its access controls to suppress that prompt.

`docs/examples/signed-update-release.yml.example` is an inactive artifact-build
template. It sends no private key to GitHub. The active release workflow builds
DMGs and uploads Actions artifacts; it does not publish GitHub Releases. Upload
all signed assets before advertising a release as latest. Do not overwrite shipped
assets. Use increasing release-derived `CFBundleVersion` values, Apple Silicon
archives and macOS 15 minimum metadata. Start with full archives; delta updates
and additional channels are outside this implementation.

Public GitHub releases and ordinary public-repository runners can keep hosting
cost at zero under their current terms. No paid backend or Apple enrollment is
required for Sparkle archive authentication. Apple notarization remains separate.

## Validation

Unit tests use public fixtures and fake transports. Native guard tests compile the
real helper and invoke configuration-validation/disabled modes without accessing
Keychain or launching a GUI. Prepare Sparkle before these checks:

```sh
npm run prepare:sparkle
npm test -- ElectronTests/selfUpdaterNative.test.ts
```

The opt-in lifecycle suite creates temporary apps with unique bundle IDs,
disposable Ed25519 keys, private profiles, a loopback feed and a headless user
driver. It runs the actual updater controller and upstream installer, including
feed/archive authentication, save acknowledgement and relaunch. No Keychain key or
installed Baseline data is used. Loopback transport and the headless driver are
compiled only for fixtures; production uses HTTPS and Sparkle's standard UI.
Owned processes are confirmed stopped before fixture removal.

```sh
npm run build
BASELINE_SELF_UPDATE_FIXTURE_TESTS=1 npm test -- ElectronTests/selfUpdateLifecycle.test.ts
```

Run lifecycle tests only in an authorized desktop lane. They cover valid updates,
tampered feeds/archives, wrong archive keys and failed saves. Real release hosting,
quarantine/App Management prompts, denied installation locations and the standard
interactive UI still need release-level testing. CI's macOS matrix checks bundle
integrity and compatibility; a passing fixture does not establish notarization.

Sources: [Sparkle setup](https://sparkle-project.org/documentation/),
[security settings](https://sparkle-project.org/documentation/customization/),
[programmatic API](https://sparkle-project.org/documentation/programmatic-setup/),
[upstream release](https://github.com/sparkle-project/Sparkle/releases/tag/2.10.1).
