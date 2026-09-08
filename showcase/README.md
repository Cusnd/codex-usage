# Public product showcase

An English product page with a small interactive synthetic example and screenshots of the actual Chinese application. It is a static site, not a hosted installation of the local dashboard. It has no account login, local-service access, or model calls.

Live: [codex-usage-showcase.sorenliu.workers.dev](https://codex-usage-showcase.sorenliu.workers.dev).

The visual direction follows a token trail: pale blue canvas, navy text, cobalt input markers, teal cache reads, and rose output. A branching agent ledger introduces the product; the interactive example then exposes the same family and project totals. Display headings use a system sans-serif, body text uses the bundled Inter font, and data captions use a system monospace.

## Reproduce

1. Build the application with `npm run build` and run `npx tsx scripts/design-preview.ts` in another terminal.
2. Capture the two documented screenshots using [these instructions](../docs/images/README.md).
3. Run `node scripts/build-showcase.mjs` from the repository root. It refuses data without `meta.exampleData: true`, verifies the expected dataset, and exports only allowlisted fields. Generated assets are retained under `public` for repeatable deployment.
4. Run `npx wrangler dev --config showcase/wrangler.jsonc` to preview locally. Check desktop and mobile layout, all project buttons, team disclosure, screenshot switching, copy prompt, and error state.
5. Run `npx wrangler deploy --config showcase/wrangler.jsonc --dry-run` before deploying with the same command without `--dry-run`.

The Worker is named `codex-usage-showcase`. Its asset directory is only `showcase/public`; no repository, source logs, local database, or credentials are published. Wrangler configuration is based on [Cloudflare static assets documentation](https://developers.cloudflare.com/workers/static-assets/binding/).

The demonstration intentionally covers a fixed week and four projects, without pretending to provide the full application. Screenshot captions and the dataset label make that boundary visible. Do not substitute personal records for the synthetic fixture.

## Verification

Checked on September 8, 2026: four project selections and task counts; keyboard project selection and team disclosure; both screenshots; clipboard success/failure feedback with a controlled clipboard stub; failed-data recovery; and reduced-motion behavior. Viewports 320, 390, 768, 1024, and 1440 pixels wide had no horizontal page overflow.

The deployed site was separately opened in a browser and checked for working project/screenshot switches and no page errors. Public assets returned HTTP 200 and were compared with local SHA-256 hashes. The public footer uses already-published GitHub destinations; the new local Chinese README will become available on GitHub after a separate repository publication.
