# Command execution

`runCommand(path, args, onOutputLine?, options?)` uses direct argv-based spawn,
ignores stdin, and drains separate stdout/stderr pipes concurrently. Existing
callers can keep their current signatures. `runBrewCommand` accepts options as
its third argument; `runMasCommand` accepts options as its second argument.

Options support an `AbortSignal`, `timeoutMs` (zero disables the deadline), an
inherited-environment overlay, `maxOutputBytes`, `capture` (`complete` or `tail`),
and `terminationGraceMs` (default 1 second), with `cleanupTimeoutMs` (default
3 seconds). Invalid limits are rejected before launch. Launch errors contain a safe executable basename and system error code,
without arguments, environment values, or private absolute paths. Results retain
`success`, `status`, `output`, `stdout` and `stderr`, and add optional `failure`,
`signal`, and `outputTruncated` fields. Callers should use `failure.message` when
explaining an execution failure; ordinary nonzero exit statuses retain their
original command output.

Complete capture defaults to 32 MiB per captured stream/combined transcript. If
the combined limit is exceeded, the command is stopped, success is false with an
`output-limit` failure, and stdout/combined output are empty. A parser must never
receive a silently truncated JSON document. Tail capture defaults to 1 MiB per
stream/combined transcript, retaining recent output and marking truncation. It
continues execution, so verbose successful mutations remain successful. Both
policies bound memory; combined output follows observed pipe event order, not a
claimed global order between writes on independent pipes.

Each pipe has its own incremental UTF-8 decoder. Progress callbacks receive
trimmed nonempty CR/LF lines and final unterminated output. Progress lines longer
than 16,384 UTF-16 code units are emitted in segments to bound pending memory.
ANSI sequences are preserved. Callback exceptions fail the command and trigger
cleanup without exposing the exception text.

On macOS/POSIX each command owns a detached process group. Cancellation, deadline,
output-limit failure, callback failure, and parent exit all await group cleanup.
Cleanup sends TERM, waits the grace period, then sends KILL and verifies exit
within a total 3-second cleanup budget. Normal settlement requires ESRCH to confirm group absence. On Darwin an unreaped
zombie-only group can transiently report EPERM: re-probe within the same budget,
without treating EPERM as cleanup success. Persistent permission errors, other
signalling errors, or a group that persists beyond the budget
return an explicit `cleanup` failure with unknown status, immediately quarantine
Homebrew, destroy the runner's owned pipe handles, and unreference the child
handle. This releases local execution handles without claiming the process exited.
A deadline therefore includes the additional cleanup budget before settlement;
cleanup uncertainty supersedes timeout/cancellation status. The operation owner
must quarantine its work lock and warn users to inspect remaining processes.
This boundary covers foreground CLI descendants, including
children holding inherited pipes open. Processes that deliberately start a new
session escape this boundary; do not use the runner to manage daemon lifetimes.
After ESRCH no further group signal is sent. POSIX numeric process-group APIs
cannot prevent ID reuse before the first signal; the runner keeps one shared
cleanup task and clears its deadline on settlement to avoid later signals to a
stale group. Baseline is macOS-only; the Windows fallback kills only the direct child.

Homebrew receives inherited proxy, certificate, locale, and custom configuration
variables, with the resolved executable directory prepended to PATH and system
binary directories supplied for Finder launches. No shell profile is sourced.
Homebrew remains responsible for its supported `brew.env` configuration. A UTF-8
LANG fallback is supplied only when LANG/LC_ALL are absent. The app passes
NONINTERACTIVE=1, HOMEBREW_NO_AUTO_UPDATE=1, HOMEBREW_NO_ANALYTICS=1,
HOMEBREW_NO_ENV_HINTS=1, NO_COLOR=1 and TERM=dumb; forced color controls are removed.
This is compatibility/output policy, not a sanitized security environment.

Known Homebrew reads (`list`, `info`, `outdated`, `--version`, `--prefix`, `config`,
`doctor`, `services info/list`) default to a 120-second deadline and complete
capture. All other commands, including `update`, `upgrade`, and `cleanup`, default
to tail capture without a deadline. Generic commands have complete capture and no
default deadline. `mas version` has a read deadline; other mas calls have tail
capture and no default deadline. Explicit options override capture/deadline.
Homebrew environment policy does not apply to mas or other tools.

Operation owners must retain the Homebrew reservation until the runner settles.
After confirmed cleanup, interrupted work requires inventory reconciliation before
releasing normal reservations. A `cleanup` failure means teardown was not confirmed:
quarantine the work lock, warn about remaining processes, and permit quitting after
local work settles. Do not attempt reconciliation while Homebrew is quarantined.
Abort signals are a backend capability; this change adds no UI cancellation control.
The Homebrew runner immediately latches a process-lifetime quarantine when cleanup
fails. `homebrewCleanupIsUnconfirmed()` exposes that latch to reservation owners,
including wrappers around legacy inventory callers that discard detailed failures. Subsequent Homebrew reads and mutations fail closed, including requests
already awaiting executable resolution. Restart clears only the in-process latch and does not prove that an orphaned
Homebrew process stopped. Inspect and stop any remaining Homebrew processes before
restarting and retrying. Commands already launched before quarantine still need
their own settlement.
