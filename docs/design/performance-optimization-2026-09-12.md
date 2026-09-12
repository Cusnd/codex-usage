# Full-chain performance work, 2026-09-12

This task reduces time spent collecting, preparing, applying, querying and displaying usage history. Its source baseline is preview `ce4f4ec80ee176f640b7afe6c6b2787704264e55` (runtime snapshot `089dd805badd814d49d7284a639eecececfe8f70`); changes live in the independent `codex/v3-performance` worktree. The previous request to defer performance work was superseded by the user's explicit full-chain research and optimization request.

No production Worker deployment, production data mutation, commit, push, GitHub CI run, merge, tag or npm publication is part of this result. Remote experiments use a separately named Worker and D1 with synthetic inputs. Existing real source fixtures and the original preview workspace are read only. Production adoption still follows the explicit “更新预览” workflow; measured engineering results and user acceptance are separate states.

## Comparisons and measurement boundaries

| Segment and fixed input | Before | Candidate | What this establishes |
| --- | ---: | ---: | --- |
| Entire local importer, 219 real frozen files / 717,782,514 bytes, fresh SQLite, median of 3 | 14.405 s | 12.591 s | 12.6% less elapsed time including project resolution, durable collection, local materialization and status mirror |
| Unchanged full scan of the same files, median of 3 | 3.576 s | 1.607 s | 55.1% less elapsed time; no source body reread |
| Migration preparation, actual Collector queue of 401 batches / 100,800 projected records, median of 5 alternating calls | 315.055 ms | 2.593 ms | Indexed immutable source headers replace reparsing the complete queued bodies; all registration outputs agree |
| Registration transport, 200 source mappings | 200 requests | 4 requests | Additive batching retains every registration and all readiness barriers |
| Actual uploader and gzip, 64 batches, artificial awaited 10 ms ingest transport, mean of 2 | 4.024 s | 1.030 s | Removes 3 s of scheduler idle; same packets, receipts and request counts; this is not a production upload speedup |
| D1 application, 200 records / 20 preserved-origin sources, local Workers runtime, median of 3 alternating runs | 543 ms / 211 binding calls | 86 ms / 11 binding calls | Initial optimized apply snapshot before the later budget-driven set operations; 5,301 written rows and exact business result unchanged; final regression retains the request bound |
| Integer-safety proof over 100,000 JSON-backed events, native SQLite, 3 measurements each in alternating order | 489.465 ms | 363.084 ms | Streaming projection avoids repeated JSON extraction; every proof result agrees and filtered indexes remain in use |
| Complete browser sync, 2,000 entities, real Chrome IndexedDB with artificial 30 ms per transport request, final integrated ABBA | 2.518 s | 2.130 s | About 15.4% less elapsed time with one manifest page of lookahead; request count unchanged, at most 2 in flight |
| Browser cache initial staging plus publication, 100,000 entities, real Chrome IndexedDB, ABBA | 170.857 s | 97.148 s | 43.1% lower total cache time, complete hashes equal; includes both stages, not just the faster final transaction |
| Same browser cache, replacement staging plus publication | 175.090 s | 76.488 s | 56.3% lower total refresh time, complete hashes equal |
| Isolated remote migration, 20 heads / 200 records, continuous HTTP plus full verification | 57.741 s | 3.320 s | Complete before/after semantic parity; same account/fixture, separate frozen versions; one measured run each |

These numbers measure different boundaries and must not be added together into a claimed end-to-end production speedup. Large migration, browser cache and final scheduler evidence are recorded in the linked component reports. The original 100k upload under one minute and concurrent two-device P90 below two seconds have not been re-certified by these local and isolated experiments.

The [legacy migration report](performance-legacy-2026-09-12.md) contains the complete 219-head / 19,319-record remote runs, all four content hashes, old checkpoint recovery, maximum handoff inputs and actual Cron samples. The 219-head old per-head algorithm was not run to completion remotely, so its full-scale old-to-new speedup is not claimed. The [browser report](performance-browser-2026-09-12.md) distinguishes controlled transport, real IndexedDB and full application acceptance.

Windows, Node v24.16.0 and Chrome 152 were used. OS caches were not forcibly cleared; background development and shared disk activity can affect elapsed times. Alternating runs, full hashes and operation counts provide stronger evidence than a single timing. Browser `heapAfter` is GC-sensitive and is not peak-memory evidence.

## Why these changes help

The collector used to commit its source status mirror separately for every source after every scan. One atomic `INSERT SELECT` removes those redundant durable commits. Independent Git reads overlap process startup, then the dependent remote query runs after the branch is known. The parser takes the existing source-aware integer reviver whenever a conservative digit probe can match an unsafe integer; ordinary records avoid that overhead without changing exact large-integer handling.

