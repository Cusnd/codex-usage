# Cloud quota deployment record

## 2026-09-12 — manual preview branch, first v3 production rollout

- Channel: manual `preview` snapshots at the existing `https://quota.esoren.com`; ordinary pushes do not deploy. No develop/main integration, GitHub CI run, Git version tag or npm release was performed.
- Runtime source: [`089dd805badd814d49d7284a639eecececfe8f70`](https://github.com/Cusnd/codex-usage/commit/089dd805badd814d49d7284a639eecececfe8f70). The snapshot contains the current application sources and the manual preview command. Existing local `AGENTS.md` changes, experimental files and benchmark files were left outside the snapshot.
- Active Worker/assets version: `230a882c-1a25-4fdd-9738-f13f6c636c8e`, deployed at `2026-09-12T09:24:07Z`, with the source SHA in the deployment annotation.
- The compatible v3 backend with the previous public UI was deployed first as `9b4245f2-e5a9-4d40-b1c6-bea8b125e570`; its health check passed before switching the assets. This is the preceding same-backend/old-UI recovery candidate. The rollback action itself was not exercised.
- Applied additive migrations `0003_sync_v3.sql` through `0011_v3_legacy_handoff_results.sql` to the existing D1. A subsequent remote migration check reported no pending migrations. A pre-migration Time Travel bookmark is saved privately in `cloud/.deploy/preview-before-d1-bookmark.json`; do not reset the database as a routine Worker rollback.
- Local deployment checks passed: production Worker TypeScript, Vite cloud build, Wrangler dry-run and module/data-boundary checks. The production TypeScript configuration excludes test fixtures so a fresh source checkout does not depend on ignored generated test data. The existing health and legacy-visibility regression subset passed **9/9**; the complete suites and platform matrix were not run for this preview.
- Public verification: all **10 served HTML/JS/CSS/font files** matched the local build by SHA-256; `/api/health` returned `ok: true`, `schemaVersion: 2`, `usageProtocol: 3`, `loginConfigured: true`. Unauthenticated identity, v2 usage and v3 sync-status requests returned 401. Custom-domain routing and the one-minute Cron were confirmed by Wrangler.
- CUA with the existing authenticated Chrome session opened the new overview and settings. Account quota/history snapshots and both existing devices remained visible. A fresh OAuth round trip, collector upgrade and new v3 upload were not performed in this deployment task.

### Preview finding: initial legacy baseline blocks statistics

**Deployment succeeded; the usage-data page acceptance remains pending.** The new UI reports that its initial historical baseline is being built, so usage totals and trends are not yet available. The migration job advanced from 8 to 22 steps without an error code, with 2 of 219 legacy heads materialized at the observed checkpoint; this is not a completion or performance result. The original **219 usage heads and 19,319 usage records** were still present at the post-deployment check. Counts establish retained rows, not full semantic parity.

The rollout currently checks storage/health before enabling the new UI, but that check does not establish that existing users' baselines are ready. Before the next migration-style rollout, provide a usable old-data view during preparation or gate the UI cutover on baseline readiness. The broader performance work remains deferred; this preview has identified the user-visible first-load consequence. The known S05 narrow-device-menu issue also remains outside this deployment task.

Evidence is retained in ignored local artifacts: `artifacts/preview-deployment-20260912.log`, `artifacts/preview-public-verification-20260912.json`, `artifacts/preview-overview-20260912.png`, and `cloud/.deploy/preview-before-*` / `preview-after-deployments.json`. `gh run list --branch preview` returned an empty list after the snapshot push. This record does not claim completed historical migration, v3 production parity, full browser acceptance or a formal release.

---

## 2026-09-11 — shared UI and multi-device history

- Service: `https://quota.esoren.com`; Worker: `codex-usage-cloud`.
- Active Worker/assets version: `648df236-9507-4299-b617-f9a73d46bf39`.
- D1 remains `codex-usage-cloud` (`56edc711-905f-44d0-a6c1-93b7aea396b4`); incremental migration `0002_multi_device.sql` was applied remotely without replacing the database.
- Source: the `codex/cloud-quota` working tree based on `1afa3ca`. This task deployed the cloud service and ran the built local collector; it did not commit, push, merge, tag, or publish npm.
- Deployment order: compatible v1/v2 backend with captured previous public assets (`90c96399-39ae-4dea-8589-e84e72f7c2eb`), shared application UI, then a real v2 collector. Existing GitHub sessions, the old quota-only device and its last quota snapshot remained available.
- The custom domain and five-minute maintenance trigger were verified by Wrangler. Final public HTML and entry JavaScript hashes match `cloud/build`; HTML SHA-256: `8f209c80d87239cf773aef978a0e3c848b78ec23c231d121427a41961a92e05a`.

### Actual production acceptance

Real GitHub login succeeded through the user-approved CUA Chrome browser. The earlier `ERR_BLOCKED_BY_CLIENT` callback issue did not recur. The signed-in production application was used to approve a new full-usage collector while retaining the old device. No mocked login was used for this production check.

The real Windows collector completed all **211 / 211 parsed sessions**. At the frozen acceptance snapshot, event coverage was `2026-06-21T14:55:02.415Z` through `2026-09-11T04:52:20.112Z`. The collector's pending queue reached zero, and production device metadata reported `initialComplete: true` and no error. Titles and full project paths are within the user-approved scope; raw session files and the SQLite database were not uploaded.

A fixed UTC interval, `[2026-08-01T00:00:00Z, 2026-09-11T00:00:00Z)`, was queried from the stopped local SQLite database and the authenticated production v2 API. Both returned the same entire summary: 853 events, 26 sessions, 75 turns, 113,034,290 total tokens, and identical input/cache/output/reasoning fields and quality counts. Cost was disabled in this comparison to match the independent cloud setting; cost parity is covered by the synthetic SQLite/D1 suite.

The managed collector was then kept stopped. At `2026-09-11T04:57:59Z`, the cloud still returned the same historical summary and all 211 sessions, with last receipt `2026-09-11T04:53:56.476Z`. The UI showed “设备离线或未更新” and the API included the retained-history warning. The current built collector was restarted afterwards, reused its binding and checkpoint, received a new cloud acknowledgement, and returned to zero pending sessions. Existing local refresh settings, enabled cost display, and disabled OS autostart were preserved.

`https://usage.esoren.com/` was opened through CUA and still redirected to `http://127.0.0.1:8765/`. That page showed local record analysis with no cloud device selector or cloud identity header. The cloud page loads the shared full application, defaults to all devices, and reads only authenticated cloud APIs.

### Verification coverage for this change

| Check | Result |
| --- | --- |
| Root tests | 82 passed; 3 macOS-only tests skipped on Windows |
| Worker/D1 tests | 25 passed, including the existing v1 compatibility suite |
| Native SQLite versus D1 parity | 33 scenarios across A, B and A+B scopes; summary, DST hour/day trends, costs, projects, sessions, 200-row pages, turns, Agent relations, comparison, nulls and tokens above the JS safe integer limit |
| Reliable synchronization | Interrupted chunks and acknowledgements, persisted restart, exact retry, correction of old history, stale revisions, pause/cancellation, rebinding, revocation, deletion and late writes covered |
| Account identity and isolation | Same-account deduplication, distinct and unknown accounts, switching, failure retention, historical-day retention, sequence races and cross-user isolation covered |
| Privacy boundary | Strict upload schemas reject extra fields; synthetic raw bodies/account IDs excluded from the wire; shared account key unavailable to browser sessions; cloud bundle checked for fixture secrets and server-only imports |
| Builds | Root TypeScript/production build, cloud check/build and synthetic showcase build passed |
| Runtime and packaging | Production smoke and npm installation/lifecycle smoke passed |
| CUA UI acceptance | Login and binding; default merged view; A, B and explicit A+B selection; navigation, session/turn drilldown and Agent links retain scope; independent pause/resume; cloud and local data separation |
| Responsive browser acceptance | Desktop 1280 px plus 390 px and 320 px CSS viewports; no page-level horizontal overflow in the inspected task and device-management views; wide tables keep their internal scroll container |
| Production HTTPS and access control | Schema v2 health passed; HTML/JS match built files; private usage API returns 401 without a session |

Physical-phone testing and a second real computer were not performed. Two independent synthetic collectors provided the multi-device acceptance data. No npm release or remote Git CI was initiated.

### Compatible rollback

The verified preceding v2 Worker/assets version is `4697a7e0-2a5f-4106-9c08-94489928e50c`. It uses the same migrated database and differs from the final version only in device-selector accessibility labels and the cloud settings description. Use `wrangler rollback 4697a7e0-2a5f-4106-9c08-94489928e50c` from `cloud` if this UI update needs rollback. Preserve D1 and migration `0002_multi_device.sql`; a Worker rollback does not reverse schema changes or restore deleted history. Pre-v2 versions listed below are historical and are not the rollback target for the migrated database.

---

## 2026-09-10 — initial deployment

The remainder records the original deployment and its then-pending OAuth check. The 2026-09-11 acceptance above supersedes that pending status and the old rollback instructions.

- Service: `https://quota.esoren.com`
- Worker: `codex-usage-cloud`
- Active Worker version: `538b20bd-1a0c-4780-aa14-c55beabf19e9`
- Initial version: `02f0d99f-4ea0-4f76-a38e-9420030544c0`
- D1: `codex-usage-cloud`, ID `56edc711-905f-44d0-a6c1-93b7aea396b4`
- Migration: `0001_cloud.sql`, applied remotely; subsequent deployment found no pending migration.
- Source branch: `codex/cloud-quota`, based on `origin/develop` commit `bdfae03630703f0f8754af43b14a2310b17a41bd`, developed in a separate worktree.
- GitHub OAuth App registered with the fixed production callback; client secret injected as a Worker secret and excluded from Git.
- This is a cloud deployment. It does not publish a new npm version or merge the implementation branch.

## Verification coverage

| Check | Result |
| --- | --- |
| Root TypeScript check and production build | Passed |
| Root tests | 77 passed, 3 macOS-only tests skipped on Windows |
| Production smoke | Passed |
| npm package install/lifecycle smoke | Passed |
| Worker TypeScript check and official Cloudflare Vitest runtime/D1 suite | 14 passed |
| Quota schema and sensitive synthetic-field exclusion | Passed; no fixture secrets, local account IDs, local service or showcase modules in cloud artifacts |
| D1 concurrent writes, 60-second per-user window, exact retries and stale sequence rejection | Passed |
| Pending outbox recovery, coalescing, identity changes, normalized collection errors, pause and offline revocation | Passed |
| OAuth state/PKCE/cookies, replay rejection, expiry, device replacement, logout and cross-user isolation | Passed in synthetic Worker tests |
| CUA in-app browser synthetic binding, local settings, pause/resume, cloud dashboard and logout/login | Passed |
| CUA 320 px, 390 px and 1280 px viewports | Passed: cards retained, no horizontal overflow, unknown values preserved, past reset time marked as awaiting confirmation |
| Background collection with the synthetic dashboard tabs closed | Passed: observed a new collection and subsequent cloud receipt after closing the tabs |
| Real local Codex account collection | Passed through App Server with confirmed identity and two quota buckets; private values are not included in this record |
| Public HTTPS/DB/configuration health | Passed over normal DNS/HTTPS after clearing the local DNS cache; deployed HTML hash matches the built cloud entry |
| Real GitHub permission screen | Passed: authorized the intended app with public data only, no repository scopes |
| Real GitHub callback, binding and production quota receipt | Pending: both the in-app browser and the user-approved CUA Chrome attempt block callback navigation with ERR_BLOCKED_BY_CLIENT; manual browser login is required to continue acceptance |
| Physical phone acceptance | Not performed; narrow browser viewports are the tested coverage |

The computer initially retained an NXDOMAIN result for the new hostname. Clearing Mihomo's DNS cache restored resolution; normal HTTPS requests from curl and Node now return `{"ok":true,"schemaVersion":1,"loginConfigured":true}`. The custom domain, proxied DNS record and deployed asset content are verified. The real GitHub authorization page shows the intended app and public identity scope. The in-app browser then blocks `/auth/github/callback`; CUA network diagnostics report `net::ERR_BLOCKED_BY_CLIENT` with blocked reason `inspector`. A subsequent Chrome attempt, explicitly approved by the user as an exception to in-app acceptance, reached the same callback path and displayed `ERR_BLOCKED_BY_CLIENT`. The callback page was handed off for manual login without altering browser protections. The production login session has not yet been verified; do not treat health or mocked OAuth tests as proof that the callback works.

## Complete the production check

Use the built local app with an isolated data directory, use `cloud connect` or Settings → 云端查看, and complete GitHub login and binding in a user-approved browser that allows the callback. Verify that the cloud page shows the same quota windows and the original collection time, with a later cloud receipt time. Update this record with the actual result. The implementation's upload credential must remain local and must not be pasted into a browser, log or this record.

## Rollback

The previous compatible Worker/assets version is `02f0d99f-4ea0-4f76-a38e-9420030544c0`. Run `wrangler rollback VERSION_ID` from the `cloud` directory after selecting the intended version. Both versions use migration `0001_cloud.sql`. Rolling back Worker code does not undo D1 migrations or restore deleted user data. For an outage requiring the new service to stop, disable its custom-domain route after confirming the outage scope and preserve D1; do not delete the database as routine rollback. The local client can independently pause syncing and retains the latest cloud snapshot.
