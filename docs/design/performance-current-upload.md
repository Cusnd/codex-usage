# Local uploader baseline, 2026-09-12

This is an additional current-code baseline and protocol/scheduling review. No uploader production code is changed.

Run `node --import tsx scripts/benchmark-uploader-current.ts` from the repository root. Raw samples, CPU/wall timing, packet byte counts, call counts, per-tick pending/continuation states and recovery assertions are saved to `artifacts/performance-current/upload/current.json`. Fresh file-backed SQLite WAL databases are retained in the same ignored artifact directory.

The benchmark uses the real `encodeUpload`/`decodeUpload`, `Store`, `Collector` configuration, `UploadLedger` and `V3Uploader.tick` implementations. Synthetic valid packets are inserted as already locally applied inputs, so collection, local materialization and source discovery are excluded. Transport is an in-process fetch implementation that checks protocol responses, decodes every actual gzip packet, compares the entire decoded batch, and returns synthetic acknowledgements. It never contacts the `never-contacted.invalid` origin. Queue wall/CPU therefore includes the mock receiver's decode and validation, but excludes HTTP/TLS, Internet latency and actual cloud D1 application.

The fixed fixture has exact token strings above the JavaScript safe-integer range, a fixed timestamp and deterministic record identities. Codec measurement uses 500 records (one warmup plus five samples). Queue measurement uses 50 packets of 100 records, split evenly between live/backfill lanes (one warmup plus three samples). CPU values are process user plus system CPU deltas; compression may execute on Node's worker pool. The uploader's ordinary one-second deadline uses the real clock. Only the separate retry/receipt recovery scenarios advance the injected clock by ten seconds to avoid waiting; this does not represent measured retry latency.

Current measurements on Windows `10.0.26200`, Intel Core i7-13700KF, Node `v24.16.0`:

| Measurement | Result |
| --- | --- |
| 500-record real encode median wall / process CPU | 13.67 / 16 ms |
| 500-record decoded JSON / gzip bytes | 500,560 / 48,446 bytes (90.32% smaller) |
| 50 × 100-record queue median wall / process CPU | 385.37 / 375 ms |
| Queue ingest bytes | 522,967 bytes |
| Queue ticks / ingest / handshake / receipt / status calls | 2 / 50 / 2 / 0 / 1 |
| Queue final pending / live applied / backfill applied | 0 / 25 / 25 |
| Lost-ACK simulation | 2 ingests, identical saved wire bytes, final pending 0 |
| Received-ACK simulation | 1 ingest + 1 receipt poll, final pending 0 |

The successful queue drains 32 packets in its first tick and 18 in its second, matching the 16-per-lane bound. These were sub-second drains, so the count cap determined the continuation. The lost-ACK scenario is a rejected fetch after decoding a packet; it proves persistence and byte-identical retry, not an actual cloud commit before losing a response. Its first retry delay was approximately one second before the injected clock advance. The received scenario retained the original pending packet until the synthetic applied receipt. Every codec and transmitted packet passed the current production validator and whole-batch round-trip equality; the mock explicitly checks request version, authorization and ingest content-type headers. The real version handshake and acknowledgement validation code executes unchanged.

The current scheduling/contract boundaries, verified from source, are:

- Encoding validates the packet and records hash, enforces decoded/wire limits, and asynchronously compresses at gzip level 1. Persisted wire bytes and their checksum are reused on retry.
- Each tick shares one version handshake and drains live/backfill concurrently. Each lane permits at most 16 sends within one second, with only one active request in that lane. Earlier unapplied work in the same lane or source blocks later work. A successful bounded drain requests one immediate continuation; empty or failed work uses the outer scheduler's ordinary delay.
- A `received` acknowledgement retains packet state and stops that lane. Later ticks poll individual receipt IDs, up to 16 per tick. Individual polling protects the other lane from a terminal error attributed to a different receipt.
- Applied acknowledgements validate wire/record hashes and contiguous progress before transactional cleanup. Network errors preserve bytes and use exponential backoff with jitter and Retry-After. Contract/identity errors block the packet instead of discarding it.
- Each tick currently repeats its version handshake. Status reporting is suppressed for an identical body for up to 15 seconds. Neither behavior is changed by this baseline.

The script checks a lost acknowledgement retries identical persisted gzip bytes and ultimately clears the queue, and checks `received → receipt poll → applied` completes without retransmitting the ingest body. Existing `tests/uploader-v3.test.ts` covers additional invalid ACK, version mismatch, blocked receipt and source/lane scheduling cases.

Potential future investigation is limited to real deployment evidence: if handshake round-trip time dominates very small packets, examine safely sharing compatibility evidence across bounded ticks; if received queues dominate, examine bounded polling concurrency while retaining per-ID error attribution. This fixture has no network latency and cannot justify either production change. Changing gzip level or concurrency without such evidence would not be an established optimization.
