# Shared analytics performance investigation

The baseline is the shared query engine at `f25aaf9`, measured on 2026-09-12 with Node 24.16.0 on Windows. This investigation covers the generator-driven SQLite query path used by local analytics, D1, and the browser showcase. Browser sync analytics and HTTP rendering are measured separately.

## Reproduction and evidence

```powershell
node --import tsx scripts/benchmark-analytics-current.ts before
node --import tsx scripts/benchmark-analytics-current.ts after
```

Run `before` on the baseline code and `after` on the optimized code, preserving the first output files. The fixture creates 10,000 and 100,000 active events in a native in-memory SQLite database, spread uniformly across 180 days from 2026-01-01. There are 1,000 thread IDs, 17 projects, three model/effort combinations, standard/fast service tiers, null turns, and missing cache-write values. All timestamps and input values are deterministic. Cost estimation is enabled; the fixture models are outside the current price catalog, so these workload results include incomplete-cost outputs. Separate regression cases verify complete exact costs with fixed custom prices.

Every operation runs once while recording its SQL and `EXPLAIN QUERY PLAN`, then three additional times without instrumentation. Reported latency is the median of the latter three; fixture construction and full-result comparisons are outside those timings. Each repetition must deep-equal its warmup result, and the optimized run must deep-equal the complete baseline output. Measurements were scheduled separately from other agents' builds and benchmarks.

BigInt fallback reproduction:

```powershell
$env:ANALYTICS_SIZES='2048'
$env:ANALYTICS_REPEATS='3'
$env:ANALYTICS_FALLBACK='1'
$env:ANALYTICS_CASES='summary,groups,threads,turns,day180,hour7'
node --import tsx scripts/benchmark-analytics-current.ts before
node --import tsx scripts/benchmark-analytics-current.ts after
```

The fallback fixture adds `2^100` to every total-token value, forcing the existing bounded BigInt path. All raw evidence is in `artifacts/performance-current/analytics`: `before.json`, `after.json`, `fallback-before.json`, `fallback-after.json`, per-operation complete baseline JSON outputs, SHA-256 values, statements, and query plans. These are local experimental artifacts, not production data.

## Findings and implementation

1. A filtered hourly trend caused SQLite to choose events as the outer loop and scan all generated JSON buckets for each selected event. The seven-day filter covered 168 hours around the March DST transition; on the 100,000-event fixture it took 566.3 ms despite matching only about 3,889 events. Unfiltered trends already chose indexed bucket-to-event lookup. The bucket source now uses an explicit `CROSS JOIN` so the range lookup remains inside the bucket loop. Date predicates on these joins use `+at` to keep their exact comparison while removing them as competing index constraints: the index must use each bucket's narrow bounds. Both stored timestamps and normalized filter parameters are canonical ISO strings, so removing column affinity does not change their comparison. Range detection and SQL safety probes retain their original indexed date filters. The Luxon bucket generation, labels, DST handling, date filters, and 20,000-bucket limit remain the same.
2. Turn composition used a correlated `EXISTS` to parse and scan up to 50 selected tuples for every candidate event. At 10,000 events, that statement alone took 137.4 ms. The shared page filter now restricts thread IDs through an indexed `IN` set, then tests canonical JSON tuple membership in a noncorrelated `IN` set. JSON tuple encoding keeps null distinct from the string `"null"` and preserves quotes, separators, backslashes, and Unicode. Composition and cost queries, including the fallback composition scan, share this filter.
3. Thread pagination counted rows of a subquery that calculated every token metric, distinct count, and timestamp aggregate. The count query now groups only the thread key, matching the already established turn-count query. The separate page query still calculates every returned metric; ratio-filtered pages continue to use exact aggregation.

The intermediate `CROSS JOIN`-only experiment improved the 100,000-event filtered hourly query to 377.6 ms, but its index still scanned the entire selected week for each bucket. Adding the nonindexed outer date predicates reduced it to 37.3 ms. The intermediate results and query plan are retained as `after-cross-join-only.json` and `100000-hour7-after-cross-join-only-statements.json`.

## Native SQLite results

All 14 normal-path outputs and all six fallback outputs deep-equal the complete baseline results and have matching SHA-256 values.

