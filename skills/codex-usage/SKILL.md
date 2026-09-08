---
name: codex-usage
description: Query the local Codex usage workbench for account limits, project or model token consumption, period comparisons, low-cache tasks, and task or turn details. Use when the user asks to analyze their recorded Codex usage.
---

# Codex usage

Use the installed `codex-usage` CLI with `--json`. Query commands start the local service when necessary without opening a browser. The default service is `http://127.0.0.1:8765`. Run `codex-usage doctor --json` for installation and service diagnostics. See the repository `docs/INSTALL_FOR_AGENTS.md` when the user asks to install the tool.

Start with `codex-usage status --json` to check freshness and import progress. Inspect `accountLimits` and `accountHistory` separately; the legacy `account` entry is only a combined summary. A working quota source does not establish that account daily history is available. For a recent period, use the helper's `--days` flag; it calculates calendar boundaries in the workbench's configured timezone. Explicit `--from` / `--to` are ISO timestamps with offsets and use an inclusive start, exclusive end.

Examples (run from any directory):

```sh
codex-usage summary --days 7 --json
codex-usage breakdown --days 7 --groupBy project --json
codex-usage compare --days 1 --groupBy thread --json
codex-usage threads --days 30 --cacheBelow 0.2 --json
codex-usage thread --id TASK_ID --json
codex-usage turns --id TASK_ID --json
codex-usage limits --json
```

Commands `breakdown`, `threads`, and `turns` support `--limit` (maximum 200) and `--offset`. Follow pagination when the question needs more than the first page. `compare` accepts `--baselineFrom` and `--baselineTo` together. All local queries accept `--project`, `--model`, `--effort`, and `--unknown project|model|effort`. Read `/openapi.json` for the full current contract.

Keep token values as decimal strings / BigInt when calculating. Use the API's comparison and aggregation results rather than reconstructing totals from a page of rows. Cache input is already included in input; reasoning output is a component of output. `cacheRatio` is a fraction, not a percentage.

Report the time range, timezone, source, last successful update, and material warnings with the answer. For account data, preserve `meta.provider`, `accountId`, `identityConfirmed`, and `stale`: identify unconfirmed or stale values as historical snapshots. Null quota percentages are unknown, not zero. `identityKey` is an opaque isolation key, not a credential or display name. Account statistics and local recorded activity have different coverage: compare them descriptively, never add them together or call their difference lost usage. Missing metrics and dates remain unknown. A consumption increase establishes attribution to a group, not the cause of the user's behavior.

Query commands read statistics; they may start the service, whose initial import updates this tool's cache. They never change Codex source records. If data needs refreshing, call `POST /api/refresh` within the user's requested scope; `source` supports `local`, `accountLimits`, `accountHistory`, `account` (both account capabilities), and `all`. Installed CLI uses App Server; only missing CLI selects existing OAuth HTTP quota access. Interface errors do not switch authentication routes. Account daily history still needs CLI. If the service is stopped, a query starts it without opening the Web. To wait for fresh local data use `codex-usage refresh --source local --wait --timeout 300 --json`; do not treat an in-progress import as complete. `codex-usage agents --id TASK_ID --json` reports self, descendants and team. `turns` without `--id` queries global turns. `codex-usage` with no arguments opens the Web only when the user wants to view it. This skill neither starts Codex inference nor reads session files or SQLite directly.
