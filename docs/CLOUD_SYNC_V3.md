# Cloud sync v3: current contract and recovery

The backend and browser are deployed together; the desktop collector must match the current synchronization contract. This pre-release application supports one current protocol and storage format. It has no v1/v2 adapters, old-history fallback, migration jobs or automatic upgrade of older local databases. Older deployment and experiment reports describe their historical measurements, not the current contract.

## Required matching synchronization contract

`shared/sync-version.ts` defines `SYNC_VERSION` as protocol.schema.extractor: currently **3.1.2**. The collector, backend and browser use this exact current contract, without a supported-version range or compatibility table. Bump the affected component when the wire format or required shared parsing semantics change; UI-only edits and implementation-only optimizations do not bump it.

Requests send `X-Codex-Usage-Sync`. Authenticated `POST /api/v3/collector/handshake` records the device's reported contract. Missing or different versions receive HTTP 426 before decoding or receiving data. A downgrade replaces the report; rotating credentials clears it. A matching source fingerprint cannot bypass a mismatched contract.

`GET /api/v3/compatibility` unlocks browser statistics only when its contract and every bound, unrevoked device with retained history match the backend. Paused devices are included; device filters cannot bypass the check. The backend enforces data-read access. Login, binding and device administration remain available. A failed check unmounts statistics and cached views. The browser must reach the backend to verify; a collector can subsequently go offline after reporting a matching contract. This is its last authenticated report, not continuous online verification. Retired endpoints return 404.

`scripts/build-version.mjs` still generates a package-version-plus-source fingerprint for diagnostics and deployment verification. `X-Codex-Usage-Build` and health `buildVersion` identify the deployed code; they do **not** decide synchronization access. Different package versions or source fingerprints with the same current contract are accepted. Backend/assets deploy together, and the deployment check verifies the source fingerprint to ensure the intended artifact reached production.

## Fresh storage

`cloud/migrations/0001_v3.sql` initializes an **empty D1 database** directly with current tables, indexes and triggers. The previous twelve-step migration chain has been squashed. It creates no v1 quota table, v2 usage-revision tables, legacy-head or preparation tables, or handoff receipt fields.

An environment using the previous migration chain requires fresh storage before this code is deployed. Applying the new initializer over it is unsupported. Deployment does not reset a database automatically. Provisioning a replacement database and switching the deployed application is a separate operational action.

Local `usage.sqlite` initializes current columns and `PRAGMA user_version=3`. A populated database with another version raises `LOCAL_SCHEMA_MISMATCH` before schema changes or conversion. Use an empty `CODEX_USAGE_DATA_DIR`, bind the current collector and re-collect original Codex logs. There is no automatic column backfill, INTEGER-to-TEXT conversion, extractor-v1 replay or v2-to-v3 handoff. Missing original logs cannot be reconstructed from a retired format.

The browser uses a current IndexedDB database name, with no `legacy_ready` phase or old checkpoint translator. Retired cache databases are not used.

## Current collection and reliability

The collector projects an allowlist of native JSONL metadata and token records. Original titles and project paths are intentional synchronized data; chat text, tool bodies and credentials are excluded. Parsing native cumulative token-count records and inherited task prefixes is current input functionality, unrelated to old application protocol support.

`shared/sync-v3.ts` requires protocol 3, schema 1 and the exact current `EXTRACTOR_VERSION`. Content type is `application/vnd.codex-usage.v3+json+gzip`; limits are 512 KiB compressed, 1 MiB decoded, 500 records and 64 source checkpoints. Unknown metadata, including `legacy_replacement`, is rejected.

The source cursor and durable batch commit together. Local materialization and cloud upload acknowledge independently. Gzip bytes and hashes are persisted and reused on retry. `received` means input is durable and its receipt should be polled; `applied` means canonical effects are committed. Payloads are reclaimed after both consumers apply them. Realtime/backfill lanes have separate contiguous watermarks and source-order barriers. Cancellation, bounded retry and receipt polling remain current reliability behavior.

A rewritten source stages a new generation while its previous complete generation remains visible. Large replacements, inherited-parent corrections, origin assignments and device-history deletions use bounded resumable jobs. These jobs do not import retired formats. Source disappearance changes availability rather than deleting history.

The cloud reconciles observations globally before filtering execution origin. Upload ownership and execution origin differ; missing origin evidence stays unknown. Explicit user assignments are separate from observed evidence. Read leases pin dataset, commit, deletion, project organization and settings versions. Manifests and hashes enable entity reuse; browser progress commits atomically. A full baseline can extend a recent lease at the same cut. Deletion invalidates affected leases. Exact token arithmetic uses decimal storage and safe SQL or bounded BigInt processing.

## Accounts and settings

`shared/cloud.ts` and `shared/cloud-accounts.ts` require `schemaVersion: 3`. `server/account-sync.ts` uses `/api/v3/collector/config`, `/api/v3/collector/pause` and `/api/v3/accounts/observations`. There is one full-history connection mode and no quota-only upgrade flow.

A per-user HMAC key groups confirmed accounts without uploading raw identity. Monotonic sequences protect retries and account switches. Failed reads retain measured values with explicit stale/error metadata. Daily history merges independently of quota freshness. Unknown identities stay separate. Account uploads allow 256 KiB and have a per-device 60-second throttle, independent of usage lanes.

Settings use `v3_settings` with no v2 user-column fallback. Operation IDs support idempotent replay, and pinned reads retain their settings. Standard/Fast attribution uses available native record and task-setting evidence; ambiguous or missing evidence stays unknown. Unknown-tier usage remains in raw tokens. Subscription/API pricing changes do not alter token totals or existing read cuts.

## Deploy and recover

Deploy the backend and browser together, and install a collector implementing the current synchronization contract. Initialize fresh storage for retired schemas, deploy backend/assets together, then bind collectors using the current contract. `--backend-first` is unsupported. Follow the project workflow for preview or publication authorization.

Pause retains history. Revocation invalidates uploads and retains history. Explicit history deletion removes the uploader's facts and account observations, reconciling surviving copies in bounded jobs. The one-minute scheduled handler advances durable work and cleans expired sessions, authorizations and read versions. Initial synchronization polling continues when ordinary display refresh is disabled.

After a network failure, resume the current queue and poll receipts. After a source rewrite, finish its new generation. Unsupported local storage requires an empty data directory and recollection. There is no old-format recovery adapter. Worker rollback alone changes neither storage nor the required collector/browser contract; select backend/assets and a collector contract that support the deployed storage.

## Verification boundaries

Report domain/local SQLite tests, workerd/D1 integration, packaged lifecycle checks, CUA browser flows and remote deployment separately. Local fixtures do not prove production deployment. Viewport checks do not prove physical-device behavior. Long-running and multi-machine collection require their own evidence.