| Events | Operation | Before median | After median | Change |
| ---: | --- | ---: | ---: | ---: |
| 10,000 | Summary | 59.7 ms | 58.8 ms | -1.4% |
| 10,000 | Project groups | 65.0 ms | 65.8 ms | +1.2% |
| 10,000 | Threads, page 50 | 62.0 ms | 53.0 ms | -14.6% |
| 10,000 | Turns, page 50 | 216.1 ms | 67.6 ms | -68.7% |
| 10,000 | Daily, 180 days | 82.3 ms | 82.7 ms | +0.5% |
| 10,000 | Hourly, filtered 7 days | 63.1 ms | 10.9 ms | -82.8% |
| 10,000 | Hourly, 180 days | 247.6 ms | 249.8 ms | +0.9% |
| 100,000 | Summary | 656.1 ms | 661.5 ms | +0.8% |
| 100,000 | Project groups | 733.3 ms | 723.6 ms | -1.3% |
| 100,000 | Threads, page 50 | 592.8 ms | 493.6 ms | -16.7% |
| 100,000 | Turns, page 50 | 2,150.2 ms | 653.6 ms | -69.6% |
| 100,000 | Daily, 180 days | 743.4 ms | 746.5 ms | +0.4% |
| 100,000 | Hourly, filtered 7 days | 566.3 ms | 37.3 ms | -93.4% |
| 100,000 | Hourly, 180 days | 1,065.4 ms | 1,060.7 ms | -0.4% |

The 2,048-event BigInt fallback turn page improved from 54.9 to 29.1 ms (-46.9%), and its filtered hourly trend from 9.5 to 4.1 ms (-56.8%). The other fallback operations were within approximately 0.3–0.9 ms of baseline. Summary, group, and unfiltered trend timings show no meaningful improvement; the implementation targets page selection and filtered bucket lookup.

## Workerd and D1 validation

```powershell
cd cloud
node node_modules/vitest/vitest.mjs run test/v3-query-scale.test.ts test/performance-analytics-current.test.ts --reporter=verbose
```

Both tests passed in 30.31 seconds. The existing scale test checks 100,000 fixed-cut events through every shared usage view. The new test uses 10,080 events over 14 days, with 30 events per UTC hour across the New York spring DST change. It evaluates filtered and unfiltered day/hour trends, complete priced costs, a 23-hour day, and the missing spring hour. Complete outputs are compared against the original trend SQL shape executed against the same immutable lease. This isolates the bucket join and index-selection changes; it does not claim a historical deployment benchmark.

The actual D1 `rows_read` totals for those query runs were:

| Trend | Original SQL shape | Optimized | Reduction |
| --- | ---: | ---: | ---: |
| Unfiltered, day | 443,528 | 141,242 | 68.2% |
| Unfiltered, hour | 6,914,888 | 143,810 | 97.9% |
| Seven-day filter, day | 151,212 | 72,010 | 52.4% |
| Seven-day filter, hour | 1,764,012 | 71,910 | 95.9% |

Every optimized D1 plan places `usage_bucket` outside a `v3_entity_time` search constrained by user, epoch, and both timestamp bounds. The original safety and range queries retain normal indexed date conditions; only the bucket join's outer date predicates are disqualified as competing index constraints. `FilterSchema` defines `from` and `to` as date-time strings, and `where()` normalizes them to ISO strings before binding.

Full SQL, bound synthetic parameters, per-statement timing, actual rows read, and plans from the measured run are preserved in `artifacts/performance-current/analytics/d1-evidence.json`, with original output in `d1-tests.log`. Routine future test annotations omit full SQL and large JSON bucket parameters to keep CI output manageable.

## Correctness and boundaries

The added regression tests check native and sql.js SQLite against independently stated expectations for tuple collisions, nullable turns, page offsets, event filters, composition metrics, and exact priced costs. Separate fixed expectations cover both occurrences of the New York DST overlap hour, exclusive end boundaries, and Kathmandu's 45-minute timezone offset. Each case also exercises forced BigInt fallback. Existing exact-query tests cover 128-bit values, SQL overflow safety, invalid token storage, precise cache-ratio thresholds, 512-row fallback blocks, searches, comparisons, and agent trees.

The 11 focused native/sql.js/exact regression tests passed before and after the final implementation. The new Workerd/D1 test and existing 100,000-event scale test also passed with the final production code. Follow-up test-only adjustments reduce diagnostic output and align composition checks with its public DTO; the two new native/sql.js regressions passed again after that adjustment.

These timings describe repeated native SQLite queries on deterministic inputs; the D1 evidence comes from the real local Workerd/D1 test runtime. They do not establish remote production D1 latency, network latency, or physical-device rendering performance. Three timing repetitions are a practical local baseline, not a statistical confidence interval. The parent performance task records the full repository integration results.
