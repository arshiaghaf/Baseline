# Homebrew catalogue cache

The main-process formula and cask clients accept an optional `CatalogueStorage`
adapter. `FileCatalogueStorage(cacheRoot, kind)` stores disposable public metadata
under the supplied app-specific cache root; omitting it keeps the clients in
memory. App composition owns the cache root, including test-profile isolation.
It must not point at the snapshot/history directory itself.

Each kind has one versioned record containing the validated source payload,
payload digest, source URL, HTTP validators, cache policy, checked time and
freshness/stale deadlines. A private, exclusive temporary file is synced and
renamed over the record. Startup reads are bounded, reject symlinks, validate the
record, and rebuild the index with the current decoder. Missing, incompatible,
corrupt, expired or future-dated records cost a refetch. They do not affect user
state. Cache IO failures do not invalidate a usable network response.

Freshness is capped at ten minutes and stale fallback at 24 hours, accounting for
upstream `Age`/`Date`. `no-cache` and zero max-age trigger revalidation on the next
request, retaining the existing last-good fallback policy. `must-revalidate`
forbids fallback once freshness expires. `no-store` removes stored payloads and
validators and delivers only the current response. A 304 without a validated body
gets one unconditional retry with a fresh 12-second request timeout. Startup
preparation shares one promise independently of network revalidation. Cache-only
returns are never shared as a revalidation task: every forced caller bypasses
freshness/retry gates after preparation, while actual in-flight network work and
its atomic publication still coalesce.
Wall-clock rollback behind the checked time invalidates reusable metadata.

Downloads reject excessive `Content-Length` and stop/cancel the body reader when
actual decoded bytes exceed the kind's existing limit (25 MiB casks, 64 MiB
formulae). The cache record adds at most 8 KiB of metadata. When persistence is
enabled, one bounded source buffer is retained with the parsed index so a 304 can
atomically renew the complete record. Normalized search terms are built once per
index and held weakly with that index.

Remote catalogue decoding caps entry count, nesting, fanout, per-entry nodes and
string length. Valid entries survive partially malformed catalogues; an entirely
malformed nonempty replacement cannot erase a valid cache. Client
`cacheStatus.decode` exposes only bounded counts (`totalEntries`,
`skippedEntries`, `schemaWarnings`), with no rejected values or error transcripts.
The installed-cask mapper retains its tolerant behavior separately from strict
remote catalogue admission, so unrelated optional installed metadata cannot fail
an otherwise healthy inventory kind. Its evidence walker inspects known artifact,
app, target and identifier fields before unrelated branches, independently of JSON
key order. Known branches use a separate priority queue; bounded unknown maps and arrays
retain schema-drift support through a separate breadth-first fallback queue. It visits at most 20,000 containers, descends at most 32 container
levels, and inspects at most 2,048 array entries or unknown object fields per
container. Direct string-valued evidence arrays and artifact lists use the same
2,048-entry cap. Each queue holds at most 20,000 pending containers; optional data cannot occupy
known-evidence slots. Intrinsically oversized/deep evidence branches can be
truncated; traversal limits do not create new ownership evidence or reject other
healthy inventory entries.

`mergeCatalogueSearchResults` compares cask and formula relevance on one scale
before truncation, so exact formula matches precede unrelated cask prefixes.
Both original app bundle filenames and suffix-stripped names remain indexed, so
`.app` queries retain their matches while ordinary names can receive exact-match
ranking. Search scores stay in the main process and do not extend shared UI contracts.
Catalogue entries remain public lookup/discovery metadata. Installed ownership,
tap/alias verification, reservations and mutation authorization continue to use
installed inventory evidence.
