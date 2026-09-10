# Cloud quota deployment record

## 2026-09-10 — initial deployment

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
| Public HTTPS/DB/configuration health | Passed using the public DNS answer with the original HTTPS hostname and certificate verification |
| Real GitHub login, binding and production quota receipt | Pending local DNS resolution and browser authorization |
| Physical phone acceptance | Not performed; narrow browser viewports are the tested coverage |

At verification time the computer's DNS path through Mihomo returned NXDOMAIN for the newly created hostname, while Cloudflare and Google DNS-over-HTTPS both returned its public addresses. Requesting `/api/health` with that address and the original TLS hostname returned `{"ok":true,"schemaVersion":1,"loginConfigured":true}`. The custom domain and proxied DNS record are present in Cloudflare. A normal browser login has not yet been verified; do not treat health or mocked OAuth tests as proof that the real GitHub callback works.

## Complete the production check

After local DNS is refreshed, start the built local app with an isolated data directory, use `cloud connect` or Settings → 云端查看, and complete the real GitHub approval and binding. Verify that the cloud page shows the same quota windows and the original collection time, with a later cloud receipt time. Update this record with the actual result. The implementation's upload credential must remain local and must not be pasted into a browser, log or this record.

## Rollback

The previous compatible Worker/assets version is `02f0d99f-4ea0-4f76-a38e-9420030544c0`. Run `wrangler rollback VERSION_ID` from the `cloud` directory after selecting the intended version. Both versions use migration `0001_cloud.sql`. Rolling back Worker code does not undo D1 migrations or restore deleted user data. For an outage requiring the new service to stop, disable its custom-domain route after confirming the outage scope and preserve D1; do not delete the database as routine rollback. The local client can independently pause syncing and retains the latest cloud snapshot.