Migration preparation now reads immutable indexed source-generation headers and groups additive HTTP registration within explicit byte and item limits. The uploader rechecks preparation before ingest and uses a one-shot immediate-continuation hint only after a successful bounded drain. Immutable gzip bytes, received/applied acknowledgements and error backoff retain their responsibilities.

Cloud materialization groups candidates by event once, batches known origin checks and loads old entity versions together. The shared exact-query engine evaluates JSON-backed token fields once in a streaming subquery before performing the original safety proof. `LIMIT -1` prevents flattening without dropping any filtered rows. It does not replace BigInt fallback or relax storage validation.

The first historical migration now performs one private rebuild for the complete legacy input. Indexed keyset pages avoid rescanning prior events and sources. The UI can display a server-verified complete legacy history during initial preparation; an exact write-version fence rejects pagination or proof/SUM races. No partial v3 history becomes current. A regression reproduced the mixed-page race before the fence fix, then verified its 409/retry behavior.

Background jobs now count SQL before sending it, including every statement of a batch. Cron allows up to 200 steps, 600 SQL and a cooperative 20-second work interval; HTTP status continuation uses 800 SQL with the same step/time ceilings. Sixteen statements for failure recovery and lease release are reserved inside the SQL budget. The existing 100-domain cleanup can consume 323 additional SQL, so the complete Cron stays below 1,000. A real scheduled-handler test exercises 100 domains with cleanup and confirms the combined bound. Time is checked between steps; it does not cancel an in-flight D1 transaction at exactly 20 seconds.

The budget audit first reproduced legitimate inputs that would otherwise stall: 500 title records used 1,042 SQL, and 64 sources with 500 availability entries used 726. Set-based apply reduces those to 44 and 101 SQL while preserving all results and ordered metadata semantics. A 500-thread deletion completes across five bounded calls. Legacy handoff changes from 1,000 reads plus 5,000 prepared writes for 500 heads to 2 reads plus 10 writes. These extreme-input fixes are necessary to make the new invocation budget recoverable, not separate weakened limits.

Browser cache publication replaces per-row cursor/read callbacks with bounded 256-row reads, key lookup and range deletion, retaining one final transaction and compare-and-swap. It uses an additional set of entity keys; no memory reduction is claimed. Unchanged complete automatic views skip lease and manifest work while the current lease is safely valid. A bounded manifest lookahead overlaps network waiting with current-page entity work, but advances the durable cursor only after persistence. Account responses identify the authenticated user before entering that user's cache.

## Coverage and choices retained

| Area reviewed | Decision and evidence |
| --- | --- |
| File discovery, scan, parsing, fingerprints, durable storage and local materialization | Measured the entire real importer, profiled it and compared all six before/after databases; preserve raw chain hashes and crash-safe transactions |
| Serialization/compression | The unchanged actual 401-batch codec took 0.226 s parse, 2.737 s encode and 1.987 s decode; 13,784,116 gzip bytes, exact round trip. No speculative codec or wire-format change |
| Upload, readiness, retries and scheduling | Group registration and remove avoidable success-path idle; retain immutable retries, receipt barriers and backoff on unsuccessful work |
| D1 receive, materialization, legacy migration and indexes | Batch independent work, eliminate repeated rebuilds and prefix scans; preserve domain CAS, private epochs and atomic publication |
| API and query engine | Status returns persisted state before background advancement. Existing 100k local D1 query-scale correctness tests pass; a diagnostic pass measured summary 2,945→2,384 ms, trend 3,635→3,205 ms and turns 4,692→4,177 ms. Those are single-series local diagnostics, not repeated remote acceptance |
| Downlink, cache, state and rendering | Real IndexedDB ABBA and failure recovery, full UI migration transition, no-change request counts and bounded lookahead. Existing chart memoization already prevents redundant rebuilds; tiny formatter work did not justify another global cache |
| Deployment placement and paid plan | No placement or billing change. D1 query budget and independent cleanup overhead are considered before increasing background work |

## Evidence and reproduction

Ignored artifacts contain raw input-dependent evidence and temporary experiments; they are not automatically included in a source snapshot. Reproduction scripts and regression tests are part of this task's source changes.

