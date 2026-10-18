# Profile history

Profile stats stay on this Mac. Baseline records updates and installs completed
through its own operation paths; opening an external updater does not count an
update as completed.

The latest 1,000 operation details are retained. Separate counters per target,
operation type, and source preserve recorded totals, unique apps, source mix,
and rankings when older details leave that window. Counter storage grows with
distinct target/type/source combinations, rather than with every operation.
Entries are not pruned to impose a fixed target limit, because that would lose
known counts. Each count and their combined sum must be positive safe integers
(with an empty aggregate list allowed); recording rejects numeric overflow
before publishing changes rather than rounding or reducing totals.

## Verification and compatibility

The existing version-2 event signature remains unchanged for compatibility with
older builds. A separate version-1 lifetime seal authenticates the counters and
coverage, and binds them to the current event signature. A present invalid,
malformed, unsupported, or mismatched aggregate envelope fails verification;
legacy event verification cannot authorize its counters. Valid older histories
without aggregate metadata migrate using only retained details, with visible
copy explaining that counts are a known minimum. Discarded operations are not
estimated.

An older build can still verify the event history without resetting valid dates
or events. Its loader does not preserve the new aggregate metadata, so saving
from that build removes it. Returning to a newer build then starts aggregate
coverage again from the retained event details as an explicitly labelled lower
bound. Counters for details already discarded before that old-build save cannot
be recovered. This snapshot format does not keep a separate checkpoint file.

The earlier draft's version-3 format is accepted only after verifying its full
signed payload, including aggregates; it then converts to the compatible pair
of seals. Failed version-3 verification never falls back to a legacy formula.

If the signing secret is unavailable, existing history is retained and new
activity cannot be recorded. Recovery verifies that history again before
appending. No recovery path rotates the existing secret.

## Event identities and duplicate scope

Deduplication covers IDs in the retained detail window and duplicate IDs in one
incoming batch. It is not lifetime idempotency: replaying the same ID after its
detail has aged out counts it again. A target's aggregate count cannot identify
which individual operations contributed to it.

Production app-update IDs include the app identity, versions/builds, and an
occurrence timestamp. Homebrew update/install IDs similarly include target,
version, and timestamp. These are generated in the main process at dispatch or
confirmed completion; there is no renderer method for supplying profile events
and no durable profile-event replay queue. A queued Homebrew app update may
carry its generated event through the operation; stopped-operation reconciliation
returns before the ordinary success-recording branch. Those paths do not
establish a normal replay of an old completed event after 1,000 later details,
but the statistics service does not promise to reject such a replay if a future
caller supplies one. No all-time receipt ledger or inferred discarded counts
are maintained.
