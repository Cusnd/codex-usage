# Cloud/collector version-lock implementation history — 2026-09-12

> Superseded after architecture review: access now checks the explicit synchronization contract in `shared/sync-version.ts`, not the source fingerprint. See `docs/CLOUD_SYNC_V3.md` and `docs/ARCHITECTURE.md` for the current design. The following records the earlier implementation and its verification before deployment.

Implemented in `codex/cloud-version-lock`, based on preview source `6c76685`. Changes remain uncommitted. This task did not deploy production, install a global collector, publish npm, reset live storage or perform GitHub integration. Existing user changes in `AGENTS.md`, benchmark materials and experiments were preserved.

## Why the previous preview displayed data

The referenced task, `全面优化 Codex Usage 性能`, established that its initial cloud rollout had not yet upgraded the local collector. Cloud storage already contained uploaded history, and that implementation retained v1/v2 paths, a v2 query fallback and conversion of stored history into v3. Those paths explained why the cloud could display history without a new v3 upload. This describes that initial rollout, not the current installation state of a collector managed by another task.

The initial version-lock implementation retained storage conversion. The user's subsequent instruction explicitly removed this requirement: there are no deployed users whose old application state needs conversion. The current implementation below supersedes that initial design.

## Current contract

- Local collector, backend and browser must carry the exact same generated package-version-plus-source fingerprint. Shipped source, locks and D1 schema participate; documentation, tests, credentials and local data do not. Windows text line endings are normalized.
- Authenticated collector requests reject missing, older or newer builds with HTTP 426 before decoding or storing a batch. A downgrade replaces the previous device report. Credential replacement clears the report. Local queued data is retained when synchronization is rejected.
- Cloud statistics require a matching browser and matching reports from every retained, unrevoked device, including paused devices. Device filters cannot bypass this rule. No matching bound collector keeps the panel locked. Login, binding and device administration remain available.
- The browser checks the backend before mounting statistics/cache, polls every 15 seconds and responds to request-level version rejection. A mismatch hides populated cached views. A matching collector may subsequently go offline; the check establishes its last authenticated version, not continuous online presence.
- Backend and browser assets deploy together. `--backend-first` is rejected. Deployment health verification checks the exact expected build. Collectors must be distributed from the same source snapshot.

## Removed implementation

- Public v1/v2 upload, quota snapshot and query handlers; the local v2 uploader and browser v2 query fallback.
- Old-history readers, staging, baseline migration, extractor-v1 replay, preparation/handoff journals and receipt metadata. Current v3 rejects old extractor versions and unknown migration metadata even when the application build matches.
- Quota-only connection and upgrade flow. Account observations/configuration/pause use current v3 endpoints; full history has one connection mode.
- The old D1 migration chain and retired tables. `cloud/migrations/0001_v3.sql` directly initializes current tables, indexes and triggers in an empty database.
- Automatic local database upgrades, column backfills and INTEGER-to-TEXT conversion. A populated unsupported database raises `LOCAL_SCHEMA_MISMATCH` before mutation. Current storage is tagged with `PRAGMA user_version=3`.
- Browser `legacy_ready` state and old checkpoint translation. The current cache uses a new database name without importing old cache data.
- Automatic Fast-price backfill for old saved API presets. Missing custom rates remain unconfigured instead of silently inheriting a rate.

Native Codex cumulative token-count parsing remains necessary input functionality. Current generation replacement, duplicate reconciliation, receipt retry, durable job resumption and same-schema database-file relocation also remain. None translates an old Codex Usage application protocol or storage schema.

## Storage and rollout boundary

The old preview D1 and old local database cannot be upgraded by this code. A future rollout requires fresh D1 storage and an empty local data directory, then recollection from original Codex logs by the matching collector. The deployment script never automatically resets remote data. A missing original log cannot be recovered through the removed adapters. Current deployments continue to use the D1 migration ledger for the current initializer.

See `docs/CLOUD_SYNC_V3.md` for the current protocol, account synchronization and recovery contract.

## Validation

- Root suite: **209 passed, 4 platform skips, 0 failures**; 213 tests (`artifacts/no-compat-root-tests-final.log`). Includes rejection of populated unsupported local storage without modification, current account synchronization and missing-rate behavior.
- Worker/D1 suite: **14 files, 89 tests passed** (`artifacts/no-compat-cloud-tests-final.log`). The real 100-job budget comparison initially exceeded Vitest's default 5-second timeout during concurrent verification. Its timeout is now 30 seconds; completion and query-budget assertions are unchanged. The full rerun passed. After final pricing cleanup, the affected billing and version-gate suites passed again: **11 tests** (`artifacts/no-compat-final-regressions.log`).
- Version tests cover absent/old/new builds, downgrade, stale browser, paused devices, filter bypass, credential replacement, retired endpoints, accepted current v3 ingest, rejected extractor-v1/migration metadata and absence of retired schema tables.
- CUA exposed date-time validator registration implicitly supplied by the deleted v2 query module. Registration now belongs to the current v3 query module. Real Worker tests cover dated summary, trend and filters, plus invalid dates.
- Local production build, cloud type check, cloud asset build, Worker dry-run, module/data boundaries and deployment preparation passed. Preparation performed no remote migration or deployment (`artifacts/no-compat-build-final.log`, `artifacts/no-compat-cloud-check-final.log`, `artifacts/no-compat-prepare-final.log`).
- Production API/assets smoke passed (`artifacts/no-compat-smoke.log`). Final package lifecycle smoke passed, including isolated installation, repeated/concurrent start, version mismatch, commands, data preservation, database-file relocation, recovery and stop (`artifacts/no-compat-package-smoke-final.log`). These checks used temporary installation/data paths.
- Final compiled local code, isolated Worker health body/header, production Worker bundle and browser bundle carry **`0.1.6+58c9294191c719b4928060000af7fe090bc2befe2a3ac8995da4a15f5eecc5da`** (`artifacts/no-compat-build-parity.json`).
- CUA used an isolated local Worker/D1 and synthetic current-protocol data: no version report locked the panel; matching handshake and real v3 gzip ingest unlocked **72K Tokens, 1 session, 1 turn**; an old build returned version rejection and automatically locked the populated cache; the named-device revoke confirmation could be cancelled; restoring the matching version reopened statistics. Reload and refresh with the final build displayed 72K without a date-filter or version error.

Browser fixture code is excluded from the production bundle. This evidence establishes local implementation behavior and packaging, not production enforcement, a physical-device rollout or long-running multi-machine collection. Test state and logs remain under ignored `artifacts/no-compat-*`.
