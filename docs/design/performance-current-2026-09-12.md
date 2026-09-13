# Current performance baseline and implementation

This round starts from current `develop` commit `f25aaf9dcdb4ad31232bb78b2ab5876b95949390` on branch `codex/performance-baseline-20260912`. It follows baseline measurement, bottleneck investigation, implementation and repeated verification. Previous performance reports describe earlier source and are retained as historical evidence.

The baseline covers real local collection, the current uploader/codec, shared SQL queries, local Workerd/D1 application, browser bundles, real IndexedDB and CUA page behavior. Independent work was delegated by component; timing windows were coordinated so the task's heavy benchmarks did not run together. Windows 11, Intel Core i7-13700KF and Node 24.16.0 were used. Timing samples and complete-output checks are retained under the ignored `artifacts/performance-current/` directory; scripts and regression tests are included with the source.

## Main measurements

| Boundary and fixed workload | Before | Final | Evidence |
| --- | ---: | ---: | --- |
| Full unchanged importer scan, 219 frozen real files / 717,782,514 bytes, median of 9 | 1,724 ms | 685 ms | 60.3% less time; no log body reread; complete effective-event and thread rows match |
| Fresh importer scan, same input, median of 3 | 10,077 ms | 10,172 ms | No meaningful improvement; full results remain identical |
| Shared native SQLite, 100k events, 50-turn page, median of 3 | 2,150 ms | 654 ms | 69.6% less time; complete page/composition/cost output agrees |
| Same 100k input, 50-thread page | 593 ms | 494 ms | 16.7% less time; same complete output |
| Same 100k input, seven-day filtered hourly trend | 566 ms | 37 ms | 93.4% less time; same buckets, exact values and costs |
| Local D1, 10,080 events over 14 days, filtered hourly trend `rows_read` | 1,764,012 | 71,910 | 95.9% fewer read rows on the same lease; full output and DST expectations agree |
| Local D1, same input, full hourly trend `rows_read` | 6,914,888 | 143,810 | 97.9% fewer read rows; per-bucket time index observed |
| Local D1 apply, 500 events / 20 sources, median of 5 | 314 ms | 162 ms | 48.4% less time; full entity/hash/change checks, same persisted rows |
| Same D1 apply, executed parameter bytes | 5,005,240 B | 3,049,230 B | 39.1% less repeated binding data; D1 binding calls remain 9 |
| Local page initial JavaScript, gzip | 273,934 B | 246,821 B | 9.9% smaller initial download; raw 894,132 → 794,351 B |
| Local page FCP, controlled cold download, median of 3 alternating pairs | 1,712 ms | 1,576 ms | 7.9% less time in the specified simulated network; not an ordinary warm-cache result |

Each row measures a different boundary. These percentages must not be added together or described as a measured end-to-end production speedup. The native SQL measurements do not include network or rendering. D1 measurements use the real local Workers runtime, without Internet transit. D1 binding-byte counts exclude SQL text and protocol framing and are not a billing metric. Three/five/nine local samples are not production p95 estimates.

## Implemented changes

1. **Collection metadata:** up to four repository-read groups can proceed together; paths in the same repository share pending Git reads. Source resolution and writes keep their original order, and every scan still refreshes current repository/App evidence. No result TTL, log sampling or durability reduction is introduced.
2. **Shared queries:** turn composition and costs use a materialized set of page keys; thread counts calculate only group keys. Trend queries make the bucket loop explicit and use each bucket's narrow indexed time interval. The original outside date constraints remain exact predicates. SQL integer-safety checks, bounded BigInt fallback, timezone and DST bucket generation are retained.
3. **Cloud application:** serialize each entity value once for payload/hash, send only keys to close an old version, and send only indexed columns plus the complete payload to current-event writes. Atomic batches, publication guards, receipts, null tombstones and query budgets retain their original responsibilities.
4. **Local/showcase front end:** defer analysis/settings pages and load them on navigation intent; split the analysis-only bar renderer out of the overview's chart module. Cloud receives eager page components through its entrypoint so all route code remains available before a later offline navigation. The complete shared UI and distinct local/cloud entrypoints remain in use.

The complete 17,936-event / 218-thread real collection result has SHA-256 `b2027eaa2c0b81acf675a56a72c4654e0ae8df077198376c22fcd4fab62191ea` in all baseline and final databases. All 14 ordinary query outputs and six forced-BigInt outputs deep-equal the baseline. New semantic cases cover null and escaped/Unicode tuple identities, pagination, fixed exact prices, New York DST changes and Kathmandu's offset. Cloud publication comparisons check full payloads, hashes and changes, plus exact large-token aggregates.

## Components retained after measurement

