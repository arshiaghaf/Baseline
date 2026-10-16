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
gets one unconditional retry. Concurrent startup/network requests share work.
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
an otherwise healthy inventory kind.

`mergeCatalogueSearchResults` compares cask and formula relevance on one scale
before truncation, so exact formula matches precede unrelated cask prefixes.
Search scores stay in the main process and do not extend shared UI contracts.
Catalogue entries remain public lookup/discovery metadata. Installed ownership,
tap/alias verification, reservations and mutation authorization continue to use
installed inventory evidence.
