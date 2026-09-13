# Cloud publication performance, 2026-09-12

Scope: local Workerd/D1 publication from a received v3 packet to its applied receipt. The source baseline is `f25aaf9dcdb4ad31232bb78b2ab5876b95949390`. No remote database, deployment, schema migration, protocol, or browser behavior is changed.

## Workload and measurement

`node cloud/test/run-publication-benchmark.mjs baseline` captured the unmodified production implementation. `node cloud/test/run-publication-benchmark.mjs after` runs the same workload against the optimized implementation. Each run writes a raw log and JSON with platform metadata, every sample, a full SQL trace, bound value byte counts, D1 row counts, phase timing, and a normalized canonical output fingerprint under `artifacts/performance-current/cloud/` (ignored generated artifacts).

The fixture creates 200 or 500 valid records across 20 sources/threads, with one turn per thread and fixed timestamps. Each case has one warmup and five measured applications. The measured operation is job claim plus `applyBatch`; receipt staging, gzip creation, fixture construction and correctness queries are outside the timed interval. Each round starts with a new account. The cases use the ordinary local D1 binding without artificial network delay, and timing windows are coordinated with the other performance tasks.

The measured machine was Windows 11 (`10.0.26200`), Intel Core i7-13700KF, Node `v24.16.0`, Vitest `4.1.11`, and the repository's locked local Workerd/D1 runtime. Results:

| Events | Median before → after | Bound bytes before → after | SQL statements before → after | Binding calls | Rows written |
| --- | --- | --- | --- | --- | --- |
| 200 | 97 → 92 ms (5.2% lower) | 2,064,175 → 1,280,188 (38.0% lower) | 70 → 67 | 9 → 9 | 5,301 → 5,301 |
| 500 | 314 → 162 ms (48.4% lower) | 5,005,240 → 3,049,230 (39.1% lower) | 76 → 72 | 9 → 9 | 12,201 → 12,201 |

The 200-record wall-time difference is small relative to sample variation; the stable result is the 38% binding reduction. The 500-record case shows a larger measured improvement, but five local samples do not establish production latency. These changes do not reduce binding round trips or persisted rows. First measured D1 rows read were 2,918 → 2,916 and 6,219 → 6,217, so this is primarily a serialization/SQL input reduction, not a historical-scan optimization.

All six canonical output fingerprints per workload matched across runs: `5af6d187cfc8748ec75c21d174499ef4d8c22f3be3988cc35a3640b9ff87bd43` for 200 events and `08d7565919d2362d013b5637b7ff501d4b23ddcaf6eda61d3d1c5e4c1d7ba69a` for 500. Full stored entity, hash, change and exact aggregate checks passed in every iteration. The all-events total remained `1801439850948200200` / `4503599627370500500` respectively.

The input uses exact decimal strings above JavaScript's safe integer range: input `9007199254740994`, output `7`, total `9007199254741001`. Every iteration verifies all canonical event fields against current entity payloads, every stored SHA-256 hash, every complete change record, commit entity counts, exact aggregate sums, thread/turn counts, and unknown cached tokens. Cross-run output fingerprints normalize only generated observation, collector, device, and project identities; stored data is checked before this normalization.

`binding_bytes` is the sum of UTF-8 string binding sizes, buffer lengths, and numeric/null text lengths for executed statements, counted again when a value is reused by another statement. It excludes SQL text and transport framing and is not a Cloudflare billing metric. The test proxy implements `first` through `all` to collect D1 row metadata; this identical instrumentation is present in both measurements. Timing is local wall time with Workerd's millisecond precision, not production latency, CPU usage or a p95 estimate.

## Implemented change

The largest bindings in the baseline were chunks near 350 KB. Entity publication serialized each canonical value twice: once as the `value` object and again as the `payload` string. It sent this combined representation to the old-version UPDATE, new-version INSERT and changes INSERT, although the UPDATE only uses `kind` and `id`. The event upsert similarly included the full canonical object alongside its payload despite needing only index columns.

- `modules/sync/publication/store.ts` serializes each entity value once, uses that same string for hashing, excludes the redundant object, and sends only kind/id pairs to version closing.
- `modules/sync/apply/materialization.ts` sends only the columns read by the event INSERT together with the unchanged full payload.

Payloads still include all exact token strings and origin evidence. Null tombstones remain SQL NULL with the hash of canonical `null`. Chunk sizes remain bounded by the existing helper, and all prepared writes remain inside the same guarded D1 batch. Smaller rows can reduce the number of SQL statements without splitting publication into multiple transactions. The final epoch/write-version, device and job-lease guards, acknowledgement and query budgets are unchanged. [D1 documents batched statements as sequential transactions that roll back together on failure](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

## Verification

`cloud/test/v3-entity-publication.test.ts` covers a Unicode/quoted ID shared by an event and thread, distinct composite keys, revisions, old-version closing, unknown token values, SQL NULL tombstones, payload hashes, complete commit counts, and rollback of a stale publication without residual guard rows. The existing v3 and job-budget tests are used for lease, replacement, origin and whole-batch budget behavior.

Executed successfully after implementation:

```powershell
node cloud/test/run-publication-benchmark.mjs after
node cloud/test/compare-publication-benchmarks.mjs
# From cloud/:
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run test/v3-entity-publication.test.ts test/v3-apply-performance.test.ts test/v3-job-budget.test.ts test/v3.test.ts --no-color
```

The benchmark's two cases passed, the type check passed, and the focused suite passed all 39 tests in four files. The suite covers frozen lease reads, rollback, large replacement publication, device deletion, exact oversized integers, whole-batch query admission, reserved lease-release budget, and recovery after budget exhaustion. Final repository-wide integration checks are recorded in the main performance report.

The benchmark runner and its reporter are test-only. Reproducing the baseline after these edits requires a separate checkout of the baseline commit with the new benchmark harness copied in; running the `baseline` label against optimized source merely names an output file and does not restore old code.
