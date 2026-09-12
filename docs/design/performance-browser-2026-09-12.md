# Browser synchronization and cache performance, 2026-09-12

This component report records the first-migration read path, browser downlink and IndexedDB work in `codex/v3-performance`. The source baseline is preview `ce4f4ec80ee176f640b7afe6c6b2787704264e55`. The manifest-prefetch experiment uses a separate frozen controller captured immediately before prefetch integration so earlier fallback and polling changes do not contaminate that comparison.

The measurements below come from Chrome 152 on Windows operated through CUA. No Playwright, production browser benchmark or deployment was used. The parent task transcribed CUA results into the JSON evidence files named below, rounding reported timings to one decimal place. Those files are an auditable transcription, not a claim to contain the original unrounded browser JSON.

## Complete history is readable during the first migration

The old browser flow needed a completed v3 lease before usage queries could render. A first migration had no previous completed v3 view to retain. It could therefore keep describing an existing fixed version that did not exist, or wait for the entire migration before displaying history.

The server now advertises `legacy_read_available` only while a complete, committed legacy view is still available: the domain is not deleting, no applied v3 receipt or retired legacy head invalidates that view, and the migration is still pending. The client marks this as `legacy_ready`, requests the existing full application's v2 query routes with `legacy_fallback=1`, and requires `meta.legacyView.complete === true` plus the expected `user_id`. Each server query fences its reads with the same exact `write_version`, including the integer-safety proof and subsequent aggregate queries. A revision or domain transition returns `LEGACY_VIEW_EXPIRED`; the client checks status again and retries through the active read path.

The banner explicitly identifies complete old history that is being migrated. It does not create a v3 lease, advance a v3 cursor, promise offline availability or cache fallback query results as fixed-cut data. Reload requires new live server authorization. Project/origin management that needs v3 provenance remains unavailable during this temporary view. A 15-second transition check runs even when ordinary polling is disabled, allowing the same full application to switch automatically to completed v3 history.

The local fixture in `cloud/test/browser-worker.ts` creates 3 sessions, 60 events and exactly 72,000 tokens using real committed v2 heads. Its local-only `/api/test/legacy` controls hold and finish actual migration jobs. Parent CUA observed the complete history before migration and automatic transition to completed v3 history with the same 72,000-token total. This demonstrates the readable transition on the fixture; it does not establish a production first-readable latency distribution.

The final cloud build was verified again through CUA with a new isolated fixture user. Its JavaScript asset was `cloud/build/assets/index-Dl6KxpZq.js`; `cloud/build/index.html` had SHA-256 `afbe2f659e32086b06fa11bc3cd0e1d06bc52056c918e6a1abe1e1118d9011da`. While migration was held, the application showed the complete old history, 72K tokens and 3 sessions/60 events. The account page correctly showed that no confirmed snapshot was available, without an identity error. The fixture's real job completion returned 60 events/72,000 tokens and ready status. Without reloading, the UI transitioned to complete cached history at the displayed sync time 10:17:44 UTC and retained 72K. The parent visually inspected the rendered layout. This final build record is preserved in `artifacts/performance/browser-downlink/cua-final-ui-transcribed.json`.

Two additional isolation fixes support this path. Legacy responses are discarded after local or other-tab deletion and after a view transition. Account responses independently carry the authenticated `user_id`; the browser checks it before replacing that user's shared account cache. If another tab changes the login cookie, the old user's existing offline observation survives and the response for the new user is rejected.

## IndexedDB: batch promotion without weakening atomicity

The old finalization iterated staged records, performed serial body reads, scanned bodies for pruning, and deleted stages one cursor callback at a time. For 100,000 entities this involved hundreds of thousands of IndexedDB callbacks inside the final transaction.

The new implementation reads staging in batches of 256, fetches old bodies only for unchanged manifest references whose body is not already staged, scans namespace keys for pruning, and deletes the exact staging tuple range once. A set of entity keys replaces repeated membership work. Promotion, pruning, stage cleanup and compare-and-swap remain in one transaction. An interrupted or conflicting transaction cannot publish a partial cut.

The fixture stores exact counters above JavaScript's safe integer limit in every entity. Initial staging includes all 100,000 bodies. Refresh retains 90% of bodies by hash, removes 10% and adds 10% replacements. The benchmark measures staging and atomic promotion separately, then verifies all complete entity envelopes, removed entries, staging cleanup and the applied cursor. Fixture construction and final verification are outside the timed boundary.