- `artifacts/performance-collector/report.md`, `before.json`, `after-final.json`, `output-verification.json`, `migration-preparation-final.json`, `uploader-scheduling.json` and `upload-encoding.json` contain collector inputs, hashes, timing boundaries and comparisons. Entry points: `scripts/benchmark-collector.ts`, `scripts/verify-collector-benchmark.ts`, `scripts/benchmark-migration-preparation.ts`, `scripts/benchmark-uploader-scheduling.ts`, `scripts/benchmark-upload-encoding.ts`.
- `artifacts/performance-v3/apply-comparison.log` preserves the original instrumented comparison; `cloud/test/v3-apply-performance.test.ts` keeps the bounded request-count and exact-result regression. Intentional capture assertions in archived experiments are diagnostic instruments, not current-suite failures.
- `artifacts/performance-collector/job-budget-report.md`, `job-budget-before-failing.json` and `job-budget-after-final.json` preserve valid extreme inputs, counted failures, immutable-wire continuation, error recovery and a same-queue scheduling comparison. `cloud/test/v3-job-budget.test.ts` and `cloud/test/v3-status-background.test.ts` are the permanent regressions.
- `artifacts/performance-v3/query-safety.json` contains before/after proof outputs and EXPLAIN plans. Reproduce with `node --import tsx scripts/benchmark-query-safety.ts`. `query-before.log` and `query-projection-experiment.log` preserve the local Workers diagnostics.
- Browser entry points: `scripts/build-browser-cache-benchmark.mjs`, `scripts/build-browser-downlink-benchmark.mjs`, `scripts/benchmark-browser-sync-polling.mjs`. Run the generated pages through CUA in Chrome. Transport latency in the downlink fixture is deliberately synthetic; IndexedDB and controller execution are real.
- The local full application fixture is `cloud/test/browser-worker.ts`. CUA observed the same 72,000-token history before migration and after automatic transition to a complete v3 cache; the transition was driven by actual migration jobs over 60 records. Nine real IndexedDB recovery/CAS/isolation checks also passed.

Collector parity includes all 17,936 canonical events and 218 threads; all six databases share SHA-256 `7af4f550bb43e38bb3aa01fbd56d5401cacb937009360caef1152536314a4a89`. Source SHA-256 checks, SQLite integrity, mirrors, offsets and duplicate checks pass. Equal totals alone were not used as parity evidence.

## Final integrated validation

- Root suite: 236 tests, **232 passed**, 4 platform-specific skips, no failures (`artifacts/performance-v3/root-tests-final.log`).
- Complete cloud suite: **16 files / 119 tests passed**, no failures (`artifacts/performance-v3/cloud-tests-final.log`). This includes exact integer fallback, full 100k query views, old-checkpoint migration recovery, source handoff, deletion, origin/project rules, receipt replay, SQL budgeting and background status.
- Root TypeScript and production build, cloud TypeScript, cloud assets build, production-build smoke with an empty temporary home, and Wrangler Worker dry-run passed. Logs are `build-final.log`, `cloud-check.log`, `cloud-build-final.log`, `smoke-final.log`, and `worker-dry-run-final.log` under `artifacts/performance-v3/`. The normal Vite large-chunk advisory remains; it is not a build failure or a measured bundle-size improvement.
- CUA inspected the final cloud build (`index-Dl6KxpZq.js`): the synthetic first-migration page exposed complete 72,000-token history and valid empty account state, then switched automatically to a completed v3 cache with the same totals. The fixture's real migration returned 60 events / 72,000 tokens. This was repeated after prefetch and account-identity changes.
- Final SQL-budgeted isolated D1 migration (219 heads / 19,319 records, 800 SQL / 200 steps / 20-second cooperative intervals) completed in **6 calls, 83.096 s Worker work and 89.629 s continuous HTTP plus verification**. Counted SQL per call was 785, 783, 784, 784, 784, 647. The first five yielded normally; all four complete semantic hashes and the exact total matched prior runs. Those calls are not minute-Cron timings; see the component report for actual scheduled samples and resource cleanup.
- Two real once-per-minute Cron samples with the final 600-SQL policy advanced 40 steps each, versus 20 each under the old policy. Work was 20.126 / 20.028 s and 358 / 360 SQL, with no job error; the observed gap between first completion and second start was 39.745 s versus 49.561 s. This is two actual scheduled core-work samples, not an extrapolated full migration completion time.
- Final cross-review reproduced an unhandled Promise rejection when a synchronously denied budget interrupted construction of parallel reads. The budget adapter now returns rejected Promises consistently for asynchronous D1 methods. A separate child-process regression runs actual materialization with a two-query limit and long IDs: one read, no batch, no unhandled rejection. This last error-path patch and EOF cleanup postdate the immutable remote timing snapshot; normal SQL content and publication semantics are unchanged. The final local suites and Worker dry-run include the patch.
- The task-only remote Worker and D1 were deleted after evidence download, then verified absent with explicit Cloudflare not-found responses. The temporary Bearer secret was removed. Local fixture servers on 8794, 8795 and 18787 were stopped. Cleanup evidence is `artifacts/performance-v3/remote/results/resource-cleanup.json`; production resources were not changed.

The original preview workspace still contains its pre-existing `AGENTS.md`, `docs/design/benchmarks/` and `experiments/` changes; this task did not alter them. User-provided guidance in this worktree is retained. The previous `performanceAccepted:false` evidence has not been overwritten. No physical-phone result, production benchmark, full GitHub platform matrix or user approval is implied by this document.
