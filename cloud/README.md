# Cloud quota service

The production service is `https://quota.esoren.com`, running Worker `codex-usage-cloud` with one D1 database and bundled static assets. Cloud tooling is a separate private package; npm consumers install only the local application. This service stores the latest quota snapshot for each GitHub user, with one active collecting device. It does not import local usage databases.

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

For browser acceptance, build the root application and cloud assets, then start these two commands in separate terminals:

```powershell
node scripts/cloud-browser-fixture.mjs
node cloud/node_modules/wrangler/bin/wrangler.js dev --config cloud/test/wrangler.browser.jsonc --port 18787
```

Apply `cloud/migrations/0001_cloud.sql` to the fixture's local D1 before first use with `wrangler d1 migrations apply DB --local --config cloud/test/wrangler.browser.jsonc`. Open `http://127.0.0.1:8767/settings` in the Codex in-app browser through CUA, connect the synthetic device, and follow its binding link. The fixture Worker supplies a synthetic login at `/auth/github`; its entry point, data and endpoints are excluded from the production bundle. Use the in-app viewport capability for narrow screens. This is browser viewport testing, not a claim of physical phone acceptance.

For real local acceptance, use a separate `CODEX_USAGE_DATA_DIR` and port with the built CLI. The ordinary Codex login is read only by the existing local account provider; no special cloud access to Codex credentials is introduced.

## Provision and deploy

The configured Cloudflare account must own the `esoren.com` zone and have Workers/D1 access. The initial database is named `codex-usage-cloud`. For a new environment create it using `wrangler d1 create codex-usage-cloud`, then set the resulting `database_id` in Wrangler configuration before deploying. Do not apply test fixtures to remote D1.

Register a GitHub OAuth App with:

- Homepage: `https://quota.esoren.com`
- Callback: `https://quota.esoren.com/auth/github/callback`
- No wildcard callback or GitHub device flow is required.

Set its public client ID in `vars.GITHUB_CLIENT_ID`. Enter the client secret into ignored `cloud/.dev.vars` as `GITHUB_CLIENT_SECRET=...`, or supply the secret in the deployment process environment. The deployment script injects it through Wrangler's secret configuration, removes its temporary secret file in `finally`, and never prints the value. Keep `.dev.vars` private and outside Git. Subsequent deployments can omit that file and preserve the existing Worker secret.

```powershell
npm --prefix cloud run deploy
```

The script checks cloud types, builds assets, makes a dry-run Worker bundle, checks module/data boundaries, applies additive remote migrations, deploys the Worker with its custom domain, and verifies `/api/health`. A new domain may need DNS caches to expire. A completed Wrangler upload followed by a failed health check is reported as an incomplete verification, rather than as a ready service; inspect the recorded Worker version before deciding whether another upload is needed.

The health response must report `ok: true` and `loginConfigured: true`. Then verify real GitHub login, device confirmation, and a real quota snapshot through the browser. Health does not validate the OAuth secret with GitHub; only that complete login does. Record deployed version, data migration, acceptance and source branch in [deployment record](DEPLOYMENT.md). Deploying the Worker does not merge branches or publish npm.

## State and recovery

`shared/cloud.ts` is the strict upload contract. Payloads are limited to 64 KiB and 32 quota buckets. API ownership comes from authenticated sessions/devices, never a user ID supplied in the body. Device tokens are hashed in D1; polling uses a separate secret. GitHub tokens are discarded after login. Session/state cleanup runs hourly. Private responses use `Cache-Control: no-store`; request logs use sanitized error codes without request bodies, cookies, query strings or credentials. Invocation logging is disabled to avoid recording OAuth callback queries.

The local outbox and retry timer survive service restart. Offline disconnect persists a revocation task, stops uploads, and retains its credential until the cloud confirms revocation. Expired binding cleanup also revokes the proposed device token in case approval completed just before the pairing request expired. Users can independently revoke the main device or delete their cloud data from the website.

Use `wrangler deployments list` to inspect versions and `wrangler rollback VERSION_ID` to restore an earlier compatible Worker/assets version. Wrangler rollback does not roll back D1 migrations. The initial migration only creates the new service's tables; later schema changes must preserve compatibility or use a reviewed forward repair migration. On first deployment there is no earlier functional cloud version to restore. To halt an incident, pause local syncing and temporarily disable the custom-domain route through the Cloudflare dashboard after confirming the intended outage; preserve D1 for investigation. Do not delete the database as a routine rollback.

Primary references: [GitHub OAuth flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [Cloudflare Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), and [Worker rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).
