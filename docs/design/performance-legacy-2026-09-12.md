# v3 legacy migration performance evidence

This task changes the initial v2-to-v3 baseline from one full rebuild per legacy head to one private, resumable baseline and one atomic publication. It also removes repeated range scans and D1 round trips from shared rebuild pages. No production data was changed and no production Worker was deployed.

Raw evidence paths below are relative to the retained, ignored [artifacts/performance-v3 directory](../../artifacts/performance-v3/). This component report is part of the [overall performance report](performance-optimization-2026-09-12.md).

## Implementation and correctness

- `cloud/src/v3/legacy.ts`: scan committed, nondeleted, unretired heads in pages of 50; import exact integer strings in record pages of 200 using staged-source and committed-record keys; materialize all candidates once; publish sources, candidates, thread/project metadata, imported revisions and the active epoch in the existing guarded D1 batch. The pending flag clears only in that transaction.
- An existing deployed per-head checkpoint discards only its unpublished epoch and private staging. Previously imported heads and the current epoch remain intact. This avoids redoing the already published migration prefix.
- Before materialization and again before publication, compare the staged head snapshot against current committed heads, deleted devices, retired revisions and newly arrived heads. A change restarts private work; the final write-version and lease CAS also protects changes racing with that comparison.
- `cloud/src/v3/rebuild.ts`: fetch at most 100 event IDs from each indexed current/staged branch before merging pages in SQLite order. This avoids an outer DISTINCT/UNION scanning and sorting all remaining history per page and preserves Unicode database ordering. Group event/observation/thread rows with maps. Read old threads once per page. Batch independent candidate/prior/event reads, overlap the independent assignment-rule read, and reuse a just-read domain while preserving the final CAS.
- `cloud/src/v3/projects.ts`: prepare all legacy collectors' project metadata in one organization calculation. No source/session project evidence is invented.

The repeated full materialization changes from a cumulative sum over each head's imported prefix to one pass over the proposed canonical dataset. Imported candidate payload processing is bounded to 200 rows and event materialization to 100 event IDs per checkpoint. Project organization still loads the existing organization, and the final publication uses SQL to copy the complete private dataset atomically; the 19,319-record remote case was verified, not arbitrary unbounded datasets.

## Local Worker / D1 simulator

Runtime: repository-pinned Wrangler 4.130.0, Cloudflare Vitest plugin, real Worker execution and local D1 SQLite. Synthetic fixed timestamp, deterministic identities, three legacy project paths; each event has total_tokens `9007199254740994`, beyond JavaScript's exact-number range. Fixture seeding is excluded from elapsed migration time. These are local figures, not network/production latency.

| Case | Algorithm | Migration ms | Steps | D1 requests | Read rows | Written rows |
|---|---|---:|---:|---:|---:|---:|
| 10 heads / 100 records | old per-head rebuild | 2,338 | 100 | 704 | 49,849 | 17,185 |
| 20 heads / 200 records | old per-head rebuild | 5,145 | 210 | 1,629 | 323,564 | 60,797 |
| 219 heads / 19,272 records | first single-baseline implementation | 28,233 | 305 | 2,397 | 3,769,089 | 725,426 |
| same 219-head fixture | indexed event pages | 16,200 | 305 | 2,397 | 1,902,198 | 725,426 |
| same 219-head fixture | indexed event and import pages | 16,084 | 305 | 2,397 | 777,293 | 725,426 |
| same 219-head fixture | plus batched reads / shared domain | 14,588 | 305 | 1,811 | 777,093 | 725,426 |

Evidence: `legacy-before.log` verifies the baseline fixture. `legacy-before-metrics.log` intentionally fails a temporary value-capture assertion to print baseline metrics; those failures are measurement capture, not functional failures. The permanent test restores real passing assertions and stores metrics in Vitest task metadata. `legacy-batched-read-pages.json` records 39/39 passing tests (7 migration/performance tests and 32 existing v3 regressions). `legacy-indexed-all-pages.json` is the preceding independent indexed-page checkpoint. The main task also ran the complete Worker suite separately.

Specific new regressions cover atomic visibility before all heads finish, same-response copies from two devices, cross-user isolation, exact totals, restart after expired lease, rejection of a stale lease, continuation from an old deployed per-head checkpoint, a v2 revision changing before publication, and a new earlier head arriving after the scan cursor passed. Existing v3 tests cover explicit complete-source legacy handoff, unavailable replacements, shared-response identity, source replacement, cancellation, deletion preemption, origin assignments and preserved evidence, receipt replay and fixed-cut reads. The full-scale test includes a read-row budget to catch reintroduced scanning amplification.

