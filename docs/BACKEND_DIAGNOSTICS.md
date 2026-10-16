# On-demand Homebrew diagnostics

`HomebrewDiagnosticsService` is a backend-only opt-in service. Construction does
nothing. `collect({})` runs `brew config`; `doctor: true` additionally runs
`brew doctor --json`, and `services: true` additionally runs
`brew services info --all --json`. An unusable Doctor JSON schema/unsupported
option receives one sequential text fallback. A valid structured report does not
run Doctor twice. Launch failures, timeouts, cancellation and output overflow do
not trigger a fallback. Doctor exit 1 with usable findings is a report, not a
generic execution failure. A nonzero exit without readable findings never means
healthy.

All argv are fixed. The service accepts booleans only and rejects unknown request
keys. It has no repairs, service control, metadata refresh, crash-report collection,
upload, disk storage, automatic refresh subscription, replacement or relaunch.

## Composition and integration ownership

The service requires an injected bounded runner and the **existing shared
Homebrew reservation**, held through awaited runner teardown. It must not receive
an unrelated lock. The central composition owner should use:

```ts
const diagnostics = new HomebrewDiagnosticsService({
  runBrew: runBrewCommand,
  reserveHomebrewWork: () => homebrewWorkLock.reserveCommand()
});
// Only from an explicit trusted backend invocation:
const report = await diagnostics.collect({ doctor: true }, abortSignal);
```

This service depends on the bounded runner work in PR #284. Its merge base must
contain that runner and the minimum cleanup-quarantine wiring before production
composition; a legacy two-argument runner silently ignores safety options and
must not be used. The adapter targets
`runBrewCommand(args, onOutputLine?, options?)`. It requires complete capture with
128 KiB maximum output, a 15-second config/services deadline and 60-second Doctor
deadline, and awaited process-group settlement before returning. Complete capture
makes oversize JSON fail closed; the report marks overflow as truncated. The
parser independently checks UTF-8 byte size before JSON parsing, including the
combined stdout/stderr budget. Findings are capped at 64; service aggregation is
capped at 256 with explicit omitted counts. No full transcript survives parsing.

Use a typed IPC method with existing sender validation if exposing this to an
explicit backend caller. Do not invoke it from refresh, startup, tray redraw,
background schedules or failure retry. Do not attach the report to snapshots,
operation failures, telemetry, or persistence. Any later UI copy/export action
must use only the safe report or `renderHomebrewDiagnostics(report)`.

The reservation callback is intentionally mandatory; the service cannot silently
run outside the application's existing work/quit guard. Concurrent diagnostics
and requests during refresh or mutation return `busy` without spawning commands.
Cancellation returns only after the injected runner settles; remaining optional
commands are skipped. The integration owner owns store/main/preload/shared API
wiring and integration tests; this change owns the new service, report contract,
focused tests and this document.

## Privacy and compatibility

Reports project an allowlist instead of attempting to scrub arbitrary secret
formats out of free text. Config retains recognized numeric tool versions,
known architecture from the emitted `macOS: version-kernel` suffix, Rosetta
boolean, and whether known proxy/certificate settings are present. The optional
injected `environmentPresence()` boundary returns only
`{ proxyConfigured: boolean, certificateConfigured: boolean }`; its default reads
presence of inherited proxy and certificate variables on explicit invocation,
without retaining their values. Config output is not expected to echo certificate
variables. Tests inject deterministic booleans except explicit fake-environment
fixtures. False does not exclude indirect curl configuration or system trust
settings. Unknown keys, values, suffixes, paths, remotes, build hostnames and
environment values are discarded.

Doctor maps messages to fixed categories and known support tiers. Unknown
messages become `other`; arbitrary prose, affected package names, remediation
commands and links are discarded. Support tier is Homebrew support metadata,
not an invented severity. The text fallback similarly reports only categories
from Warning/Error headings. Services retain totals, running/registered counts,
confirmed failure counts, unknown rows and omitted counts. The decoder validates
all projected fields that `FormulaWrapper.to_hash` always emits: boolean running,
loaded, schedulable and registered values; a nullable safe-integer exit code; and
a status consistent with the complete producer precedence below.

| Observed producer state, in precedence order | Status | Aggregate contribution |
|---|---|---|
| Running | `started` | Running; ignore historical exit code |
| Not running and not loaded | `none` | No failure, including historical nonzero exits |
| Loaded, not running, exit zero, schedulable | `scheduled` | Known state |
| Loaded, not running, exit zero, not schedulable | `stopped` | Known state |
| Loaded, not running, nonzero exit | `error` | Confirmed failure |
| Loaded, not running, exit unavailable | `unknown` or `other` | Unknown; partial |

