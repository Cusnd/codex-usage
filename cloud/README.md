# Private multi-device usage service

The production service is `https://quota.esoren.com`, running Worker `codex-usage-cloud` with one D1 database and the shared application UI. Cloud tooling is a separate private package; npm consumers install only the local application. Each GitHub user can bind multiple collectors. The service stores current v3 canonical observations and account snapshots, and never imports the original SQLite database. `usage.esoren.com` remains a redirect to the current computer; its local UI never reads cloud data.

The current code requires matching backend, browser and collector synchronization contracts, and fresh current storage. Previous deployments are recorded in [DEPLOYMENT.md](DEPLOYMENT.md); they do not imply this working tree has been deployed. See [the current v3 contract](../docs/CLOUD_SYNC_V3.md). Remote synthetic acceptance uses isolated Worker/D1 resources.

## Develop and verify

From the repository root:

```powershell
npm ci
npm ci --prefix cloud
npm run cloud:build
npm run cloud:check
npm run cloud:test
```

The cloud suite uses the official `@cloudflare/vitest-plugin` to run against workerd and D1 with isolated synthetic data. Root checks remain `npm run check`, `npm test`, `npm run build`, `npm run smoke`, and `npm run package:smoke`. Cloud tests run once in `.github/workflows/cloud.yml`, separately from the local platform matrix.

`cloud/wrangler.jsonc` is the production configuration. Regenerate Worker bindings after changing it using `npm --prefix cloud run types`; `worker-configuration.d.ts` contains generated runtime types, and `src/secrets.d.ts` declares the secret binding. Do not include a secret value in Wrangler vars.

For browser acceptance, generate the parity fixture with `npm run cloud:check`, build the root application and cloud assets, apply local fixture migrations, then start these commands in separate terminals:

```powershell
node scripts/cloud-browser-fixture.mjs A 8767
node scripts/cloud-browser-fixture.mjs B 8768
node cloud/node_modules/wrangler/bin/wrangler.js dev --config cloud/test/wrangler.browser.jsonc --port 18787
```

Apply all fixture migrations using `node cloud/node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local --config cloud/test/wrangler.browser.jsonc`. Open each local settings page through CUA, bind both synthetic devices, and follow the binding links. The fixture Worker supplies a synthetic login at `/auth/github`; its entry point, data and endpoints are excluded from the production bundle. Verify merged/single/multiple device views, navigation, full sessions, Agent links, pause, deletion, and narrow viewports. Browser acceptance uses CUA, without Playwright; viewport tests are not physical phone tests. Real production acceptance must separately complete GitHub OAuth, binding, receipt and offline history viewing.

For real local acceptance, use a separate `CODEX_USAGE_DATA_DIR` and port with the built CLI. The ordinary Codex login is read only by the existing local account provider; no special cloud access to Codex credentials is introduced.

## Provision and deploy

