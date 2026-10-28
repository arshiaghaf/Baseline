# Command line

Baseline includes a CLI for people, scripts and local agents. It uses the same
backend as the app. There is no separate package database or updater process,
network port, API key, or background login service.

## Get started

Run the bundled command directly:

```sh
/Applications/Baseline.app/Contents/Resources/cli/bin/baseline --help
```

For a shorter command, create a symlink in a directory already on your PATH. For
example, if you use `~/.local/bin`:

```sh
mkdir -p "$HOME/.local/bin"
ln -s /Applications/Baseline.app/Contents/Resources/cli/bin/baseline "$HOME/.local/bin/baseline"
```

The command does not require Node, Homebrew, or npm on PATH. Keep the app installed;
the command uses its bundled runtime. If you move the app, recreate the symlink
using its new path. An existing unrelated `baseline` command is never replaced
automatically. Quit an older running copy after upgrading to a CLI-enabled build.

```sh
baseline status
baseline check
baseline list
baseline inspect 'brew:formula:example-tool'
baseline update 'brew:formula:example-tool' --dry-run
baseline update 'brew:formula:example-tool' --yes
baseline doctor
```

Copy exact IDs from `list`; names, guessed package tokens and wildcards are not
accepted. Quote IDs containing spaces. You can supply up to 50 distinct targets.
There is deliberately no implicit “update everything.” Listings include ignored
and pinned targets, their protection reason, source, available version and check
status. The app's selected tab and search filter do not affect CLI listings.

`status`, `list`, `inspect` and `doctor` read the current backend snapshot. They
do not scan apps, refresh sources or execute package commands. If necessary the
CLI launches Baseline without opening its windows or running automatic checks.
Opening Baseline normally then restores its usual GUI and automatic checks.
`--help` and `--version` work without starting the backend.

## Check, preview and update

`check` runs a full scan and forces metadata revalidation through the app's source
clients. It reports incomplete checks instead of claiming everything is current.
Individual source timestamps remain distinct from overall scan completion.
`list --json` exposes each target's `checkedAt` and `checkStatus`, plus overall
refresh health and notices. An unresolved source is not proof that an app is
current. A successful check does not imply every app has an available update.
The runtime `appDiscoveryComplete` field reports whether all app discovery
completed; unreadable folders or app records make the check partial and do not
establish CLI update freshness. A later complete check restores admission.

`update --dry-run` is read-only. It returns the selected targets, protections,
effects and a `planID`. For scripts that require the preview to match:

```sh
baseline update 'brew:formula:example-tool' --dry-run --json
baseline update 'brew:formula:example-tool' --yes --expect-plan '<planID>' --json
```

The plan is bound to this running app session and its target evidence. It is not
a downloadable manifest or a promise about future package-manager behavior.
Changed identity, versions, routes, ignore/pin state or freshness require a new
preview. The store also rechecks installed Homebrew membership and canonical
identity immediately before execution. Each selected target is rechecked after
earlier targets complete; changed targets are blocked rather than silently
substituted. Shared app work may return `busy` instead of starting another run.

Applying requires `--yes` and a CLI check in this app session within 15 minutes.
Failed checks, incomplete inventory, unverified installed identity, pins,
ignored items, quarantined Homebrew state and Baseline's self-update protections
are preserved. Homebrew may update dependencies and perform its normal cleanup.
The CLI does not run installation-wide cleanup, install or uninstall packages,
change preferences, remove quarantine, or replace Baseline itself.

Direct updates currently use Homebrew only. Updates that do not expose an independently
verifiable version increase (such as `latest` or build-only cask changes) return
`requires-user-action` before running a command; complete those in the app. Casks require `--interactive`, even
when a particular cask may not need a password. Administrator prompts use
Baseline's existing coordinator; the CLI never accepts a password argument.
App Store, Sparkle and other publisher updates are explicit handoffs:

```sh
baseline update 'app:/Applications/Example.app' --yes --interactive
```

Without `--interactive`, the CLI explains what requires attention and opens
nothing. With it, Baseline opens the validated publisher/App Store link or the
installed app. The outcome remains `requires-user-action` with exit code 3.
Finish the installation there and check again. Opening a handoff is never
reported as an installed update. The GUI's existing App Store helper and
Baseline's signed self-updater retain their existing behavior and ownership.

## Operations, retries and interruption

`check` and applied `update` requests receive UUID operation IDs. The CLI prints
the ID to stderr before submission and includes it in JSON outcomes. By default,
these commands wait up to 300 seconds. Use `--no-wait` for immediate acceptance,
or `--timeout 60` to bound waiting. `operation` returns the current status once;
add `--wait` to wait for a terminal result.