## Isolated remote D1

All remote tests use the task-only Worker `codex-usage-legacy-perf-eb20` and task-only D1 `1bd4def4-8ebd-4d6c-a739-db8d3834fba4` (`codex-usage-legacy-perf-eb20`, creation region WNAM). The Worker has no production routes or bindings, exposes a bounded synthetic fixture harness on workers.dev, and requires a newly generated Bearer secret. No test user or synthetic record was placed in production.

`remote/before` freezes `ce4f4ec80ee176f640b7afe6c6b2787704264e55`. `remote/after` freezes the initial optimized baseline; `after2` adds the indexed event/import pages; `after3` adds batched independent reads and the shared-domain read. All variants use the same migration schema and fixture. Source hashes and each constituent file hash are in `remote/results/source-fingerprints.json`; deployment version IDs are in the corresponding deployment logs. The first after snapshot also includes the main task's then-current shared materialization changes, so the complete before/after result must not be attributed exclusively to legacy.ts.

The runner seeds the fixture before timing. It then drives bounded `advanceJobs` calls continuously and separately verifies the complete output. Worker work time excludes client HTTP and final verification; end-to-end time starts at the first advance call and includes those HTTP calls plus complete output verification. This is a warm, seeded migration scenario, not a cold deployment or browser measurement. Each listed remote configuration is one measured run; timings include normal network variability. Read/write/request counts and output identities provide a more stable comparison than small wall-clock differences.

| Remote case | Budget per call | Invocations | Steps | Worker work s | End-to-end s | D1 requests | Read rows | Written rows |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| ce4f4ec, 20 heads / 200 records | 20 steps / 15 s | 11 | 210 | 52.399 | 57.741 | 1,838 | 323,769 | 60,797 |
| after3, same 20 heads / 200 records | 20 steps / 15 s | 1 | 12 | 2.173 | 3.320 | 73 | 9,108 | 8,297 |
| after, 219 heads / 19,319 records | 20 steps / 15 s | 16 | 306 | 121.289 | 131.151 | 2,712 | 3,780,319 | 727,248 |
| after, same 219-head fixture | 200 steps / 25 s | 5 | 306 | 120.551 | 125.993 | 2,712 | 3,780,319 | 727,248 |
| after2, same 219-head fixture | 200 steps / 25 s | 4 | 306 | 94.452 | 99.751 | 2,712 | 779,639 | 727,248 |
| after3, same 219-head fixture | 200 steps / 25 s | 4 | 306 | 90.386 | 96.226 | 2,123 | 779,438 | 727,248 |
| final bounded scheduler, same 219-head fixture | 200 steps / 800 SQL / 20 s | 6 | 311 | 83.096 | 89.629 | 2,155 | 785,906 | 727,268 |

The 20-head before/after3 case reduces measured Worker work by about 24.1 times and D1 requests by 96.0%; end-to-end including network and full verification improves about 17.4 times. The 219-head old per-head implementation was not run remotely, so no full-scale old-to-new speedup is claimed. Its optimized full-scale completion is measured directly.

All remote cases verify each event's exact token total and the complete overall total. Four independent complete-content hashes cover events, threads, project entities and aggregate rows. The 20-head baseline and every tested optimized 20-head variant have identical four hashes. All tested optimized 219-head variants likewise have identical four hashes. The exact 219-head total is `174010082402341263086`. Random epoch/commit/organization version counters are deliberately excluded from semantic content hashes because publication frequency changes those counters; their readiness state is checked separately.

| Complete content | 20-head baseline and optimized SHA-256 | 219-head optimized variants SHA-256 |
|---|---|---|
| Events | `64e9435550dc792ae3815419e485318d975c44f2d4e247e5cff493f348576861` | `2064acaa5eb39372b35fc114bb350d36bde434763afb669bb833c491c3d1a20e` |
| Threads | `1dd71ec82dffd830f838c5d43d05251b5dfed5f6c066607f92013166bc895b55` | `31ef261872490451dde84c42bda7d3c1f509eea74994a27396b4a2c9ff494295` |
| Project entities | `54643ff0c433e50e50a57e02c1a0a384ccb1ec9f1ba842288f969c6396702a0e` | `54643ff0c433e50e50a57e02c1a0a384ccb1ec9f1ba842288f969c6396702a0e` |
| Aggregates | `de5f0d47c9c0f518687d72055e436293f3a9fb83469bd98ede62cf1280ba0d78` | `35ab1b20a325788faa902a944c5e86f6e13346fd1acc1c13257db0b0f137dcd7` |

