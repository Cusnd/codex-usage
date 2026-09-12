# Fast attribution and subscription pricing

## Scope and decisions

Estimates use Token quantities multiplied directly by USD unit prices. The default
billing basis is subscription mode. A settings checkbox,
`officialApiPricing`, opts API Key users into the existing USD API price table.
An absent setting is false, including existing installations. The independent
`costEnabled` visibility preference and saved custom API prices are preserved.

Subscription estimates use the published Standard USD input, cached input and
output prices as a reference table, with a 2.5 multiplier for Fast.
API estimates retain API long-context and cache-write rules. Each basis applies
its own documented Fast rate. Token counts and cache ratios are never multiplied.
API Fast uses the verified multiplier 2. New estimates carry USD and their billing
basis; older cached units remain authoritative. There is no credit conversion
calculation or exchange-rate setting.

## Attribution and history

The extractor retains only the allowed mode fields from settings and lifecycle
records. Events carry `service_tier` (`standard`, `fast`, `unknown`) and
`service_tier_source` (`record`, `settings`, `unknown`). Missing legacy fields mean
unknown. A mode change during an active turn makes the remaining configured
attribution in that turn unknown, until a new turn establishes a clean boundary.
Child tasks use their own mode history. Direct usage-record evidence takes priority
over inferred settings; contradictory equally strong evidence remains unknown.

Extractor v2 accepts immutable pending v1 batches. Existing available sources are
reprocessed once through new generations; completed old generations stay visible
until replacement is complete. Source identity, raw-prefix origin proofs and
response-based event IDs are preserved. Deleted native logs cannot be backfilled.
No chat or tool bodies are included in the new projection.

## Integration

The same shared estimator and tier groups serve local SQLite, cloud fixed-cut
queries and the bounded BigInt fallback. Local storage adds nullable metadata
columns; cloud event JSON already supports these metadata fields. Existing cloud
rows without metadata remain unknown, and pinned old reads remain unchanged.

The existing price settings and usage components show USD in both modes.
Fast and unknown usage are visible alongside the estimate.
Unpriced or unknown-tier usage is excluded from the known estimate and reported as
incomplete, rather than silently charged as Standard.

## Verification coverage

- Actual collector fixtures: own/child modes, turn switches, explicit records,
  old logs, duplicate copies, restart and historical generation replacement.
- Exact billing arithmetic: Standard/Fast for both billing modes; cache and long context;
  unknown prices and tiers; SQL/BigInt equality; unchanged token totals.
- Local and cloud settings persistence, fixed old/new cloud cuts and replay.
- CUA acceptance of the shared settings checkbox, saved custom API prices,
  USD values and Fast/unknown breakdown.

## Official references

- [Subscription pricing](https://learn.chatgpt.com/docs/pricing)
- [Fast mode](https://learn.chatgpt.com/docs/agent-configuration/speed)
- [API pricing](https://developers.openai.com/api/docs/pricing)

## Results on 2026-09-12

Implementation is complete in the development workspace. The local and cloud
frontends retain their existing complete UI and use the shared estimator. This
record covers this billing upgrade; it does not change the earlier acceptance
record's deferred performance work or claim a production rollout.

| Check | Result |
| --- | --- |
| Production build, including TypeScript | Passed |
| Root regression suite | 208 passed, 4 platform skips, 0 failed |
| Cloud type check and native collector fixture generation | Passed |
| Cloud Worker/D1 regression suite | 95 passed across 11 files, 0 failed |
| Cloud frontend production build | Passed |
| Production service smoke | Passed: assets/API, empty home, missing CLI, independent account errors |
| CUA local browser | Subscription default, API opt-in, custom price save/reload, return to subscription, preserved custom price |
| CUA cloud browser | Subscription/API/subscription save and reload; matching amounts, unchanged tokens and visible Fast/unknown rows |

The actual native-log collector fixture contains three GPT-6 Astra usage records:
Standard, Fast and an ambiguous mid-turn switch. Each has 1,000 input Token,
including 200 cache reads, and 100 output Token. Both query paths and both runtimes
retain 3,300 total Token, with 1,100 in each tier group. The subscription USD
reference table produces 0.0132 Standard + 0.033 Fast = **0.0462 USD**. The API table produces
0.0132 Standard + 0.0264 Fast = **0.0396 USD**. The unknown group remains unpriced.
In local CUA, changing Astra's API input rate to 17 produced **0.0564 USD**; the
saved 17 survived reload and a switch to subscription and back.

The cloud integration test uploads an old extractor-v1 generation and then the
actual collector's extractor-v2 replacement in small batches. Every intermediate
visible cut retains the complete old 3,300-Token view until replacement publishes.
The resulting DTO matches local calculation for subscription and API modes. Old fixed cuts
retain their prior billing settings and event state, and replaying an old packet does not
revert the upgraded data. Separate collector tests verify unchanged pending wire,
one-time reprocessing, duplicate enrichment and stable append origins.

Exact query caches include the shared `token-usd-v1` computation revision. Cached
credits results from the earlier development build cannot satisfy a new USD query,
even when the source cut is unchanged. This leaves source entities and history
intact. Regression coverage verifies an explicit offline cache miss before the new
result is fetched, followed by offline availability of the correctly cached USD
result. CUA verified the existing cloud browser cache updates after loading the
new build, then preserves USD through API/subscription switches and reload.

CUA screenshots and accessibility snapshots used isolated local services and
synthetic data. The observed viewports were approximately 606 px and 1265 px wide;
this is browser layout evidence, not physical-device testing. Cloud acceptance
ran the actual Worker against local D1 with a fixture-only login wrapper.

Detailed logs and browser screenshot/snapshot pairs are indexed in
[the verification artifact](../../artifacts/fast-billing-20260912/README.md).

## Rollout and remaining boundaries

Release the compatible backend before the v2 collector, then let available source
generations complete their normal replacement. No new D1 migration is needed for
these service-tier fields. Old installations default to subscription even if they
saved API custom prices; API users must explicitly opt in. The independent
estimate visibility preference stays as saved.

No npm package, Git commit or production deployment was created by this upgrade.
The current prices were checked against the sources above on 2026-09-12; these are
Token estimates, not provider invoice or account-quota reconciliation. Historical
logs without reliable mode evidence remain explicitly unpriced.