`preview` is the manual stage-preview branch for the existing `https://quota.esoren.com` service. An explicit request to update the preview saves and pushes the selected source snapshot, then runs `npm run cloud:preview` from the repository root. Ordinary pushes do not deploy and do not trigger GitHub CI. The command verifies the branch, committed deployment inputs and remote commit, and annotates the Worker version with its source SHA. It retains build, bundle and health checks without running the full CI suites. Use `-- --prepare-only` for preparation without remote writes. Backend and browser assets deploy together; `--backend-first` is retired. Every retained collector must use the current synchronization contract before the panel unlocks. See the [project workflow](../.agents/workflow.md#阶段预览).

The configured Cloudflare account must own the `esoren.com` zone and have Workers/D1 access. The initial database is named `codex-usage-cloud`. For a new environment create it using `wrangler d1 create codex-usage-cloud`, then set the resulting `database_id` in Wrangler configuration before deploying. Do not apply test fixtures to remote D1.

Register a GitHub OAuth App with:

- Homepage: `https://quota.esoren.com`
- Callback: `https://quota.esoren.com/auth/github/callback`
- No wildcard callback or GitHub device flow is required.

Set its public client ID in `vars.GITHUB_CLIENT_ID`. Enter the client secret into ignored `cloud/.dev.vars` as `GITHUB_CLIENT_SECRET=...`, or supply the secret in the deployment process environment. The deployment script injects it through Wrangler's secret configuration, removes its temporary secret file in `finally`, and never prints the value. Keep `.dev.vars` private and outside Git. Subsequent deployments can omit that file and preserve the existing Worker secret.

```powershell
npm --prefix cloud run deploy
```

Deploy Worker/assets together and use a collector implementing the current synchronization contract. Deploy with `npm --prefix cloud run deploy`, which initializes the current schema in a fresh database and verifies the exact build in the health response. Install the matching collector package on each bound device and start synchronization. Old or unreported synchronization contracts lock the panel. Different source fingerprints with the same current contract are accepted. See [the version contract](../docs/CLOUD_SYNC_V3.md#required-matching-synchronization-contract).

The script checks cloud types, builds assets, makes a dry-run Worker bundle, checks module/data boundaries, applies the current schema initializer, deploys the Worker with its custom domain, and verifies `/api/health`. A new domain may need DNS caches to expire. A completed Wrangler upload followed by a failed health check is reported as an incomplete verification, rather than as a ready service; inspect the recorded Worker version before deciding whether another upload is needed.

The health response must report `ok: true`, `schemaVersion: 3`, `usageProtocol: 3` and `loginConfigured: true`. The endpoint checks that current v3 storage can be prepared; it does not validate OAuth or statistics. Then verify real GitHub login, device confirmation, usage/account receipt and browser results. Record deployed version, migrations, acceptance and source branch in [deployment record](DEPLOYMENT.md). Deploying the Worker does not merge branches or publish npm. A trigger failure can occur after Worker upload succeeds: inspect `wrangler deployments list --json`, then repair only the triggers with `wrangler triggers deploy` when needed. Confirm the route and one-minute job/cleanup Cron before declaring deployment complete.

## State and recovery

`modules/contracts/cloud.ts` and `modules/contracts/cloud-accounts.ts` define current account observations with `schemaVersion: 3`. All cloud API endpoints use `/api/v3/`; v1/v2 aliases and quota-only collectors have been removed. Chat text, tool bodies, raw identities and credentials are excluded. API ownership comes from authenticated sessions/devices. Private responses use `Cache-Control: no-store`.

Version 3 uses `modules/contracts/sync.ts`: immutable gzip batches of at most 512 KiB compressed, 1 MiB decoded and 500 projected records. The local cursor and durable batch commit together; the local materializer and cloud uploader acknowledge independently. Received input is durable before an application job publishes canonical effects. Retries reuse bytes or poll receipts, and separate contiguous lane watermarks cannot skip a missing batch. Old source generations remain current until their replacements are complete.

V3 reconciles global observations before filtering by execution device. The shared query engine proves SQL aggregate ranges safe or falls back to bounded exact BigInt processing; casting an overflowed intermediate result to text is insufficient. Fixed read leases include project organization and settings versions. Browser manifests and entity hashes permit reuse, atomic cache progress and exact offline page-cache hits. DST buckets retain the selected timezone's real UTC boundaries.

Confirmed accounts use a per-user HMAC key available only to collectors. Sequences are monotonic across account switches; daily histories merge independently of quota. Unknown identities remain explicit. Account uploads have a per-device 60-second throttle, independent of usage batches.

Pause and revocation preserve history. Explicit device-history deletion revokes upload access, invalidates old reads and removes that uploader's observations and account copies. Bounded jobs reconcile facts that still have other uploaders; the UI distinguishes deletion in progress from completion. Device credentials cannot restore deleted history. Current complete history has no automatic expiration. The one-minute Cron advances durable jobs and bounded cleanup of expired sessions, authorizations and read versions. Monitor D1 storage and Worker/D1 usage in the existing Cloudflare account; retention is not a promise of unlimited free storage. No paid-plan upgrade is performed by the deployment script.

The schema is now `migrations/0001_v3.sql`, intended for an empty database. Environments using the removed v1/v2 chain require fresh storage and recollection of originals. Deployment never resets remote storage automatically. Unsupported local database versions are rejected; use an empty `CODEX_USAGE_DATA_DIR`.

Use `wrangler deployments list` to inspect versions. A rollback must pair backend, browser and collectors and support the deployed storage. Worker rollback does not roll back D1. See [recovery behavior](../docs/CLOUD_SYNC_V3.md#deploy-and-recover).

Primary references: [GitHub OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [Cloudflare Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), and [Worker rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).