Raw per-invocation records: `remote/results/*-steps.jsonl`. Complete results, counts, hashes and summed D1 query execution times: `remote/results/before20.json`, `after20.json`, `after219x20.json`, `after219x200.json`, `after2small.json`, `after2large.json`, `after3small.json`, `after3large.json`. In the full-scale 200/25s case, D1 query execution totals fall from 35.492 seconds in `after` to 7.489 seconds in `after2`; subsequent `after3` measures 8.252 seconds while reducing request count, showing ordinary timing variability and the remaining round-trip/durable-write cost.

The final scheduler snapshot also includes the collective handoff/apply query-count fixes and the request-local SQL budget. In the complete `final800.json` run, the six invocations issued 785, 783, 784, 784, 784 and 647 SQL statements respectively, exactly matching the instrumentation's count. Five calls yielded at the query budget, the last completed. The five additional claimed attempts (311 versus 306) are partially prepared, uncommitted pages retried after a budget yield; all four complete-content hashes still match every earlier 219-head run. The total exact token count and ready/complete state also match. This demonstrates real bounded continuation, rather than silently dropping work at a limit. The 83.096-second figure is a single warm measured run and is not evidence that the budget itself makes SQL faster.

The final frozen source manifest SHA-256 is `265207afa2e30ed4989702c278acebca9120a8b022eacc1fcfc293b40b1f42cd`. The frozen files are retained unchanged; the working tree subsequently removed one extra EOF newline in `legacy.ts`, with no semantic/bundle change. Final review also found that synchronous budget exhaustion while constructing `Promise.all` inputs could leave another concurrently started read rejection unobserved. The working tree receives a separate exception-handling patch to preserve asynchronous rejection semantics, with its own regression test. That final exception-handling patch is not included in these remote timings; successful-query SQL and publication semantics remain unchanged. Later documentation edits also do not alter the measured Worker bundle.

## Scheduling interpretation and remaining limits

Actual once-per-minute Cron was also sampled on the isolated Worker with the optimized algorithm and the old 20-step/15-second budget. The two `scheduled_at` values differ by exactly 60,000 milliseconds. They performed 20 steps each, with 10.260 and 10.532 seconds of measured work, 100 D1 requests each, and 178/180 SQL statements. There were 49.561 seconds between the first completion and the second start. This is actual observed idle time; only the first 40 steps of this Cron sample were run, and no full-Cron completion time is claimed from it. The HTTP-driven runs above were separate fixtures. Raw enabled time and scheduler timestamps are in `remote/results/cron-old-budget-enabled.json` and `remote/results/cron-old-budget-runs.json`.

The final frozen scheduler was then sampled through two actual Cron invocations on a freshly seeded 219-head / 19,319-record fixture, with 200 steps / 600 SQL / 20 seconds:

| Actual Cron sample | Steps per invocation | Work seconds | SQL statements | D1 requests | Idle before next invocation |
|---|---:|---:|---:|---:|---:|
| Previous 20-step budget, first tick | 20 | 10.260 | 178 | 100 | 49.561 s |
| Previous 20-step budget, second tick | 20 | 10.532 | 180 | 100 | not sampled |
| Final budget, first tick | 40 | 20.126 | 358 | 200 | 39.745 s |
| Final budget, second tick | 40 | 20.028 | 360 | 200 | not sampled |

Both final ticks advanced their durable import cursor with no job error, stopped at the time budget between pages, and issued exactly the SQL count reported by `advanceJobs`. They did not exhaust the 600-query budget in this phase. Their scheduled timestamps differ by exactly 60,000 ms. The sample doubles work per tick while preserving a bounded invocation; minute scheduling still leaves observable idle time. It covers 80 steps, not complete migration by Cron. The harness invokes the same final `advanceJobs` core with the final production budgets; its fixture/control/status bookkeeping is outside the displayed core counters. It does not execute the production scheduled handler's unrelated cleanup branches, which the main task tests separately as a complete scheduled package. Raw records are in `remote/results/cron-final-budget-enabled.json` and `remote/results/cron-final-budget-runs.json`; automated cross-checks of all content hashes, ready states, query budgets and Cron timestamps are in `remote/results/final-verification.json`.