```sh
baseline check --no-wait --json
baseline operation '<operationID>' --json
baseline operation '<operationID>' --wait --timeout 60 --json
```

Ctrl-C, SIGTERM, transport errors and timeouts stop the CLI's wait. They do **not**
cancel accepted backend work, kill a package manager, or dismiss an administrator
prompt. Query the operation before retrying. Cask prompts may need attention at
the Mac while the operation reports `waiting-for-user`.

For a transport retry within the **same app session**, `--operation-id <uuid>`
deduplicates an identical request. Reusing it for a different request is rejected.
No mutation request is automatically resent after an uncertain connection.
The backend retains the last 128 operation records in memory. A restart or
eviction can make an ID unknown: that does not establish whether software
changed. Inspect installed state and check again before issuing a new update.
This is session-scoped retry protection, not a durable cross-restart job queue.

An update reports `updated` only after reconciled installed state verifies the
new version at or above the planned version. A no-op, failed command, missing
target or incomplete reconciliation cannot produce success. Multi-target runs
return individual outcomes and preserve successful results when later work
fails. They are not transactions and do not roll back installed updates.

## JSON and exit codes

`--json` writes exactly one JSON object to stdout, including errors. Progress
and the pre-submission operation ID use stderr. There is no pager, ANSI styling,
interactive stdin prompt, or TTY-dependent behavior. Human text is for reading;
automation should consume the JSON contract.

```json
{
  "schemaVersion": 1,
  "sessionID": "a UUID identifying the running backend",
  "ok": true,
  "exitCode": 0,
  "data": {}
}
```

Errors include `error.code` and `error.message`. Running operations live under
`data.operation`, with `id`, `kind`, `state`, timestamps, `results` and `exitCode`.
Accepted work returns exit 0 with a running state when using `--no-wait`; this is
acceptance, not confirmed completion. Always inspect its terminal operation.
Responses may gain fields; consumers should ignore unknown ones. Incompatible
changes require a new `schemaVersion`.

| Exit      | Meaning                                                             |
| --------- | ------------------------------------------------------------------- |
| 0         | Successful read/check/update, or asynchronous acceptance            |
| 1         | Failed or incomplete work, including partial multi-target failure   |
| 2         | Invalid arguments, unknown target, or missing explicit confirmation |
| 3         | User action required; installation not confirmed                    |
| 4         | Backend busy or preview no longer matches                           |
| 5         | Backend unavailable, restarted, incompatible, or operation unknown  |
| 6         | Wait or transport deadline exceeded; outcome may still be running   |
| 130 / 143 | Interrupted by SIGINT / SIGTERM; accepted work may continue         |

`doctor --json` provides capability discovery, limits, these exit codes and the
existing diagnostic report. IDs and diagnostics can contain local app paths;
review them before sharing. Listings omit icons, feed URLs, private command
output and profile-history records. Neither command reads credentials.

## Implementation rationale

The bundled launcher uses Electron's existing Node runtime, following the
established [desktop CLI launcher pattern](https://github.com/microsoft/vscode/blob/main/resources/darwin/bin/code.sh).
It does not enable new fuses or weaken signing. Electron documents the
[RunAsNode capability](https://www.electronjs.org/docs/latest/tutorial/fuses)
and [profile single-instance lock](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata).
The first process owns both the GUI and CLI store. A private, owner-checked
0700 directory and 0600 Unix socket provide same-user local IPC, with bounded
messages, connection limits and idle deadlines. There is no HTTP listener or
remote-control facility. Other programs running as the same user are inside
this trust boundary, as they are for the user's shell.

The human/JSON split and documented exit statuses draw on
[GitHub CLI formatting](https://cli.github.com/manual/gh_help_formatting) and
[exit-code conventions](https://cli.github.com/manual/gh_help_exit-codes).
Explicit plans and package effects are informed by
[Homebrew's documented commands](https://docs.brew.sh/Manpage).
The contract makes handoffs, partial checks and uncertainty explicit rather
than deriving success solely from a subprocess exit or a window opening.

[Sparkle's official CLI](https://sparkle-project.org/documentation/sparkle-cli/)
can update external bundles, but its documentation identifies gaps when apps
customize their updater logic or feed. Supporting it as a direct route requires
separate compatibility and signature/ownership work; this CLI preserves the
existing explicit third-party handoff. Baseline's own signed updater remains
the only owner of its native self-update installation.
