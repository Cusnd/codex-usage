# Shared frontend, synthetic online example

[Live example](https://codex-usage-showcase.sorenliu.workers.dev) runs the same React application, components, styles and routes as the local dashboard. Only the data transport and reference clock differ. It replaces the former separate product page.

## Data and behavior

The local application calls its existing loopback API. The example build lazily loads sql.js and creates an in-memory SQLite database from `fixture.ts`. Both environments execute the existing `Queries` engine and pricing calculations. The browser database exposes only synthetic usage and task tables; it does not contain source files, account credentials or personal snapshots.

The fixture contains 119,210,000 Token, 28 Sessions and 92 Turns across four projects. The example team has 18.2M self, 30.4M descendant and 48.6M total Token. `scripts/design-preview.ts` uses the same fixture for its native SQLite preview.

All relative ranges use the fixed instant `2026-09-08T18:00:00Z`; the default display zone is America/New_York. Today, recent ranges, drill-down and hourly aggregation remain usable after the real calendar advances. Custom dates and timezone changes retain normal application semantics.

Filters, search, ordering, pagination, task/turn details, agent navigation and costs are interactive. Valid settings persist in localStorage for that visitor and origin. Refresh re-queries the example and shows a success message. Autostart is visibly unavailable because it requires a local installation. Account windows are clearly labeled synthetic; account history deliberately preserves missing values.

## Build and publish

```powershell
npm ci
npm run check
npm test
npm run build
npm run showcase:build
npx wrangler dev --config showcase/wrangler.jsonc --port 8877
```

The example build requires no running local or design server. It writes only to ignored `showcase/build/`. A Vite bundle guard rejects private server modules from the example and rejects example/sql.js modules from the local production frontend. sql.js is a development dependency used only to produce the example assets.

```powershell
npx wrangler deployments list --config showcase/wrangler.jsonc
npx wrangler deploy --config showcase/wrangler.jsonc --dry-run
npx wrangler deploy --config showcase/wrangler.jsonc
node scripts/verify-showcase.mjs
```

Record the previous deployment before publishing. To restore it after a failed verification, use `npx wrangler rollback <previous-version-id> --config showcase/wrangler.jsonc` and verify the restored site. Publication is separate from Git commits or application release packages.

Cloudflare serves only `showcase/build/` with [SPA navigation fallback](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/). The connection policy permits only the example origin; the browser does not connect to a visitor's localhost. No cloud database, account authentication, model call or personal data upload is introduced.

sql.js integer reads explicitly enable [BigInt results](https://sql.js.org/documentation/Statement.html), with a locally served WASM asset and MIT license. SQLite computations preserve integer precision and nulls. Production installs retain native Node SQLite and do not load the WASM dependency.

## Verification

`tests/showcase.test.ts` compares browser and native SQLite queries for time boundaries, three timezones, combined filters, groups, sorting, pagination, multi-model turns, teams, costs, unknown fields and values above Number.MAX_SAFE_INTEGER. It also verifies settings persistence/isolation, invalid settings, unsupported local actions, unknown tasks and refresh behavior.

`scripts/verify-showcase.mjs` checks all published asset bytes against local SHA-256, five SPA routes and the connection policy. It accepts an optional origin for local verification.

Real-browser checks and deployment details are recorded in [shared frontend acceptance](../docs/design/shared-frontend/README.md). Screenshots use synthetic data only.
