# Backend integration

The main process composes the existing update policy with durable catalogue
storage, the bounded command runner, combined installed-info reads, and explicit
Homebrew diagnostics. Renderer source and visual behavior are unchanged.

## Reachable interfaces

- `UpdateStore` injects separate cask and formula `FileCatalogueStorage` adapters.
  Normal macOS caches live under `~/Library/Caches/com.arshiaghaf.baseline/catalogues`.
  `BASELINE_USER_DATA_DIR` isolates both state and disposable caches under the
  override directory. Cache loss never removes snapshots or recovery backups.
- Discovery uses the shared cross-kind ranker before applying its existing limit.
- `window.baseline.collectHomebrewDiagnostics({ doctor?, services? })` explicitly
  collects safe, bounded projections. Config runs by default; Doctor and services
  require their respective boolean flags. No collection runs during refresh or
  startup, and no repair action is available. The service validates requests;
  the new IPC handlers additionally require a known window's main frame and the
  exact application document URL. Reports are returned directly, never persisted.
  `renderHomebrewDiagnostics` supports explicit text export of the safe report.
- `window.baseline.getHomebrewInstalledContext(itemID)` returns only explanation
  flags and observed dependency/dependent counts. Caveat availability is exposed
  without copying its potentially private prose. Full receipt/dependency data is
  an ephemeral main-process sidecar. Failed reads revoke context, and current
  installed identity must still match. Counts are partial observations, never
  authorization for uninstall or update operations. `installedOnRequest` exposes
  only Homebrew's observed flag; false does not establish a historical dependency
  cause. Receipt counts describe formula keg records, not cask info versions.
- Existing diagnostic copy/export includes bounded catalogue decode counts.
  Rejected payloads and parser error text are excluded.

## Interruption and cleanup

Mutation reservations remain held through awaited runner settlement and inventory
reconciliation. Failed installations now reconcile too: partial installation may
have changed the target or dependencies. Cancellation, timeout, and signal
failures map to the existing private `interrupted` failure category. Uninstall
classification retains only a bounded output tail.

If process cleanup cannot be confirmed, the runner returns `cleanup` after its
bounded cleanup budget and quarantines further Homebrew execution for that
process lifetime. The store latches the same restriction before releasing the
reservation, clears executable update targets and metadata, and cancels queued
updates. Inventory sibling reads already started must settle before their shared
reservation is released; no fallback starts after cleanup uncertainty.

Quarantine remains visible in existing lock and notice fields. Once actual work
has settled, Baseline may quit. **Restarting only clears the local latch: inspect
and stop any remaining Homebrew processes before restarting.** Quarantine is not
proof that an operating-system process disappeared and cannot repair Homebrew.

## Audit scope and remaining decisions

| Audit recommendation | Implementation or disposition |
| --- | --- |
| Runner environment, launch diagnostics, UTF-8, bounded output, cancellation and deadlines | Runner helpers with real harmless subprocess and adversarial fake-process tests; mutation deadlines remain an explicit caller choice. |
| Durable validated catalogue, conditional requests, freshness, stale bounds, no-store and corruption recovery | Existing generic cache plus coherent atomic storage and bounded loading; composition injects isolated cache roots. |
| Download memory bound | Content-Length and streaming byte limits reject oversized bodies before full allocation; missing response bodies fail closed. |
| Inventory consolidation | Combined installed-info replaces two per-kind info reads on the healthy path, reducing six reads to five. Both lists remain: info can omit unloadable casks and canonical names do not preserve formula rack IDs. Greedy cask outdated checks remain separate. |
| Inventory performance | Reproducible fake-executable parity/process-cost probe only. No live Homebrew benchmark or measured product speedup is claimed. See `INVENTORY_TRANSPORT.md`. |
| Optional config, Doctor and services | Explicit typed collection with shared reservation, strict requests, deadlines and safe projections; services return aggregate counts. |
| Rich installed metadata and dependencies | Existing info payloads feed verified metadata and exact receipt-edge relationships; explicit safe context consumes the data. No formula removal or dependency safety gate is added. |
| Partial catalogue decode observability | Safe bounded counts are available in cache status and existing explicit diagnostics export; usable records survive optional-field drift. |
| Queue/concurrency and recovery | Existing reservations, identity revalidation, source precedence, persistence recovery and progress ordering remain authoritative. Focused integration tests cover interruption, quarantine, quit and privacy. |
| Automatic Baseline replacement/relaunch | Deferred pending install-provenance routing, trusted artifact verification/signing policy, privilege boundaries, rollback and durable outcome receipts. Existing release-page check remains; no version or release changes. |
| Crash assistance | Deferred pending evidence of relevant Electron crash/support volume and explicit consent/retention design. No system crash-log scanning, uploads or deletion. |
| Formula removal, pin controls, tap manager, Brewfiles, analytics discovery and service controls | Deliberate product expansion deferred; read-only metadata/diagnostics do not authorize new package mutations. |
| UI redesign, inspector, rendering optimization, native rewrite | Excluded from this backend work. |

All verification uses injected clients, fake executables, temporary caches/state
and the existing isolated Electron test providers. Production Homebrew packages,
the user's primary checkout and release preparation are not test fixtures.
