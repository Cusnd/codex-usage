# Cloud sync v3: storage, migration and recovery

This describes the unreleased development implementation. Production deployment, npm publication and acceptance are separate states. The [implementation record](design/multi-device-cloud-panel-implementation-progress-2026-09-11.md) identifies which checks actually ran. The [user guide](USER_GUIDE.md#view-quotas-from-another-device) describes the UI; [cloud operations](../cloud/README.md) covers infrastructure.

## Data path

```text
complete original record
  → whitelist projection + source position + record-chain hash
  → one local SQLite transaction: cursor + durable batch
    → local materializer → local queries
    → immutable gzip outbox → authenticated v3 ingest
      → durable receipt → bounded application job → published cloud version
        → fixed read lease → manifest / changed entities → IndexedDB transaction
          → fixed-version page query / previously cached exact result
```

`server/collector` is the normal collection path. File watchers prioritize new input; bounded directory reconciliation discovers missed changes. `localInterval=0` disables automatic collection; manual refresh still works. Complete records are processed within a captured EOF. An incomplete trailing line waits for completion. Raw record-chain hashing includes discarded lines, but the durable protocol retains only hashes and whitelisted metadata. Original Codex files are read only.

The collector source cursor and its durable projected batch commit together. Local application has a separate acknowledgement in the same transaction as its view changes. Cloud-disabled operation can reclaim locally applied input. Bound collectors retain unconfirmed input across process restarts and network failures. A first binding starts a full source baseline. Device and collector identity, producer epoch, source generation and immutable batch IDs prevent a restarted producer from silently reusing old positions.

The uploader persists the actual gzip bytes and their wire hash. Retries reuse those bytes. `received` means the server saved the input, so the client polls the receipt instead of recapturing the source; `applied` means the server durably applied it. Replacement generations and mapped legacy migration sources can remain staged until their complete handoff publishes the business view. Payload reclamation requires both local application and cloud application. Each realtime/backfill lane has separate contiguous received and applied sequence watermarks. Errors retain pending data and an observable status.

## Fast attribution upgrade

Extractor v2 retains the minimal service-tier settings and turn-lifecycle fields needed to identify Standard/Fast usage. It adds no chat or tool bodies. The compatible backend accepts both immutable extractor-v1 and extractor-v2 batches. Old batches keep their original JSON, gzip bytes, wire hashes and lane sequences; an upgrade does not rewrite pending uploads.

On the first run against a pre-v2 collector store, the collector marks existing sources for one new generation and reprocesses available originals. Complete old generations stay readable until each replacement completes. Stable event identities and origin proofs preserve raw Token totals and execution-device attribution. Native files without usable markers remain unknown; previously projected cloud history cannot reconstruct discarded mode fields if the original files have been deleted. Fixed read leases preserve their settings and events. A separate query computation revision invalidates obsolete calculated DTOs after an application upgrade without discarding source history.

Deploy the backend accepting both extractor versions before distributing the v2 collector. This change adds nullable local event metadata columns and a local extractor-version marker; the existing cloud event JSON needs no additional D1 migration beyond the v3 migration ledger. Verify source replacement completion and Standard/Fast/unknown counts after collection. The [billing upgrade record](design/fast-subscription-pricing-upgrade-2026-09-12.md) contains the local/cloud replay and CUA evidence; this workspace validation does not constitute a production deployment.

## Facts, precision and project identity

Multiple observations can support one canonical event. Strong response IDs or a trusted session plus its complete record-chain position identify a consumption event; independent events with equal token values stay independent. Canonical selection happens before the execution-device filter. Uploading a copy does not prove the uploader executed its old events. Origin evidence is selected separately from the most complete token observation; missing or conflicting origin remains unknown.

User assignments are stored in an independent operation ledger. They apply only to naturally unknown events without conflicting origin evidence, selected from a fixed all-device read lease. The canonical payload retains its natural origin and carries a separate `user_assignment` label; the versioned filtering column uses the effective assignment. Reliable evidence takes precedence when later observations establish the actual origin. Assign/revoke operations are idempotent and preserve the selected event set; large operations build a private epoch before publication. A target-device deletion revokes its assignments without deleting other uploaders' facts.

Source rewrite generations stage candidates and metadata. Publication replaces the previous source view only when the new generation is complete. Large replacements, inherited-parent corrections and legacy imports use resumable D1 jobs and a private next epoch. Old read leases continue against their original complete epoch when that is valid; a deletion invalidates affected reads. Source disappearance changes availability and does not delete history.

Token fields use decimal strings or null. Local token storage is TEXT. Queries prove their filtered SQL sums safe before using integer aggregation; otherwise bounded pages feed exact BigInt calculations. Precision applies to totals, sorting, non-cached input, costs, task/turn groups and Agent rollups. Missing components do not become fabricated zeroes. Large exact fallback queries can cost more than the SQL fast path and are included in performance limitations.

Source projects retain original path and App/Git evidence. Their identity includes the normalized source root so worktree paths remain distinguishable. Reliable repository or shared-session evidence can associate them with a logical project. Conflicting remotes do not force a merge. Manual groups, split constraints and aliases survive later automatic association. Project labels, membership and usage queries resolve at the same read version.

## Read versions and browser behavior

The server exposes a dataset epoch, commit sequence, deletion version, organization version and configuration version. A lease fixes these values for every query statement, manifest page and entity batch. The manifest uses stable keyset ordering; the browser checks revisions, content hashes, duplicate IDs, order and expected counts before marking a baseline complete.

The initial recent baseline covers the last 30 days with its required metadata. Its automatic full-history continuation shares the same cut. This completes an already requested version without bypassing a zero update interval. Later configured timer ticks and manual refreshes obtain new versions. Concurrent triggers coalesce; interrupted work resumes from persisted progress. Entity reuse compares ID, revision and hash, so unchanged bodies are neither downloaded nor rewritten unnecessarily.

IndexedDB separates entities, exact page-query results, synchronization state and incomplete commit staging. Its namespace includes origin, user and epoch. Each successful page query records its cut. Existing page results may remain on screen while a new baseline is prepared; labels must continue to come from that page's cut. A complete entity cache is not a general offline analytics engine: offline use is limited to already cached exact page/filter results. Authentication rejection and explicit deletion invalidate the corresponding private cache.

Cloud usage and account update intervals are independent of local collection intervals. Shared account queries do not inherit the usage-device filter. Accounts keep the compatible observation payload, stable per-user HMAC identity, monotonic source sequence and separate throttling; failures preserve the last measured success and its original collection time.

In system-timezone mode the browser sends its validated IANA timezone as query context. Manual mode uses the saved value. Resolved timezone participates in query cache keys and view revisions while the data cut remains fixed. Account observations instead use an origin/user cache and persistent refresh generations; a delayed response cannot repopulate a cache after deletion or a newer refresh.

## Migration sequence

The performance implementation collects all committed legacy heads into a private build before one rebuild and publication. It can resume the previous per-head checkpoint format by discarding only its unpublished epoch; the complete published history remains available. Bounded keyset scans avoid revisiting processed prefixes. A version fence rejects a build if committed heads change or retire before publication.

During an initial migration with an entirely committed v2 history, sync status may advertise `legacy_read_available`. The shared UI can then request the complete read-only v2 view using `legacy_fallback=1`; the server checks the same write version before and after its queries. This response identifies its user and does not claim a v3 cut or populate the fixed-version entity cache. Applied v3 contributions, retired heads, deleted history or an inconsistent legacy revision disable the compatibility reader. Active migration status is polled even when ordinary automatic refresh is disabled, so completion switches the page to a verified v3 baseline without a manual reload. This polling completes already initiated work; it does not enable local collection.

The `/api/v3/accounts` response includes its authenticated `user_id`; the browser verifies it before writing a namespaced account snapshot. Background HTTP job advancement uses the request execution context so persisted status can return before the work finishes. See the [performance report](design/performance-optimization-2026-09-12.md) for measured boundaries and the deployment state.

The cloud migrations are additive: `0003_sync_v3.sql` through the current migration head add v3 storage while preserving existing users, devices, settings and v2 facts. Use the migration ledger, not repeated execution of individual `ALTER TABLE` statements. Apply and validate the complete migration chain on a fresh database and a backed-up v2 database before an authorized production switch.

1. **Capture the baseline.** Save the deployed Worker version and migration ledger; export the existing D1 database into protected storage. For each collector, stop its service before taking a consistent backup of `usage.sqlite` and its identity/configuration files. Treat credentials and full paths as private. Record counts, token fields, titles, task relationships, settings and project choices separately.
2. **Add compatible cloud storage and backend.** Apply the additive migrations to the intended environment and retain v1/v2 routes. Existing current v2 revisions are adapted into v3 legacy observations. Origins with no proof stay unknown. An incomplete legacy baseline is not exposed as a complete new view.
3. **Start the v3 collector with its preserved identity.** The new materializer publishes a source's complete generation before replacing its old local mirror. Account scheduling and CLI behavior remain independent. Ordinary installation does not bind a cloud device or enable upload by itself.
4. **Prepare and perform explicit cloud handoff.** The local migration journal captures the original `(device, dataset, thread)` and mapped source files before old mirrors disappear. Before replaying any pending wire or polling its receipt, the uploader calls authenticated `POST /api/v3/legacy/prepare` with its collector and exact source generations. It rechecks preparation after selecting each immutable wire, so a scan that advances generations during an awaited preparation cannot upload an unprepared replacement. The bounded, additive preparation registers only heads owned by that device; it does not change immutable batch bytes or lane sequences. Those replacements remain staged while the complete old history stays readable. Only after every mapped source is available, complete and acknowledged as cloud-applied does the journal queue a legacy replacement marker. A private epoch then publishes the replacements and retires the old observations together. Missing original sources retain the old history and pending handoff; unrelated sources continue normally. Unknown mapping never authorizes deletion or weak identity matching by token similarity.
5. **Verify the same input.** Compare complete events and metadata, each token component, null/quality state, projects and parent/Agent relations. Compare global and selected execution-device results. Record intentional semantic differences with evidence; an equal grand total alone does not pass the migration.
6. **Switch the intended deployment only after acceptance.** This development task has not itself authorized or performed a production switch or npm release. A new cloud page obtains a versioned baseline. Keep v2 compatibility for at least the planned 30-day release window and until every unrevoked collector is accounted for; removal requires a later explicit release.

The local real-log exercise used a fixed-EOF snapshot of 219 source files (717,782,514 bytes) with 17,936 effective events. All compared event fields and six token totals matched the previous importer. It proves the tested local input's parity, not arbitrary future logs or remote performance. The cloud suite separately exercises interrupted replacement, legacy current-head import, explicit handoff, a later v2 revision and missing-proof retention. Exact run counts and artifacts are in the implementation record.

The preparation endpoint requires additive migration `0010_v3_legacy_pending_sources.sql`; durable handoff outcomes require `0011_v3_legacy_handoff_results.sql`. If an earlier v3 client already published a mapped partial replacement alongside v2 facts, preparation repairs the current view through a private epoch before the updated uploader continues. Existing read leases keep their original immutable snapshot, including any historical incorrect snapshot. A client without retained provenance cannot safely infer a replacement map; its history is preserved for explicit recovery. Deploy the compatible backend and migrations before enabling the updated uploader; an unavailable preparation endpoint retains the local queue and stops migration uploads.

An immutable backfill handoff can be overtaken by a newer source generation on the live lane. The server acknowledges that obsolete operation without retiring the legacy head or reactivating its older generation. Applied receipts persist optional `handoff_results` entries, identified by dataset and thread, with status `applied` or `superseded`. The updated uploader validates these outcomes; `superseded` returns the migration journal to waiting and queues a fresh handoff after current sources are applied, while the old packet and lane sequence finish normally. A local generation mismatch also prevents an outdated ACK from marking migration complete. The optional ACK field leaves ordinary upload receipts unchanged and remains readable by earlier clients that ignore extra response fields, but older clients do not implement the superseded-handoff recovery protocol.

## Recovery and rollback

| Situation | Supported response | Completion evidence |
| --- | --- | --- |
| Process/network interruption before acknowledgement | Restart the same collector with its retained identity and database; retry persisted bytes or poll received receipts | Contiguous applied progress advances and pending input is reclaimed only after both consumers finish |
| Rewritten source interrupted midway | Keep the last complete view while the new generation continues | Events and task metadata switch together when the source generation completes |
| Large cloud replacement interrupted | Resume the D1 job with request-driven work or the configured Cron | New epoch publishes completely; no mixed-generation result becomes current |
| Another device deletes history during replacement or legacy migration | Discard the superseded private build, retain valid received input and restart from the post-deletion head | The deleting state is not released early; the unaffected uploader eventually receives an applied acknowledgement |
| Received batch later fails permanently | Stop automatic receipt polling and surface the blocked state; preserve the local batch and immutable wire for reconnection/recovery | Other lanes can still apply; no false applied cursor or silent input removal |
| Missing old source during migration | Preserve its old structured cloud facts and pending handoff | An explicit complete mapped source later permits replacement; no weak-match deletion |
| Upload paused or device revoked | Preserve existing history; resume a paused device or complete new authorization after revocation | Device status and successful authenticated upload agree |
| User deletes uploaded history | Revoke the uploader and finish its bounded deletion job; invalidate stale reads and caches | Deletion job completes; other uploaders' copies remain; late old requests cannot restore it |
| Browser offline or interrupted | Reopen cached exact queries and resume persisted download progress on reconnect | Same-cut cached results or an explicit unavailable-query message; checked complete baseline |

Prefer a rollback to a known compatible application/Worker version that understands the v3 storage. Preserve the database and pending input. Investigate and halt a failing writer through the existing pause/revocation controls while retaining the last complete view. Do not delete migration tables or reset collector identity as a routine recovery step.

A v2-only binary cannot necessarily represent new v3 deletions, unknown origins or manual project organization. Restoring its old database or changing a read route is therefore not a proven lossless rollback. In particular, never reintroduce deleted upload facts from a pre-deletion backup. Reconcile post-backup writes and deletions before any separately authorized destructive restore. A production rollback rehearsal is still distinct from the isolated local/D1 tests.

## Verification boundaries

Test layers are reported separately: pure domain rules; local SQLite persistence and faults; workerd/D1 integration; real remote D1; CUA UI flows; packaged Windows/WSL lifecycle; remote CI; physical devices; long-running observation. Linux arm64, macOS on the final tree, the 30-job remote matrix, three physical execution machines and a 24-hour mixed workload require their own evidence. Single-machine simulations, a successful build and previous experiments cannot substitute for them.

The fixed-history 60-second line and daily-increment P90 of two seconds are engineering targets, not promised SLAs. Record raw-record availability, durable local batch, HTTP send, server receipt/application, browser receipt, IndexedDB commit and rendered-page availability separately. User-selected timer waiting remains part of the reported behavior. The 100k derived-input exercise must traverse the actual collector and v3 protocol and compare complete persisted results.
