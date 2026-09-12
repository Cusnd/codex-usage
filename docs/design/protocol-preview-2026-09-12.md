# Current-protocol preview rollout — 2026-09-12

The user approved removal of historical compatibility, fresh cloud/local storage, and then refined version binding after reviewing the architecture: synchronize only with the current protocol/schema/extractor contract; use source fingerprints for diagnostics. Backend and browser deploy together. A UI-only update must not require a collector reinstall.

## Deployed artifacts

| Component | Verified value |
| --- | --- |
| Public application | `https://quota.esoren.com` |
| Sync contract | `3.1.2` — protocol 3, schema 1, extractor 2 |
| Main cleanup/collector source | `8030eab5c0e6f341d342a9ee3d2b34e615ff6993` |
| Final backend/browser source | `044daa3ee280c4a591130cb5baabf8a55bcaf6da` |
| Final Worker version | `29db4b4d-d328-416a-956d-eac4475d530e` |
| Final backend/browser fingerprint | `0.1.6+3cd1cd4a446acff1ddcdf656fdb248fd64296a632cb4eccf614155ba47201e44` |
| Installed collector fingerprint | `0.1.6+4533ef65ac05e2e81988877d221ad22b6aa49d6e86dd6f57cba19fcb5d93ac83` |
| New D1 | `codex-usage-current-20260912` / `2fd64d78-fcaa-41b5-8609-ea4171aa280f` |
| Current schema | `cloud/migrations/0001_v3.sql` |
| Collector package | `@esoren/codex-usage@0.1.6`, installed globally from a tested local archive |
| Archive integrity | `sha512-buq6t7aBySb6acEUMxM0gySXdmlUNInixoakW7RnpEeIKae6MTe9UOqoaFZx4TEIkW+kVoeudN8Iva2LJqm88g==` |

The first new Worker version was `5594a4d2-0f75-4ccf-8154-17b3fa6f95b2`. The subsequent browser-cache change scoped IndexedDB to `SYNC_VERSION` and produced the final Worker above. The collector remained running without reinstalling. Its different source fingerprint continued receiving successful applied receipts under the same `3.1.2` contract. The final deployed health response reports the current contract and fingerprint independently.

## Storage and installation

- Created the new empty D1 and initialized only the current schema. The old `codex-usage-cloud` database (`56edc711-905f-44d0-a6c1-93b7aea396b4`) remains untouched; no old usage, settings, accounts or device rows were imported.
- Stopped the previous local service through its authenticated control endpoint after verifying its identity. Moved the entire old `%LOCALAPPDATA%/CodexUsage` directory to `%LOCALAPPDATA%/CodexUsage-backup-20260912-protocol`, then verified the replacement default directory was empty.
- Preserved the previously installed package as a separate archive under ignored `artifacts/previous-package/`. Installed the tested current archive and started the service on the existing loopback port 8765. Managed autostart remains enabled and verified.
- Original Codex logs were preserved and re-collected. New browser storage is protocol-scoped and does not import the retired cache. Current login and device binding are established for the fresh cloud space.
- Build cleanup now removes only validated compiler output directories before emitting TypeScript. Both archive and actual global installation were checked for absence of retired `usage-sync` and `sync-v3/migration` modules.

## Validation

- Root domain/local suite: 209 passed, 4 platform skips, 0 failures (`artifacts/protocol-lock-root-tests.log`).
- Workerd/D1 integration: 14 files, 90 tests passed (`artifacts/protocol-lock-cloud-full.log`). Includes same protocol with different package/source fingerprints, mismatched protocol despite matching source fingerprint, missing versions, downgrade, device credential replacement, all-device enforcement and current-only schema/ingest.
- Final browser-cache/display regressions: 40 passed (`artifacts/protocol-cache-tests.log`).
- Type checks, application build, Worker dry-run, bundle/data boundaries, production smoke and exact archive installation/lifecycle smoke passed. Final archive check: `artifacts/protocol-lock-package-smoke-final.log`.
- Both preview deployments completed with the intended source commits, custom domain and one-minute scheduled job. Remote health and matching installed protocol were verified. No develop/main integration, release tag or npm publication was performed.
- Production evidence of different source fingerprints with uninterrupted synchronization is recorded in `artifacts/protocol-lock-different-builds-proof.json`. At that observation, live 51 and backfill 269 were both received and applied, with no synchronization error, after the browser/backend update.
- CUA observed the real bound device, current-protocol usage and fresh account observations in the complete cloud UI. Intermediate historical totals were explicitly partial while initial upload/cache download continued; they are not final-parity evidence.

## Completed initial recollection

- Two consecutive local observations at 13:58:53 and 13:59:23 UTC reported 234 sources, zero pending sources/tasks/batches, zero received-but-unapplied batches and no synchronization error. At the latter observation, live sequence 76 and backfill sequence 379 were both received and applied (`artifacts/protocol-lock-sync-drained.json`).
- The subsequent read-only remote D1 check confirmed all 234 active sources complete, 463 applied receipts, 22,480 canonical events, zero pending/running/failed jobs and zero retired v1/v2 tables. The one bound device reported contract `3.1.2` (`artifacts/protocol-lock-cloud-complete.json`). These are observed snapshots; the running collector continues adding current activity.
- Final CUA inspection showed “完整历史缓存已就绪”, completed at 10:03:40 America/New_York. Historical upload, cloud processing and the browser's complete-history cache all finished. The collector remains running with verified managed autostart.
- A separate existing display issue was observed: unnamed projectless sessions show an opaque logical project ID in the project index, while their detail heading says “未命名项目”. Read-only cloud metadata confirmed all 66 session-kind sources have no project name; all 16 Git/app sources have names. The source resolver and label helper are unchanged from the pre-cleanup base. This naming behavior was not changed as part of protocol binding and is not missing upload data.

Local logs and metric-only rollout evidence are under ignored `artifacts/protocol-lock-*`; secrets, original conversation logs and raw databases are not included in the repository. Existing user edits to `AGENTS.md` and untracked benchmark/experiment materials were preserved and excluded from commits.

The current architecture is documented in `docs/ARCHITECTURE.md`; protocol and recovery rules are in `docs/CLOUD_SYNC_V3.md`. CLI/config syntax was checked against the installed Wrangler help and the [official D1 command reference](https://developers.cloudflare.com/d1/wrangler-commands/).
