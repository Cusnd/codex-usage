# Cloud sync v3: current contract and recovery

The backend and browser are deployed together; the desktop collector must match the current synchronization contract. This pre-release application supports one current protocol and storage format. It has no v1/v2 adapters, old-history fallback, migration jobs or automatic upgrade of older local databases. Older deployment and experiment reports describe their historical measurements, not the current contract.

## Required matching synchronization contract

`modules/contracts/sync-version.ts` defines `SYNC_VERSION` as protocol.schema.extractor: currently **3.1.2**. The collector, backend and browser use this exact current contract, without a supported-version range or compatibility table. Bump the affected component when the wire format or required shared parsing semantics change; UI-only edits and implementation-only optimizations do not bump it.

Requests send `X-Codex-Usage-Sync`. Authenticated `POST /api/v3/collector/handshake` records the device's reported contract. Missing or different versions receive HTTP 426 before decoding or receiving data. A downgrade replaces the report; rotating credentials clears it. A matching source fingerprint cannot bypass a mismatched contract.

`GET /api/v3/compatibility` unlocks browser statistics only when its contract and every bound, unrevoked device with retained history match the backend. Paused devices are included; device filters cannot bypass the check. The backend enforces data-read access. Login, binding and device administration remain available. A confirmed mismatch or authentication rejection unmounts private views; a transient network failure may retain the current session's previously verified content with a warning. A newly opened browser session must reach the backend to verify. A collector can subsequently go offline after reporting a matching contract; this is its last authenticated report, not continuous online verification. Retired endpoints return 404.

`scripts/build-version.mjs` still generates a package-version-plus-source fingerprint for diagnostics and deployment verification. `X-Codex-Usage-Build` and health `buildVersion` identify the deployed code; they do **not** decide synchronization access. Different package versions or source fingerprints with the same current contract are accepted. Backend/assets deploy together, and the deployment check verifies the source fingerprint to ensure the intended artifact reached production.

## Fresh storage

`cloud/migrations/0001_v3.sql` initializes an **empty D1 database** directly with current tables, indexes and triggers. The previous twelve-step migration chain has been squashed. It creates no v1 quota table, v2 usage-revision tables, legacy-head or preparation tables, or handoff receipt fields.

An environment using the previous migration chain requires fresh storage before this code is deployed. Applying the new initializer over it is unsupported. Deployment does not reset a database automatically. Provisioning a replacement database and switching the deployed application is a separate operational action.

Local `usage.sqlite` initializes current columns and `PRAGMA user_version=3`. A populated database with another version raises `LOCAL_SCHEMA_MISMATCH` before schema changes or conversion. Use an empty `CODEX_USAGE_DATA_DIR`, bind the current collector and re-collect original Codex logs. There is no automatic column backfill, INTEGER-to-TEXT conversion, extractor-v1 replay or v2-to-v3 handoff. Missing original logs cannot be reconstructed from a retired format.

The cloud browser is fully online and keeps query results only in session memory. It does not persist statistics, account observations or an entity mirror in IndexedDB or localStorage. On entry, it attempts to delete only this application's old `codex-usage-cloud-*` databases and last-user cache marker; it never opens or migrates their cached data, and storage cleanup failure does not block online reads. Authentication cookies and ordinary static-asset caching retain their separate purposes. See the [2026-09-13 browser simplification](design/cloud-browser-simplification-2026-09-13.md).

## Current collection and reliability

The collector projects an allowlist of native JSONL metadata and token records. Original titles and project paths are intentional synchronized data; chat text, tool bodies and credentials are excluded. Parsing native cumulative token-count records and inherited task prefixes is current input functionality, unrelated to old application protocol support.

`modules/sync/protocol/validate-upload.ts` validates the contract from `modules/contracts/sync.ts` and requires protocol 3, schema 1 and the exact current `EXTRACTOR_VERSION`. Content type is `application/vnd.codex-usage.v3+json+gzip`; limits are 512 KiB compressed, 1 MiB decoded, 500 records and 64 source checkpoints. Unknown metadata, including `legacy_replacement`, is rejected.

The source cursor and durable batch commit together. Local materialization and cloud upload acknowledge independently. Gzip bytes and hashes are persisted and reused on retry. `received` means input is durable and its receipt should be polled; `applied` means canonical effects are committed. Payloads are reclaimed after both consumers apply them. Realtime/backfill lanes have separate contiguous watermarks and source-order barriers. Cancellation, bounded retry and receipt polling remain current reliability behavior.