The continuous 20/15s versus 200/25s comparison keeps SQL work, rows and output identical. Its main benefit is fewer required wakes: 16 calls become 5, with almost identical Worker work time. Real once-per-minute Cron adds idle time between those calls, while browser/status-driven continuation can reduce that wait. Continuous HTTP timings must not be described as Cron or production acceptance.

Budget increases must also respect per-invocation D1/subrequest limits and preserve checkpoint/lease boundaries. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/) currently document 1,000 queries per paid Worker invocation and a 30-second SQL/batch duration limit. The final request-local budget counts every internal SQL statement in a batch conservatively, admits each atomic batch in full, and reserves 16 SQL statements for recovery and lease release. Its regular work therefore has a 584/784 statement ceiling for 600/800 configurations; the returned total includes recovery and release. The final full-scale HTTP run verifies budget exhaustion and continuation, while the two final Cron samples verify actual time-budget use. The displayed SQL ceiling applies to `advanceJobs`; the full scheduled handler also budgets its cleanup work separately.

No Worker CPU or peak-memory measurement was captured, so neither is claimed. Actual production migration time, browser readiness after deployment, cold-isolate behavior, very large project organizations, and datasets beyond the measured full-scale case remain separate validation scopes. Continuous incoming legacy mutations may restart the unpublished baseline; correctness is retained, but migration under an adversarial never-quiescent v2 writer is not benchmarked.

## Legal maximum legacy handoff

The scheduling audit found a separate correctness/performance boundary in `prepareHandoff`: legal batch metadata can describe 500 heads or 500 replacement sources for one head. The previous implementation generated one source-activation sequence per source and one retirement/delete sequence per head. That can exceed D1's per-invocation limits, and a strict new query budget would repeatedly yield without completing the step.

The fixture first validated both inputs with `validUploadBatch` and measured the original implementation, then measured and actually executed the set-based replacement under the existing user/device CAS:

| Valid input | Before read SQL | Before prepared write SQL | After read SQL | After prepared write SQL |
|---|---:|---:|---:|---:|
| 1 head, 500 complete replacement sources | 2 | 1,507 | 2 | 10 |
| 500 heads, one complete replacement source each | 1,000 | 5,000 | 2 | 10 |

The optimized function batches and deduplicates head/source reads, checks exact source completeness/availability/thread identity and newer-generation supersession, and constructs byte-bounded set updates and retirement deletes. It still prepares statements without publishing early. The caller executes promotion and retirement under its existing atomic CAS. Both tests verify all 500 sources are active afterward, all relevant heads are retired, every outcome is applied, and every planned source is present. Existing regressions separately verify incomplete/unavailable rejection and superseded or interrupted handoffs. Input/statement evidence is in `legacy-handoff-before.json` and `legacy-handoff-after.json`; final regression evidence is in `legacy-handoff-regressions.json`. These are local Worker/D1 measurements, and no maximum-handoff wall-clock remote speedup is claimed.

## Reproduction and resource cleanup

Permanent local fixture: `npm --prefix cloud test -- --run test/v3-legacy-performance.test.ts --reporter=json --outputFile=../artifacts/performance-v3/legacy-reproduced.json`.

The remote harness source and frozen variants remain in this ignored artifact directory. Reproduction requires creating a fresh task-only D1 and Worker, updating only the harness config to that new database, applying the copied migrations, generating a new secret, deploying the harness, and running `remote/run.mjs` with a listed scenario. The recorded database must not be replaced with production. `remote/fingerprint.mjs` recomputes source hashes.

All remote evidence was downloaded and compared before task-only resource deletion. Cron sampling was disabled, then the exact task Worker and D1 listed above were deleted. Follow-up Cloudflare API reads confirmed Worker absence with code `10007` and database absence with code `7404`; these are explicit resource-not-found responses, not network failures. The generated local secret was then removed and its absence checked. Creation, schema application, deployment and Cron logs remain in `remote/results/`; deletion and absence proofs are `delete-worker.log`, `delete-d1.log`, `verify-worker-absent.log`, `verify-d1-absent.log` and `resource-cleanup.json`. Frozen sources and raw results remain available locally. Production was not changed.