| 100,000 entities, ABBA order | Initial staging | Initial promotion | Initial combined | Refresh staging | Refresh promotion | Refresh combined |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before 1 | 24.073 s | 133.151 s | 157.224 s | 23.302 s | 144.892 s | 168.195 s |
| After 1 | 41.667 s | 44.122 s | 85.789 s | 27.147 s | 37.313 s | 64.461 s |
| After 2 | 59.471 s | 49.037 s | 108.507 s | 46.524 s | 41.991 s | 88.515 s |
| Before 2 | 45.992 s | 138.498 s | 184.490 s | 27.519 s | 154.467 s | 181.985 s |
| Before mean | — | 135.825 s | **170.857 s** | — | 149.679 s | **175.090 s** |
| After mean | — | 46.579 s | **97.148 s** | — | 39.652 s | **76.488 s** |

The combined staging-plus-promotion boundary fell **43.1% for initial caching** and **56.3% for refresh**. Promotion alone fell 65.7% and 73.5%; quoting only those larger numbers would omit the substantial staging time. Windows disk activity, foreground/background tasks and uncleared OS caches affected staging times. ABBA reduces some order effects but two runs per implementation do not provide a confidence interval or a production speed guarantee.

| Operations in the promotion transaction | Before initial | After initial | Before refresh | After refresh |
| --- | ---: | ---: | ---: | ---: |
| `get` | 200,001 | 1 | 210,001 | 90,001 |
| `getAll` | 0 | 391 | 0 | 391 |
| `getAllKeys` | 0 | 1 | 0 | 1 |
| `put` | 100,001 | 100,001 | 100,001 | 100,001 |
| `openCursor` | 3 | 0 | 3 | 0 |
| `continue` | 300,000 | 0 | 310,000 | 0 |
| `delete` | 100,000 | 1 | 110,000 | 10,001 |

All four complete results had SHA-256 `05923a1459a2053004ef8f841aacc3cc3900bab8327b78d4cbf822965d307555`. The implementation adds an O(N) key set and an O(N) key array while body reads remain bounded at 256 staged records per batch. Reported post-run heaps varied from 352 MB to 870 MB across the runs; GC, prior runs and verification arrays contribute. Neither reduced peak memory nor reduced retained memory is claimed.

Evidence: `artifacts/performance/browser-cache/cua-100k-transcribed.json`. Browser correctness coverage includes a 600-entity transaction spanning several batches, JSON tuple prefixes with quotes and non-ASCII IDs, nearby staging-run isolation, CAS conflicts and deletion behavior.

## Downlink: overlap exactly one next manifest page

The serial controller waited for each manifest, fetched its missing entity bodies, persisted them, and only then requested the next manifest. The candidate starts the next manifest after the current validated manifest has been saved. That one pending response overlaps current-page cache lookups, entity downloads, hashing and writes. It never starts a second lookahead page or consumes the saved page before the current page is durable.

The prefetch is tied to the same lease and cursor. Its rejection is observed immediately, avoiding unhandled promise rejections while entity work proceeds. Consumption performs the normal lease, scope, cut, cursor, ordering and total-count checks. An entity failure cancels and observes the outstanding prefetch; a failed prefetched page is retried from the durable cursor. Coverage remains incomplete until the original full manifest and body checks pass.

The isolated prototype was tested first using real IndexedDB and a transport that waits 30 ms for each request. It reduced the mean complete initial synchronization time from 3,015.95 ms to 2,580.45 ms, or 14.4%, across 2,000 entities in ABBA order. The parent authorized integration after that result. The final production implementation, including deletion/cancellation guards, was then compared against the frozen pre-prefetch controller using the same fixture:

| Final implementation, 2,000 entities | Complete initial sync | Requests | Maximum concurrent requests |
| --- | ---: | ---: | ---: |
| Before 1 | 2,511.6 ms | 32 | 1 |
| After 1 | 2,010.8 ms | 32 | 2 |
| After 2 | 2,248.6 ms | 32 | 2 |
| Before 2 | 2,524.5 ms | 32 | 1 |
| Before mean | **2,518.05 ms** | 32 | 1 |
| After mean | **2,129.7 ms** | 32 | 2 |

The final controlled comparison reduced elapsed time **15.4%**. Every normal run made exactly one status request, one lease request, ten manifest requests and twenty entity requests. The fixed 30 ms delay is synthetic; this result includes real cache and controller work but does not measure production HTTP, D1 service time or production bandwidth. Prototype and final runs have different absolute timings, so their before/after pairs are interpreted separately.

