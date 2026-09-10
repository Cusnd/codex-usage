# Technical reference

[Home](../README.md) · [User guide](USER_GUIDE.md) · [Contributing](../CONTRIBUTING.md)

This document describes the local application's interfaces and counting rules. For a running installation, the generated [API documentation](http://127.0.0.1:8765/docs) and [OpenAPI schema](http://127.0.0.1:8765/openapi.json) are the authority for complete parameters and responses. Substitute your configured port.

## Runtime and storage

Version 0.1.3 supports Windows x64 and macOS x64/arm64 with Node.js 22.13+ (22.x), 24.x, or 26.x. SQLite is provided by Node; no separate database or Python installation is required. Web assets are resolved relative to the installed package, independently of the working directory.

For macOS, see [validation status](MACOS_COMPATIBILITY.md). The required macOS version follows the selected Node distribution. Data defaults to `~/Library/Application Support/CodexUsage`, overridden by `CODEX_USAGE_DATA_DIR`; original records use `~/.codex`, overridden by `CODEX_HOME`.

Windows starters hold a named pipe. macOS holds an exclusive loopback listener at `49152 + first_uint16_be(SHA256(realpath(dataRoot))) % 16384`. Starters for the same real directory share a guard regardless of HTTP port; the kernel releases it on crash. Hash collisions or foreign listeners fail closed with details in `service.log`. No alternate guard is selected and no foreign process is killed. The guard has no control API. If a custom HTTP port equals the guard port, select a different HTTP port.

macOS autostart writes a user LaunchAgent (`CODEX_USAGE_STARTUP_DIR` overrides its directory for tests), with `RunAtLoad`, no `KeepAlive`, and a one-shot CLI `start` launcher. It captures absolute Node/CLI paths plus PATH, PORT, CODEX_HOME, CODEX_BIN and data-root values. The `supported/enabled/conflict` API shape is unchanged: enabled means a validated owned registration for future logins, not a running launchd job or OS background-item approval.

Project normalization follows recorded path format: drive/UNC paths retain Windows rules, POSIX paths preserve case. Import metadata version 2 re-reads cached sources once, replacing derived rows without changing logs. Missing sources cannot recover previously lost casing; their cached rows are retained.

| Setting | Purpose |
| --- | --- |
| `CODEX_HOME` | Codex source directory; defaults to the user's `.codex`. |
| `CODEX_USAGE_DATA_DIR` | Overrides the platform data directory described above. |
| `PORT` | Overrides the default port 8765. The server binds to `127.0.0.1`. |
| `CODEX_BIN` | Explicit Codex executable or supported npm JS/shim entry for account capabilities. |
| `CODEX_USAGE_URL` | Connects CLI queries to an already-running HTTP loopback origin; disables query/status auto-start. |
| `CODEX_USAGE_STARTUP_DIR` | Overrides the startup directory, including for isolated lifecycle tests. |

The cache contains statistical metadata, task titles, project paths, source information, and account snapshots. It does not persist chat bodies, tool output, or login credentials. Logs and instance information live alongside the cache; the instance control token is private and must not appear in reports.

Source records are read-only. Local collection reads `sessions` and `archived_sessions` inside the Codex directory. Titles come from the latest valid matching entry in `session_index.jsonl`, falling back to the project name and a short ID. Chat text is not used to invent a title.

The first import processes files individually. Subsequent imports skip unchanged files and resume growing files after the last complete line. Imported records from deleted source files are retained. To rebuild exclusively from the currently available files, stop the service, back up and move aside this tool's cache database, then restart.

## Counting rules

Explicit `token_usage_record.usage` records take precedence and are deduplicated by response ID. Where explicit usage exists for the same task/turn, old `token_count` mirrors are excluded. Legacy records use deduplicated snapshots, then `last_token_usage`, and finally cumulative high-water deltas. Unknown inherited history is conservatively excluded and reported as an anomaly.

Duplicate files retain their source contributions, but queries select one contributing copy. The `active` flag records import-time participation, not a summary cache; reparsing recalculates participation transactionally.

- Input includes cached input. Reasoning output is included in output. Neither is added again to the total.
- Cache share is the sum of valid cached input divided by the corresponding input sum, not the average of individual percentages.
- Uncached input includes cache writes. Missing writes are not replaced with zero; inseparable ordinary input can be null. `cacheWriteMissingEvents` exposes missing coverage.
- Unknown models, projects, and turns remain represented. Project groups use normalized working directories; worktrees are not merged.
- Token API values are decimal strings, preserving large-integer precision through JSON and SQLite. Charts use million-token units while detailed values retain precision.