The uploader baseline executes actual gzip encoding, durable WAL queue processing and acknowledgement validation with a clearly identified in-process transport mock. A 500-record packet encodes in a 13.67 ms median and compresses 500,560 to 48,446 bytes. Fifty 100-record packets drain in 385.37 ms over two ticks, with 50 ingest calls and zero pending work. Lost-ACK recovery reuses identical saved wire bytes; a received acknowledgement is polled without retransmitting its ingest. These are component baselines, not real network throughput. No uploader behavior was changed without evidence of a current transport bottleneck.

A local materializer candidate reduced the number of per-turn reads but did not show a reliable elapsed-time benefit and was removed before final verification. Summary, project grouping, unfiltered native trends and full cold import showed no meaningful speedup. The current IndexedDB batching was measured without an additional production cache change. Warm browser samples were too short to establish a page-latency improvement from the initial route split; the bundle reduction is measured directly.

## Reproduction and detailed evidence

- [Collection inputs, hashes, serial/bounded metadata comparison and rejected candidate](performance-current-collection.md)
- [Native SQL, BigInt, D1 plans, complete results and DST verification](performance-current-analytics.md)
- [Cloud publication bindings, exact entities, atomicity and samples](performance-current-cloud.md)
- [Actual codec/uploader baseline and recovery semantics](performance-current-upload.md)
- [Browser builds, CUA samples, real IndexedDB and offline verification](performance-current-browser.md)

Common entrypoints:

```powershell
npm run perf:collection -- --label current --rounds 3
npm run perf:queries -- before
npm run perf:queries -- after
npm run perf:cloud -- current
npm run perf:upload
npm run perf:browser:build -- current
```

Labels name artifacts; they do not switch source versions. Reproduce a baseline in a separate checkout of `f25aaf9` with the new harness copied in, preserve its outputs, then run the candidate against the same input. Browser measurement and acceptance use CUA. No Playwright test was used.

## Integrated verification and deployment boundary

Completed on the final production implementation:

- `npm run build`: passed architecture validation, all three root TypeScript checks, local production assets and server compilation. The architecture report has no file/module cycles, unresolved imports or boundary violations.
- `npm test`: 225 tests, 221 passed and four platform-specific skips, zero failures. The final run includes the additional failed-Git-prefetch and ordered-fallback regression.
- `npm run cloud:test`: parity/origin/billing fixture generation and 17 Workerd test files, all 96 tests passed. This includes the existing 100k query-scale, integer safety, publication, budget, recovery, origin, lease and deletion tests.
- `npm --prefix cloud run check` and `npm run cloud:build`: passed cloud types and the complete cloud production bundle.
- `npm run smoke`: production local API/assets, empty home and independent account-error behavior passed.
- `npm run package:smoke`: the actual local package installed into an isolated prefix and passed CLI/shim, API/assets, service lifecycle, version identity, refresh, autostart, skill lifecycle, reinstall/data preservation, migration, stale recovery and port-conflict checks.
- CUA: local overview, analysis, task list/detail, settings, shared charts and real IndexedDB checked. The cloud fixture uses actual local Workerd/D1 with synthetic 72,000-token history. Eager route code remained available for first offline visits. The browser report records the protocol-gate limitation separately.
- Independent read-only review found no blocking issue in metadata concurrency or query semantics. `git diff --check` passed.

Logs are `build.log`, `root-tests.log`, `cloud-tests.log`, `cloud-check.log`, `cloud-build.log`, `smoke.log` and `package-smoke.log` under `artifacts/performance-current/`.

Browser timing uses IAB 152 at 1280×720. Three alternating cold pairs disable the HTTP cache and simulate 80 ms latency with 196,608 bytes/s upload/download, without CPU throttling. FCP median is 1,712 → 1,576 ms and chart DOM appearance is 1,884.9 → 1,767.2 ms. Five alternating warm pairs with the same observation setup have FCP/LCP 64 → 64 ms; no warm-page speedup is claimed. DOM appearance is not a paint metric. Network/cache simulation was restored after measurement.

An existing cloud version-gate limitation appeared during offline acceptance: compatibility polling can hide the site after approximately 15 seconds of failed network reads. Initial offline navigation to all eager routes was verified. The gate source is unchanged from HEAD, and the frozen baseline bundle contains the same failure branch; a separate before-version offline runtime replay was not performed. This round preserves the loading contract but does not claim unrestricted long-lived offline use or fix that pre-existing gate behavior.

The original 100k upload-under-one-minute and two-device production P90 targets were not re-certified by these local fixtures. This round does not deploy a Worker, mutate a remote D1 database, commit, push, merge, tag or publish npm. It leaves a reviewable local implementation with reproduction scripts, full evidence and regression checks. Existing uncommitted `AGENTS.md`, `docs/design/benchmarks/` and `experiments/` material present at task start is preserved.