A rewritten source stages a new generation while its previous complete generation remains visible. Large replacements, inherited-parent corrections, origin assignments and device-history deletions use bounded resumable jobs. These jobs do not import retired formats. Source disappearance changes availability rather than deleting history.

The cloud reconciles observations globally before filtering execution origin. Upload ownership and execution origin differ; missing origin evidence stays unknown. Explicit user assignments are separate from observed evidence. Exact token arithmetic uses decimal storage and safe SQL or bounded BigInt processing.

## Online browser page reads

`POST /api/v3/view` accepts `{device_ids?: string[]}` and returns `PageRead {user_id, lease_id, cut, settings, expires_at}`. It snapshots the current published dataset, commit, deletion, organization and settings versions without counting entities or enumerating source coverage. Related usage queries, pagination and project labels send that lease and validate the returned cut. Account observations retain their own collection time rather than joining the usage cut.

The browser uses the existing in-memory query cache, with user, device scope, query parameters, timezone and read version isolation. It does not perform recent/full baseline downloads or consume manifest/entities/changes to build a local copy. Manual refresh requests a new page read and updates visible queries; configured intervals, focus and reconnect also refresh online results. No page refresh commands a collector to scan or upload.

`POST /api/v3/view/:lease_id/renew` accepts no body or `{}` and returns the same PageRead shape. It preserves the cut, settings and device scope, extending the 15-minute expiry only within the original 60-minute maximum. A newer head or ordinary rebuild does not invalidate an existing pinned read. Expired, deleted or otherwise unavailable reads return `BASELINE_REQUIRED`; the browser establishes a new read for the page instead of mixing old and new results. New reads are withheld while deletion or rebuilding prevents a ready published view.

A failed refresh may keep already displayed memory results with an error or offline notice. Reloading or reopening requires a connection; there is no durable offline data to restore. User or device changes cancel obsolete work. Logout and history invalidation discard private memory state, and deletion notifications invalidate other open tabs for that user; late responses cannot restore the discarded view.

The server still uses `v3_read_leases` and `v3_entity_versions` for fixed-version statistics, consistent publication and retention of pinned history. The former `/api/v3/sync/read` baseline, manifest/entities/renew and changes APIs remain available pending a separate dependency audit; the online browser no longer consumes them. Removing browser persistence does not itself remove server versions, change logs or their cleanup rules.

## Accounts and settings

`modules/contracts/cloud.ts` and `modules/contracts/cloud-accounts.ts` require `schemaVersion: 3`. `modules/accounts/publisher.ts` uses `/api/v3/collector/config`, `/api/v3/collector/pause` and `/api/v3/accounts/observations`. There is one full-history connection mode and no quota-only upgrade flow.

A per-user HMAC key groups confirmed accounts without uploading raw identity. Monotonic sequences protect retries and account switches. Failed reads retain measured values with explicit stale/error metadata. Daily history merges independently of quota freshness. Unknown identities stay separate. Account uploads allow 256 KiB and have a per-device 60-second throttle, independent of usage lanes.

Settings use `v3_settings` with no v2 user-column fallback. Operation IDs support idempotent replay, and pinned reads retain their settings. Standard/Fast attribution uses available native record and task-setting evidence; ambiguous or missing evidence stays unknown. Unknown-tier usage remains in raw tokens. Subscription/API pricing changes do not alter token totals or existing read cuts.

## Deploy and recover

Deploy the backend and browser together, and install a collector implementing the current synchronization contract. Initialize fresh storage for retired schemas, deploy backend/assets together, then bind collectors using the current contract. `--backend-first` is unsupported. Follow the project workflow for preview or publication authorization.

Pause retains history. Revocation invalidates uploads and retains history. Explicit history deletion removes the uploader's facts and account observations, reconciling surviving copies in bounded jobs. The one-minute scheduled handler advances durable work and cleans expired sessions, authorizations and read versions. Disabling the browser's display interval stops interval-driven page reads; collector uploads and server jobs continue independently.

After a network failure, resume the current queue and poll receipts. After a source rewrite, finish its new generation. Unsupported local storage requires an empty data directory and recollection. There is no old-format recovery adapter. Worker rollback alone changes neither storage nor the required collector/browser contract; select backend/assets and a collector contract that support the deployed storage.

## Verification boundaries

Report domain/local SQLite tests, workerd/D1 integration, packaged lifecycle checks, CUA browser flows and remote deployment separately. Local fixtures do not prove production deployment. Viewport checks do not prove physical-device behavior. Long-running and multi-machine collection require their own evidence.
