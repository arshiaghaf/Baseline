# Administrator prompt helper (dormant)

The package includes an unused native `Contents/Resources/admin-askpass`
executable. No Homebrew command or renderer action currently enables it.
It is outside ASAR and built for the package's target architecture before signing.

The dormant lifecycle state machine tracks invocation completion independently
from cancellation and cleanup evidence. Operation snapshots retain target IDs and
waiting state through reconciliation, but are excluded from saved snapshots.
The command runner still does not create a status endpoint or set `SUDO_ASKPASS`.
Cancellation results already bypass mutation failure rows, banners, timers, and
saved failure details across update, batch, install and uninstall paths; inventory
refresh remains inside the command reservation. Cleanup uncertainty keeps its
separate safety notice and quarantine.

The helper uses a static AppleScript hidden-answer dialog. This is an
app-provided masked dialog, not the system authorization interface. Only the
native helper accesses the answer; its stdout must be connected directly to
sudo's askpass pipe. Never launch it with Node stdout capture or log its result.

The status socket uses 40-byte frames: `BAP1`, version byte 1, message byte,
two zero bytes, 16-byte operation ID, and 16-byte invocation/prompt ID. No text
payload exists. Messages 1–7 are hello, begin, dialog answered, dialog cancelled,
dialog error, invocation complete, and invocation error. Acknowledgments set
the high bit. Focus is 64; deny is 65. IDs must match the current operation and
invocation. Unknown, oversized, truncated or regressing messages fail closed.

Dialog answered is nonterminal. The helper waits for acknowledgment, writes the
entire answer and newline directly to sudo, closes stdout, then reports invocation
complete and waits for acknowledgment before exiting. Delivery failures after
dialog answered remain invocation errors. Neither completion nor a submitted
answer proves authentication or mutation success. Empty answers are submitted;
cancel is a separate outcome. Sudo controls retries.

A dedicated socket monitor observes peer loss while the script blocks. It exits
the owning helper on lost/invalid transport and handles correlated focus requests
only while its dialog is active. These mechanisms still require native desktop
verification; fixture tests do not prove actual dialog removal or foregrounding.

Before activation, the command coordinator must enforce admission, correlation,
status draining, orderly cancellation, process cleanup and reconciliation under
the Homebrew work reservation. Cancellation must immediately deny later prompts
for the operation without routinely killing an orderly completion handshake.
Cleanup uncertainty remains independent and must quarantine further work.

Every Homebrew command now checks configuration before launch and revalidates
file fingerprints immediately before execution. Homebrew's launcher filters
ordinary custom environment keys and can override `SUDO_ASKPASS` from `brew.env`.
Reserved metadata uses `HOMEBREW_BASELINE_ASKPASS_*`. Conflicting or ambiguous
configuration refuses commands, including reads, as configuration-blocked;
preserve unrelated settings, existing inventory and executable-presence evidence.
Never turn refusal into a successful empty inventory or a missing-Homebrew claim.
Preflight assumes ordinary stable user configuration and does not protect against
malicious same-user concurrent replacement. Do not bypass Homebrew configuration,
force `HOMEBREW_SUDO_CHECKED`, or claim Node's `NONINTERACTIVE=1` survives the
launcher. Preserve read deadlines and the absence of a default mutation deadline.

The supported parser matches the launcher's literal `read -r` assignment rules
for bounded ASCII files, including whitespace trimming, config precedence and
ignored final unterminated records. It never evaluates shell text. Nonregular,
unreadable, oversized, symlinked or unsupported files fail closed; FIFO opens are
nonblocking before type validation. Configuration refusal preserves installed
inventory as unverified evidence and requires a fresh successful inventory before
mutations resume. The unmodified pinned-launcher fixture covers the environment
filter and config overrides without running Ruby, sudo or any package operation.

Real credentials, native GUI lifecycle, sudo policy, and full Homebrew integration
remain explicit acceptance checks. Automated fixtures never establish those checks.
