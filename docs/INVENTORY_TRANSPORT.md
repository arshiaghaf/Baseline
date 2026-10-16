# Installed Homebrew inventory transport

`HomebrewInventoryClient` attempts `info --installed --json=v2` to obtain both
installed metadata sections together. It retains the formula and cask
`list --versions` reads and both outdated reads, including `--cask --greedy`.
The ordinary successful path therefore uses five read subprocesses rather than
six. An explicitly requested `brew update` still completes before any reads.

The lists are correctness evidence, not redundant metadata:

- Formula lists preserve the installed rack ID across canonical-name changes,
  multiple installed kegs, revision suffixes and HEAD installs. Identity and
  outdated joins still use the proven full name and tap.
- Cask installed-info and list output use the installed version, but they do not
  have equivalent completeness/failure semantics. Homebrew's installed-info path
  calls `Caskroom.casks`, which can silently skip unloadable casks. The list path
  loads Caskroom entries independently and can report failure. Removing that
  failure evidence could treat an installed cask as removed during recovery.
- Info's ordinary cask outdated flag does not implement the greedy policy for
  `latest` and auto-updating casks. The explicit greedy check remains authoritative.

Source review on 16 October 2026: Homebrew's
[info selection](https://github.com/Homebrew/brew/blob/main/Library/Homebrew/cmd/info.rb),
[rack/cask list transport](https://github.com/Homebrew/brew/blob/main/Library/Homebrew/cmd/list.rb),
[cask enumeration and skipped failures](https://github.com/Homebrew/brew/blob/main/Library/Homebrew/cask/caskroom.rb),
[cask list version formatting](https://github.com/Homebrew/brew/blob/main/Library/Homebrew/cask/list.rb),
and [installed/outdated cask fields](https://github.com/Homebrew/brew/blob/main/Library/Homebrew/cask/cask.rb).
These links track upstream main; fixtures are synthetic schema examples, not a
claim of live Homebrew validation on every supported version.

## Recovery and metadata

A nonzero combined-info result is discarded even when its stdout resembles valid
JSON. Missing, malformed or ambiguous installed sections trigger independent
per-kind info fallbacks. A single failed section does not discard the healthy
kind. The worst case adds one attempted combined read to the original six reads.
Inventory status continues to reflect each list result, separately from outdated
status, metadata-update freshness and installed-identity verification.

Unconfirmed process cleanup returns `cleanupUnconfirmed: true`, empty evidence
and failed statuses for both kinds. No subsequent fallback batch starts. The
central reservation owner must quarantine future work until restart; inventory
does not release that safety condition. Initial concurrently started reads are
awaited before returning.

Installed cask entry parser rejection is contained per entry. The row remains
present but unverified, its update is disabled, and healthy formula evidence is
retained. Public catalogue data never repairs an unverified installed identity.

`installedMetadataByItemID` is an optional typed backend sidecar containing only
verified installed nodes. It retains caveats, deprecation/disable reasons,
receipt install reasons, version/revision/HEAD context, declared dependencies and
receipt runtime dependencies. Reverse dependent IDs resolve only unambiguous,
exact verified receipt full names; bare names never substitute for custom taps.
Declarations remain distinct from observed receipt edges. Multiple installed
receipts and unresolved references are retained. This is partial observed
dependency context, never an uninstall-safety guarantee.

The sidecar belongs in memory only. It must not enter persisted snapshots,
ordinary renderer snapshots or automatic diagnostic exports: caveats can contain
local paths. Explicit diagnostic consumers should expose redacted availability,
booleans and counts. The integration layer owns that consumer and shared API.

## Verification and synthetic probe

`homebrewInstalledInfo.test.ts` compares the combined and fallback results for
pins, revisions, HEAD, custom taps, historical names, latest/auto-update casks,
empty/malformed output, separate stdout/stderr, partial failures and cleanup
uncertainty. Existing inventory and store recovery tests remain in place.

Run the opt-in subprocess probe with:

```sh
BASELINE_INVENTORY_BENCHMARK=1 npx vitest run ElectronTests/homebrewInventoryBenchmark.test.ts --disableConsoleIntercept
```

The probe launches only temporary Node fixture children. It compares the original
six-read two-batch schedule at Baseline `6f07aca` with the five-read client, checks
complete result equivalence, warms each plan once, alternates plan order and
reports five samples per plan. Each child adds an artificial 10ms delay and emits
a peak RSS value. The legacy path replays captured results through the preserved
parser/identity code without launching a seventh child.

Example local run (Node 24.22.0, macOS arm64):

| Synthetic installed items | Legacy/combined children | Median elapsed ms, legacy/combined | Maximum single-child RSS KiB, legacy/combined |
| --- | --- | --- | --- |
| 7 | 6 / 5 | 79.71 / 43.81 | 43,968 / 44,064 |
| 407 | 6 / 5 | 85.12 / 47.17 | 44,416 / 44,384 |

These timings model Node startup, fixed fake work, scheduling and local parsing.
They do **not** establish real-world/Homebrew speedups, aggregate process memory,
or product latency. No real Homebrew command or production package state is used
by these tests. Separately authorized representative Homebrew measurements remain
necessary before making product performance claims.
