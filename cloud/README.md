# Private multi-device usage service

The production service is `https://quota.esoren.com`, running Worker `codex-usage-cloud` with one D1 database and the shared application UI. Cloud tooling is a separate private package; npm consumers install only the local application. Each GitHub user can bind multiple collectors. The service stores parsed usage revisions and account snapshots, and never imports the original SQLite database. `usage.esoren.com` remains a redirect to the current computer; its local UI never reads cloud data.

This development tree adds v3 collection, canonical facts, versioned reads, project organization and browser caching. These source changes do not establish that production or npm has been updated. See [v3 storage and migration](../docs/CLOUD_SYNC_V3.md) and the [current acceptance record](../docs/design/multi-device-cloud-panel-implementation-progress-2026-09-11.md). Use new isolated Worker/D1 resources for remote synthetic acceptance; never seed fixture users into the production database.

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

`preview` is the manual stage-preview branch for the existing `https://quota.esoren.com` service. An explicit request to update the preview saves and pushes the selected source snapshot, then runs `npm run cloud:preview` from the repository root. Ordinary pushes do not deploy and do not trigger GitHub CI. The command verifies the branch, committed deployment inputs and remote commit, and annotates the Worker version with its source SHA. It retains build, bundle and health checks without running the full CI suites. Use `-- --prepare-only` for preparation without remote writes, or `-- --backend-first` for the first compatible v3 rollout. See the [project workflow](../.agents/workflow.md#阶段预览).

The configured Cloudflare account must own the `esoren.com` zone and have Workers/D1 access. The initial database is named `codex-usage-cloud`. For a new environment create it using `wrangler d1 create codex-usage-cloud`, then set the resulting `database_id` in Wrangler configuration before deploying. Do not apply test fixtures to remote D1.

Register a GitHub OAuth App with:

- Homepage: `https://quota.esoren.com`
- Callback: `https://quota.esoren.com/auth/github/callback`
- No wildcard callback or GitHub device flow is required.

Set its public client ID in `vars.GITHUB_CLIENT_ID`. Enter the client secret into ignored `cloud/.dev.vars` as `GITHUB_CLIENT_SECRET=...`, or supply the secret in the deployment process environment. The deployment script injects it through Wrangler's secret configuration, removes its temporary secret file in `finally`, and never prints the value. Keep `.dev.vars` private and outside Git. Subsequent deployments can omit that file and preserve the existing Worker secret.

```powershell
npm --prefix cloud run deploy
```

For the initial shared-UI migration, use `npm --prefix cloud run deploy -- --backend-first`. It captures only the existing public same-origin static assets, applies incremental migrations, deploys the compatible backend with that UI, verifies schema version 2, then deploys the shared UI. Existing Worker secrets are preserved when no secret file is supplied. Enable updated collectors after the compatible backend is live.

The script checks cloud types, builds assets, makes a dry-run Worker bundle, checks module/data boundaries, applies additive remote migrations, deploys the Worker with its custom domain, and verifies `/api/health`. A new domain may need DNS caches to expire. A completed Wrangler upload followed by a failed health check is reported as an incomplete verification, rather than as a ready service; inspect the recorded Worker version before deciding whether another upload is needed.

The health response must report `ok: true`, the compatible `schemaVersion: 2` envelope, `usageProtocol: 3` and `loginConfigured: true`. The endpoint checks that current v3 storage can be prepared; it does not validate OAuth or statistics. Then verify real GitHub login, device confirmation, usage/account receipt and browser results. Record deployed version, migrations, acceptance and source branch in [deployment record](DEPLOYMENT.md). Deploying the Worker does not merge branches or publish npm. A trigger failure can occur after Worker upload succeeds: inspect `wrangler deployments list --json`, then repair only the triggers with `wrangler triggers deploy` when needed. Confirm the route and one-minute job/cleanup Cron before declaring deployment complete.

## State and recovery

`shared/cloud.ts` defines compatible v1 quotas (64 KiB and 32 buckets). `shared/usage-sync.ts` defines strict v2 metadata, with at most 200 events and 256 KiB per chunk, accounting for UTF-8 paths. V2 includes original titles, full paths, identifiers, event/token metadata, relationships and account history. Chats, tool bodies, raw session files, raw account identities and credentials are excluded. The server can read the uploaded statistics: this is not end-to-end encryption. API ownership comes from authenticated sessions/devices, never a user ID supplied in the body. Device tokens are hashed in D1; polling uses a separate secret. GitHub tokens are discarded after login. Private responses use `Cache-Control: no-store`; invocation logging remains disabled and application errors exclude exception bodies, query strings and credentials.

Version 3 uses `shared/sync-v3.ts`: immutable gzip batches of at most 512 KiB compressed, 1 MiB decoded and 500 projected records. The local cursor and durable batch commit together; the local materializer and cloud uploader acknowledge independently. Received input is durable before an application job publishes canonical effects. Retries reuse bytes or poll receipts, and separate contiguous lane watermarks cannot skip a missing batch. Old source generations remain current until their replacements are complete.

V3 reconciles global observations before filtering by execution device. The shared query engine proves SQL aggregate ranges safe or falls back to bounded exact BigInt processing; casting an overflowed intermediate result to text is insufficient. Fixed read leases include project organization and settings versions. Browser manifests and entity hashes permit reuse, atomic cache progress and exact offline page-cache hits. DST buckets retain the selected timezone's real UTC boundaries.

Confirmed accounts use a per-cloud-user common HMAC key available only to collectors. Account sequences are monotonic across account switches; daily histories merge independently of the selected latest valid quota. Unknown identities remain explicit. V2 quotas have a device-level 60-second throttle, separate from history chunks; v1 keeps its per-user throttle. Legacy per-binding account references are labeled quota-only and cannot be guessed equivalent to v2 account references.

Pause and revocation preserve history. Explicit device-history deletion revokes upload access, invalidates old reads and removes that uploader's observations and account copies. Bounded jobs reconcile facts that still have other uploaders; the UI distinguishes deletion in progress from completion. Device credentials cannot restore deleted history. Current complete history has no automatic expiration. The one-minute Cron advances durable work and bounded cleanup of expired sessions/authorizations, superseded revisions and abandoned uncommitted revisions. Revision metadata is deleted only after its child rows are reclaimed. Monitor D1 storage and Worker/D1 usage in the existing Cloudflare account; retention is not a promise of unlimited free storage. No paid-plan upgrade is performed by the deployment script.

Use `wrangler deployments list` to inspect versions and `wrangler rollback VERSION_ID` to restore a compatible Worker/assets version identified in the deployment record. Wrangler rollback does not undo D1 migrations. Migration `0002_multi_device.sql` preserves users, sessions, bindings and quotas while adding revisions and multiple devices. Applied migration files are immutable; subsequent schema changes require a new forward migration. Pause affected collectors during incident recovery and preserve D1. Database deletion is not a rollback procedure.

Primary references: [GitHub OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [Cloudflare Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), and [Worker rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).
