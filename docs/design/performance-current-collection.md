# Collection performance, 2026-09-12

This measurement uses the current modular product at baseline commit `f25aaf9dcdb4ad31232bb78b2ab5876b95949390`, Windows 11, Intel Core i7-13700KF and Node 24.16.0. It runs the actual `StreamingImporter`, SQLite WAL storage, collection, local materialization and status publication. Upload and browser rendering have separate measurements.

## Fixed input and result

The existing read-only frozen snapshot at `artifacts/implementation-v3/real-log-parity/source` contains 219 JSONL files and 717,782,514 bytes. A before/after SHA-256 manifest check verifies every source file. Each measured cold scan starts with a fresh database and the same fixed collector identity, followed by three unchanged scans. There are three independent database runs per version, producing three cold and nine unchanged timing samples. Source preparation, constructor/schema initialization and output hashing are outside the measured interval. OS caches are not forcibly cleared; the first collection is a fresh-database scan, not a claim about cold OS disk caches.

| Boundary | Before median | Final median | Interpretation |
| --- | ---: | ---: | --- |
| Fresh database, full importer scan | 10,076.8 ms | 10,172.4 ms | Similar elapsed time; no cold-import speedup is claimed |
| Complete unchanged scan, including metadata refresh and status mirror | 1,724.0 ms | 685.1 ms | 60.3% less elapsed time |

All six databases produced the same 17,936 complete effective-event rows and 218 complete thread rows. Their canonical JSON SHA-256 is `b2027eaa2c0b81acf675a56a72c4654e0ae8df077198376c22fcd4fab62191ea`. The input manifest SHA-256 is `106413ab4691d9713124a42a18bc6da2fec1aee83cbcc07502497f24fd29750e`. Unchanged scans reread zero log body bytes and preserve the same result hash. SQLite integrity checks passed; final cursors are caught up and within each source's snapshot size.

These are sequential before/final series collected in coordinated timing windows. The unchanged before samples are 1,708–1,770 ms and final samples 677–717 ms. The non-overlapping samples support the improvement in this machine's workload. They do not estimate a multi-platform p95 or a production end-to-end latency.

## Change and rejected candidate

Metadata refresh previously awaited each repository's Git reads before starting the next repository. `ProjectSourceResolver.resolveMany` now prefetches independent repository reads with at most four tasks. Concurrent paths in the same repository share one pending result. Each repository retains its existing three independent read-only commands plus dependent tracking-remote query. There can be at most twelve Git commands in flight, and individual commands retain their timeout and output bounds.

Only the repository I/O is prefetched. Actual source resolution and persistence still run in input order, preserving historical evidence, conflict and fallback semantics. Each full scan still refreshes the App map and invalidates repository evidence, so renamed projects, changed remotes and source reassignment remain visible. No cross-scan result TTL is introduced.

A separate candidate combined affected-turn reads inside the local materializer. A 10,000-event synthetic workload changed from about 1.803 s to 1.763 s in an unprofiled confirmation series, while real fresh scans did not improve. That small result was insufficient to justify retaining the extra change. The materializer was restored and the final real-input measurement repeated. Intermediate `after` and `after-real` artifacts describe that discarded candidate, not the final source; use `final-real.json` for this delivery.

The synthetic fixture also measures five single-event append/drain operations per run. Most steady samples are approximately 2.5–3.3 ms; occasional first samples are 17–19 ms in both versions. No incremental-latency improvement is claimed. A separate CPU-profile baseline identified durable commits, stable serialization and SQLite work as the main cold-scan costs. Durable transaction boundaries and exact parsing remain intact.

## Reproduce and verify

```powershell
# Portable deterministic 100-file / 10,000-event fixture; no account or network needed.
npm run perf:collection -- --label current --rounds 3

# Use an existing read-only snapshot and check complete outputs against saved baseline.
npm run perf:collection -- --label current-real --rounds 3 --source artifacts/implementation-v3/real-log-parity/source --compare artifacts/performance-current/collection/before-real.json

node --import tsx --test tests/performance-collection.test.ts tests/project-source.test.ts tests/collector-v3.test.ts tests/collector-origins.test.ts
```

The benchmark label only names output. To reproduce old source, use the baseline commit in a separate checkout with the new benchmark script copied in. This run also preserved executable bundles of the original and intermediate code in ignored artifacts. Raw inputs, local databases, full profiles and measurements remain in `artifacts/performance-current/collection/`; the durable source entrypoint is `scripts/benchmark-collection.ts`.

`tests/performance-collection.test.ts` compares bounded and serial project resolution over multiple repositories and nested paths, checks shared repository reads and the concurrency ceiling, and verifies that invalidation observes changed repository evidence. A second case checks a failed prefetch retries for the next source and that later unavailable paths still reuse earlier successful historical evidence in the original order. Existing importer tests cover consumer crash recovery, append proofs and rebinding, source replacement, native directory aliases, unavailable sources and App project renaming.