Local time filters and trend buckets use the selected timezone. `from` is inclusive and `to` exclusive. Account daily buckets retain their server dates and are not rebucketed or combined with local timezone-adjusted totals.

These records are not a complete billing ledger. The tool does not provide subscription fee conversion, complete cross-device coverage, tool performance analysis, or multi-user service support.

## Agent relationships

Only `source.subagent.thread_spawn.parent_thread_id` establishes a subagent parent. `forked_from_id` is recorded separately; a normal fork does not contribute to a team. Navigation distinguishes parent/child agents from fork relationships.

The agents query resolves the full known family before filtering usage. A filtered-out intermediate agent cannot hide its descendants. Each row contains only its own usage; `self`, `subagents`, and `team` give the root, all descendants, and their combined metrics. Full-task details use the full range, while scoped details retain the current filters.

Known agents without valid usage remain accessible with empty metrics. Unknown tasks return 404. Missing relationships are not inferred. Cache schema/parser upgrades may reparse unchanged logs to populate relationships; subsequent refreshes return to incremental import without changing source records.

## Account sources and identity

Each refresh detects whether Codex CLI is available. If available, account calls use App Server. A CLI launch or protocol failure is surfaced rather than silently switching providers. If CLI is absent, limits may use an existing supported ChatGPT file login against the fixed `https://chatgpt.com/backend-api/wham/usage` endpoint. Daily account history still requires `account/usage/read` support in the CLI.

The HTTP path reads only supported file credentials from the selected Codex directory. Access tokens stay in server memory; requests time out after 15 seconds and reject redirects. It does not invoke a model, reset limits, refresh/write credentials, or provide a new login UI. API-key logins, missing/damaged credentials, and unsupported credential-storage modes return an unavailable reason.

Windows discovery supports PATH executables, standard npm `codex.cmd`, and the default global npm JS entry. JS runs under the current Node executable; standard `.cmd` shims are resolved to their npm JS entry without shell execution. An invalid explicit `CODEX_BIN` fails without choosing another installation or switching to OAuth.

macOS resolves PATH executables and symbolic links, including npm links to JS. Native files need execute permission; JS runs under the current Node. `CODEX_BIN` remains authoritative. App Server runs in a dedicated macOS process group; close sends SIGTERM, then SIGKILL after a bounded grace period to that spawned group only.

Limits and daily history refresh independently, retaining their own errors and last successful snapshots for the same verified identity. Missing percentages are unknown; missing dates are not zero. Account activity and local activity are never added together.

File-login snapshots are isolated by user identity and workspace, not email. Login changes invalidate results whose ownership cannot be confirmed. After restart, matching snapshots remain historical until the identity is confirmed. Non-file App Server identities use process-local isolation and do not reuse snapshots across restarts. Missing account/workspace identity can prevent confirmation. Older snapshots without sufficient identity evidence remain stored but are not assigned to a current user.

## HTTP API

Responses use `{ data, meta }`. ISO time boundaries must include an offset. `project`, `model`, and `effort` are exact filters. `unknown=project|model|effort` selects missing dimensions; repeat `unknowns` for compound missing conditions. `threadId` can scope local statistics. Default page size is 50, maximum 200.

| Route | Behavior |
| --- | --- |
| `/api/local/summary`, `/api/local/trend`, `/api/local/breakdown` | Shared local filters and aggregated metrics. |
| `/api/local/threads` | Search `q` by title/project/ID; sort and paginate; `cacheBelow=0.2` finds low cache-share tasks. |
| `/api/local/threads/:id`, `/api/local/threads/:id/turns` | Task details and filterable turns, including model/effort composition. |
| `/api/local/turns` | Cross-task turns; supports filters, `q`, sorting by `tokens`, `recent`, or `oldest`, and pagination. |
| `/api/local/threads/:id/agents` | `self`, `subagents`, `team`, and `agents`. Rows include ID, parent ID, depth, title, project, models, and own usage. The path ID selects the root; a `threadId` query does not exclude descendants. |
| `/api/local/compare` | Previous equal-length period by default; paired `baselineFrom`/`baselineTo` choose a custom baseline. `groupBy=thread` locates task changes. |
| `/api/pricing` | Price presets, sources, and verification date. |
| `/api/account/usage`, `/api/account/limits` | Separate account daily buckets and quota windows. |
| `/api/settings`, `/api/status`, `POST /api/refresh` | Configuration, source status, and refresh control. |