A failed next-manifest request recovered in 2,248.9 ms with 34 requests; an entity failure recovered in 2,230.3 ms with 35 requests. Both reused one lease and downloaded each successfully staged body exactly once. All normal and interrupted results had SHA-256 `07de99e7b280447a2fda14bd989aefd217aecc738e44dbdd9eae82899a3479db`. No failed attempt promoted a partial view or left a pending request after settlement.

Dedicated tests exposed a pre-existing invalidation window: deletion could occur after the network generation check but during asynchronous content hashing. Baseline persistence then accessed a cleared checkpoint, while delta persistence could stage data under the newly cleared generation before failing on the commit gap. The integrated controller carries the original generation through baseline and delta persistence, checks it after asynchronous cache work, and rejects aborted source writes. The tests separately pause baseline hashing, delta hashing, a late prefetch and source disposal. They verify `CACHE_RESET`/`AbortError`, empty deleted namespaces and no late body publication. The frozen old controller still reproduces both hashing failures.

Evidence:

- `artifacts/performance/browser-downlink/cua-prototype-transcribed.json`: isolated candidate, preserved independently of the final run.
- `artifacts/performance/browser-downlink/cua-formal-transcribed.json`: production controller comparison and interruption recovery.
- `artifacts/performance/browser-downlink/before-controller.ts`: frozen pre-prefetch source, SHA-256 `1bcc289cbf5e2586e07a0cd27da58a4ceb3fe8986e3723a6c38742777bf627b6`.
- `artifacts/performance/browser-downlink/sources.json`: both source hashes; measured final source SHA-256 `5d804db42d170257a4d221300712dae9671df85dea1e092b3c09949d94f94e4b`.
- `artifacts/performance/browser-downlink/before-reset-tests.mjs` and `before-reset-failure.txt`: saved before-fix hashing-race reproducer and failure output.

## Avoid repeated unchanged automatic work

A live status response already identifies the current complete cut. For an automatic check of a fully cached view, with matching epoch and all cut version fields, no active baseline/delta and more than 60 seconds of lease validity, the controller now keeps that fixed view and only refreshes `lastSyncAt`. The display clock does not advance. Manual refresh, incomplete/recent views, expiring leases, changed epochs and deletion still take their original refresh paths. The shortcut is deliberately restricted to `full_ready`, so it cannot freeze membership of a rolling recent window.

The Node request-count fixture uses 1,000 complete entities and ten unchanged automatic checks. An unfiltered view fell from 20 requests to 10; a selected-device view fell from 70 requests to 10. These are exact synthetic transport counts, not measured browser or production elapsed-time improvements. Complete envelopes and the display clock are unchanged. Evidence: `artifacts/performance/browser-polling/result.json`.

Rendering was reviewed for another measured opportunity. Chart rendering already uses memoized chart components and memoized derived points. Repeated system-timezone discovery was small in a 10,000-call Node diagnostic and has a correctness requirement to observe OS timezone changes. No additional global formatter cache or speculative rendering refactor was integrated.

## Reproduction and regression scope

Run the browser pages through CUA in Chrome using the project's local static fixture host. The generated directories are ignored artifacts; preserve the frozen controller and evidence files when transferring this experiment. The downlink builder requires the captured source rather than silently substituting an unrelated Git revision.

```powershell
node scripts/build-browser-cache-benchmark.mjs ce4f4ec80ee176f640b7afe6c6b2787704264e55
node scripts/build-browser-downlink-benchmark.mjs artifacts/performance/browser-downlink/before-controller.ts
node scripts/benchmark-browser-sync-polling.mjs
node --import tsx --test tests/web-cloud-prefetch.test.ts tests/web-cloud-sync.test.ts tests/cloud-display.test.ts tests/cloud-navigation.test.ts
npx tsc --noEmit
```

Open the generated `artifacts/performance/browser-cache/benchmark.html?rows=100000`, `browser-cache/verify.html` and `browser-downlink/benchmark.html?rows=2000&latency=30` through the local host. Each page writes its complete result into `#results` and sets `document.documentElement.dataset.result` to `passed` or `failed`. The cache fixture verifies complete entity hashes, pruning and staging cleanup; the downlink fixture also verifies bounded concurrency and interrupted recovery.

The local full UI fixture uses `cloud/test/wrangler.browser.jsonc`, its local D1 database and `/api/test/legacy`. Build the cloud UI, apply the local migrations for that configuration, start local Wrangler on port 18787 and use the fixture controls to create and finish the synthetic migration. The main task owns final full UI and integrated suite evidence; this report does not imply production acceptance or user approval.