Missing, malformed, unrecognized or contradictory state counts the row as unknown
once. Independently typed running and registration observations remain usable;
uncertain rows do not invent confirmed failures. Unknown/omitted rows take partial
precedence over known findings. Capture overflow takes truncated precedence and
publishes no decoded counts. JSON `[]` is required for a known empty list; blank
stdout is invalid. Service names, usernames, PIDs, files and log paths are never
included. Extra unprojected fields are ignored rather than exported.

The runner receives an **overlay** containing NONINTERACTIVE,
HOMEBREW_NO_AUTO_UPDATE, HOMEBREW_NO_ANALYTICS and HOMEBREW_NO_ENV_HINTS. Inherited
proxy, certificate and Homebrew configuration must remain intact; neither the
service nor its tests replaces `process.env` or disables TLS validation. This is
not a sandbox for arbitrary third-party Homebrew code: it is an allowlisted
read-only diagnostics caller with metadata auto-update disabled.

These schema decisions follow Homebrew primary sources:
[macOS config formatter](https://github.com/Homebrew/brew/blob/7.0.4/Library/Homebrew/extend/os/mac/system_config.rb#L55-L57),
[config environment loop](https://github.com/Homebrew/brew/blob/7.0.4/Library/Homebrew/system_config.rb#L158-L180),
[recognized environment keys](https://github.com/Homebrew/brew/blob/7.0.4/Library/Homebrew/env_config.rb#L795-L814),
[service JSON output](https://docs.brew.sh/rubydoc/Homebrew/Cmd/Services/InfoSubcommand.html#run-instance_method)
and [service error precedence](https://docs.brew.sh/rubydoc/Homebrew/Services/FormulaWrapper.html#error%3F-instance_method).

## Self-update provenance and outcome recovery plan

Automatic self-update remains a separate product/distribution project. The
current release-page action does not prove Homebrew ownership and must remain
unchanged. Pure eligibility helpers are deliberately deferred: there is no
producer of trusted install-provenance evidence, artifact-verification result,
rollback state or outcome receipt in the current backend. Helpers accepting
invented booleans would imply an authorization boundary without validating it.

A concrete later implementation should proceed in this order:

1. Establish installed application provenance using canonical bundle paths,
   verified installed cask artifact/bundle identity and exact tap/token. A shared
   bundle identifier, display name, catalogue match or install under
   `/Applications` is insufficient. Ambiguous/manual installations retain the
   release-page route. Never infer ownership from cached public metadata.
2. Define distribution-specific artifact trust: expected publisher/signing
   identity, notarization/designated requirement where applicable, exact release
   asset and digest verification. Preserve proxy/cert handling. Refuse ambiguous
   provenance or failed trust checks before staging any replacement.
3. Specify explicit user intent and operation identity. Reuse the work reservation
   and active-operation/quit guard; block overlapping package actions. Stage in a
   private directory without changing the running bundle. Do not hardcode a cask
   upgrade for manual installations.
4. Persist a versioned private receipt with operation ID, expected old/new
   version/identity, allowed relative staging references and lifecycle state
   (`prepared`, `exited`, `replaced`, `verified`, `rolled-back`, `failed`). Use the
   existing atomic persistence/recovery guarantees; no raw command logs, secrets,
   arbitrary relaunch path or environment dump. Record durable intent before exit.
5. A narrowly scoped helper should wait for the verified original process exit
   with a deadline, revalidate paths/identity immediately before replacement,
   retain a rollback bundle, verify the installed result, and record outcome
   before any explicitly requested relaunch. Timeout means abandon safely, not
   overwrite a running application. Recover interrupted stages idempotently.
6. On next launch, consume/reconcile the receipt before normal update scheduling,
   compare actual installed version/identity with expected outcome, keep rollback
   recoverable until verification succeeds, and expose a safe outcome summary.
   A missing or corrupt receipt must never authorize replacement or relaunch.

Meaningful tests require injected filesystem/process/signature adapters and
private fixture bundles: manual/cask/ambiguous provenance, symlink/path swaps,
wrong signer/hash, helper timeout, interruption at every receipt transition,
corrupt/backup recovery, repeated launch recovery, active-operation guard and
rollback failure. No production bundle or Homebrew package is a test fixture.

## Deferred product/UI scope

- A user-facing troubleshoot panel/copy/export entry point needs product wording,
  explicit invocation and consent/lifetime design. No renderer/CSS/native visual
  work is part of this backend change. The typed safe result can support it later.
- Per-formula service explanation needs a verified installed-identity consumer
  and an affected-package selection contract. Aggregated health ships as the
  read-only groundwork; service start/stop/restart is outside updater scope.
- Automatic app replacement/relaunch, rollback UX and self-update outcome display
  need the provenance/trust/helper/receipt lifecycle above. They cannot safely
  ship as a small helper or a release-page behavior change.
- Crash assistance requires evidence that it is useful and an Electron-specific
  consent/privacy design. This service never reads, collects or uploads reports.
- Tap management, formula uninstall, pin controls and Brewfile workflows expand
  package-manager scope and have no diagnostics-only consumer here.