`POST /api/refresh` accepts `source: local|account|all|accountLimits|accountHistory`. `account` refreshes both account capabilities. Status provides separate `accountLimits` and `accountHistory` objects with provider, account ID, non-secret identity key, identity confirmation, availability, stale state, error code, and fallback reason. The combined `account` status is retained for compatibility.

Account response metadata carries independent update time, warnings, provider, account ID, identity confirmation, and stale state. Window `usedPercent` and `remainingPercent` may be null. SQL aggregation and sorting happen server-side.

## Cloud quota protocol

`CloudSync` constructs an explicit version 1 whitelist from a verified limits observation. A per-binding HMAC makes the account reference opaque; it is not the Codex account ID. The local SQLite outbox holds only the newest snapshot and retry state. The device bearer and HMAC salt live in the separate private `cloud-credentials.json`, never in local API responses or logs. The local backend schedules collection independently of browser tabs, preserving saved intervals.

Local `/api/cloud/status`, `POST /api/cloud/connect`, `PATCH /api/cloud/settings` and `DELETE /api/cloud/connection` manage this collector. CLI equivalents are `cloud connect|status|pause|resume|disconnect`, with `--json`; connect accepts `--name`, `--no-open` and `--wait`.

The independent `cloud` package runs a native Worker, D1 and Static Assets at `quota.esoren.com`. GitHub OAuth uses state plus S256 PKCE with no repository scopes; it discards the provider token after reading the stable GitHub user ID. Its own session lasts 30 days with Secure, HttpOnly, SameSite=Lax cookies. Public pages contain no credentials. Device credentials can upload and revoke their own device, but cannot read quota pages or other users' data. Browser changes require same-origin requests, private responses are not cacheable, and every data query derives the owner from authentication.

The local client generates its proposed device token and submits its hash with the device name. A 10-minute binding request has a separate hashed polling secret. Browser confirmation atomically replaces any previous main device and removes its old snapshot. D1 stores only device token hashes. `PUT /api/v1/snapshot` atomically claims a per-user 60-second write window and enforces monotonic sequence numbers; identical retries acknowledge the original receipt, while stale versions and too-fast new writes receive 409 and 429/Retry-After. `collectedAt` is never replaced by cloud receipt time. Disconnect and account deletion revoke access and delete the corresponding snapshot.

Cloud frontend/Worker dependency boundaries are checked during build/deploy. Cloud development dependencies have their own lockfile and are excluded from the npm production package. See [cloud operations](../cloud/README.md) for deployment, validation and rollback.

## CLI and Skill

The CLI supports opening, starting, inspecting, and stopping the service; summary, breakdown, task, turn, agent, and comparison queries; refresh; diagnostics; startup management; cache migration; and Skill installation. See the [user guide](USER_GUIDE.md) and `codex-usage --help` for entry points. Query JSON also includes `query`, recording effective boundaries and filters.

The Skill uses the CLI/API rather than reading sessions or SQLite directly. Only explicit Skill installation changes its directory. An unmanaged same-name Skill causes a conflict; managed updates preserve backups. The compatibility script in `skills/codex-usage/scripts/query.mjs` forwards to the CLI.

## Reference costs

Settings `costEnabled` and `modelPrices` control optional USD-per-million-token estimates and model overrides. Presets carry their source and verification date in `/api/pricing`. Costs are calculated at the applicable request tier before aggregation using integer monetary precision; unknown fields/prices retain incomplete markers.

Estimates do not represent subscription charges and exclude tool fees, Fast/Batch/Flex adjustments, and regional surcharges. Refer to the source attached to a preset before interpreting a value as current pricing.

## Sources and attribution

The implementation uses its own counting rules and draws on these organization and algorithm references:

- [CC Switch Codex importer](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/session_usage_codex.rs): snapshot deduplication, explicit deltas, transactions.
- [CC Switch query service](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/usage_stats.rs) and [React queries](https://github.com/farion1231/cc-switch/blob/main/src/lib/query/usage.ts): filtering, aggregation, and query invalidation.
- [New API logs](https://github.com/QuantumNous/new-api/blob/main/model/log.go) and [log table](https://github.com/QuantumNous/new-api/blob/main/web/src/features/usage-logs/components/usage-logs-table.tsx): filtering and pagination.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): account protocol reference.

Licenses and attribution are retained in [third-party notices](../THIRD_PARTY_NOTICES.md). Design and research reports elsewhere in `docs` describe historical investigations, not additional supported features.
