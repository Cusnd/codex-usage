# Using Codex Usage

[Home](../README.md) · [简体中文](USER_GUIDE.zh-CN.md) · [Technical reference](TECHNICAL_REFERENCE.md)

## Install and open

Codex Usage 0.1.3 supports Windows x64 and macOS x64/arm64, and requires Node.js 22.13+ (22.x), 24.x, or 26.x. Local statistics work without the Codex CLI; account features depend on an existing supported Codex login.

The unreleased development tree also supports Linux x64/arm64. Use a built candidate archive when validating this tree; the public npm command does not establish that these changes have been released. See [Linux paths, systemd and validation](LINUX_COMPATIBILITY.md). The optional cloud dashboard keeps the local dashboard available, receives parsed usage and account snapshots, and supports device filtering and project organization. See [cloud implementation status](design/multi-device-cloud-panel-implementation-progress-2026-09-11.md) for completed and outstanding acceptance checks.

The easiest route is to give an agent the [installation guide](INSTALL_FOR_AGENTS.md). Its installer verifies the release and can provide a user-level Node runtime. Installation requires internet access to download the package and its dependencies; the web app is already built.

### Manual installation

On a Mac, use version 0.1.3 or later and follow [installation and validation status](MACOS_COMPATIBILITY.md), using existing supported Node/npm. CLI examples without PowerShell variables also work in zsh/bash. The private-runtime installer and legacy archive example are Windows-only.

```powershell
npm install -g @esoren/codex-usage
codex-usage
```

For an existing `codex-detailed-usage` installation, follow the [migration steps](INSTALL_FOR_AGENTS.md#migrate-a-legacy-package-to-npm) first. For updates to the scoped package, stop the service, install the desired version into the same prefix, reinstall the Skill, and re-enable autostart if it was enabled.

### Alternative: GitHub Release archive

With compatible Node and npm installed, download the `.tgz` package and `SHA256SUMS` from the **same** [release](https://github.com/Cusnd/codex-usage/releases/latest). In their download directory, run the following, adjusting the filename for your release:

```powershell
$package = 'codex-detailed-usage-0.1.1.tgz'
$checksumLines = @(Get-Content -LiteralPath '.\SHA256SUMS' | Where-Object {
  $_ -match ('^[0-9a-fA-F]{64}\s+\*?' + [regex]::Escape($package) + '$')
})
if ($checksumLines.Count -ne 1) { throw 'Expected exactly one package checksum' }
$expected = ($checksumLines[0] -split '\s+')[0]
if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne $expected) {
  throw 'Package checksum mismatch'
}
npm install --global ".\$package"
if ($LASTEXITCODE -ne 0) { throw 'Installation failed' }
codex-usage
```

The example above is the legacy GitHub v0.1.1 archive (`codex-detailed-usage`). New scoped archives use `esoren-codex-usage-<version>.tgz`; use the filename actually listed in the release. The public npm package is `@esoren/codex-usage`, and the CLI command remains `codex-usage`. Do not substitute the unrelated unscoped npm package.

Running `codex-usage` starts or reuses the background service and opens the browser. The default address is [127.0.0.1:8765](http://127.0.0.1:8765/). The first history import may take several minutes; follow the progress shown in the app.

## Explore your usage

The current interface is in Chinese. These are the main areas:

| Page | What to use it for |
| --- | --- |
| 总览 — Overview | See recent activity and available account limits side by side. |
| 消耗分析 — Analysis | Explore trends and group usage by project, model, reasoning effort, task, or turn. |
| 任务明细 — Tasks | Search for a task, inspect its turns, and explore its agent team. |
| 设置 — Settings | Configure refresh, timezone, costs, and system login startup; inspect data-source status. |

### Follow a usage spike

Choose a time range, then select a day in Analysis to inspect hourly activity. Use the project, model, and reasoning-effort selectors to narrow the scope. The grouping tabs change how the results are organized; the selectors filter which records participate.

Open a project or task to continue into its turns. The global Turn view lets you compare individual turns across tasks. Remove a filter chip to broaden the view. Shared filters persist between pages; returning from a detail view preserves the originating list's sorting and pagination.

Custom dates are interpreted in the selected timezone. Click **应用时间范围** to apply the range. Today defaults to hours; seven- and thirty-day ranges default to days. You can change the granularity within the current range.

### Read an agent team

Inside a task, **Agent 用量** separates the current agent, all descendants, and the team total. Each table row reports that agent's own usage. The indented rows include nested subagents; select an agent name to inspect its turns.

A normal fork is not a subagent. Only explicit recorded delegation links establish a team. Missing local history can leave the team incomplete, and a known agent with no matching records remains visible as having no usage records.

### Compare and inspect composition

Expand **与上一时段比较** in Analysis to compare with the preceding equal-length period. Group by task to locate the work behind an increase. A custom baseline is available through the CLI/API using paired `baselineFrom` and `baselineTo` values; the web comparison uses the preceding period.

The default composition is uncached input, cache reads, and output. Cache reads are part of input, not an extra amount to add to input and output. In Settings, enable **显示美元参考消耗 / 成本** to include reference estimates and cache-write columns. Missing information is not silently treated as zero; see [counting rules](TECHNICAL_REFERENCE.md#counting-rules).

Reference estimates always display **USD**, calculated directly from Token quantities and dollar unit prices. The default subscription mode applies a **2.5×** multiplier to identified Fast usage. API Key users can check **使用官方 API 计价（API Key 用户勾选）** and save to use the API rules, whose verified presets apply **2×** for Fast. The subscription reference table is read-only; the API editor retains custom prices when switching modes. Your existing estimate visibility setting is preserved. Local and cloud settings are saved in their respective workspaces.

Fast is identified per usage record, using each task's own available history. The estimate shows Standard/Fast/unknown subtotals, and the summary shows Fast and unknown Token counts when present. Uncertain records still contribute to Token totals but remain unpriced. Mode switches within a running turn or missing historical markers can leave the estimate incomplete. After upgrading the collector, available original logs are reprocessed to recover mode evidence; deleted originals cannot be recovered. The dollar amount is a Token reference cost, not remaining plan quota or your actual subscription payment.

## Ask an agent or use the CLI

Install the included Skill and open a fresh agent task if necessary:

```powershell
codex-usage skill install
```

Ask questions such as “Which tasks used the most tokens this week?” or “How much did this task's subagents use?” The agent can resolve a task ID from the task list when it is not already known.

For direct queries:

```powershell
codex-usage summary --days 7 --json
codex-usage breakdown --days 7 --group-by model --json
codex-usage agents --id TASK_ID --json
codex-usage compare --days 1 --groupBy thread --json
codex-usage threads --days 30 --cacheBelow 0.2 --json
```

Replace `TASK_ID` with an actual task ID. Queries start the local service when needed; `status` only inspects it. Keep the returned time boundaries and missing-data notes when comparing answers.

## Account data, refresh, and timezone

Account limits and local token activity are separate. Account limits can work through a compatible Codex CLI or supported existing file login; daily account history requires a CLI that supports that capability. Either account feature can be unavailable while local statistics still work. Inspect each source's status and timestamp in Settings; old snapshots are marked as such.

The service updates once on startup and owns periodic refresh even with every browser tab closed. Defaults remain 60 seconds for local records and 300 seconds for account data. Change them separately in Settings; account intervals accept 60–86400 seconds, and 0 disables periodic refresh. Existing settings are preserved, changes immediately reschedule the next check, and waking the computer runs due work once without replaying missed intervals. Manual refresh keeps its existing behavior. Stopping the service stops collection.

Set the timezone to follow the system or specify an IANA timezone manually. Local day boundaries, trends, and task times follow that choice. Official account daily buckets retain their source dates and appear separately. Existing installations retain their saved timezone behavior.

## View quotas from another device

Cloud viewing is available at [quota.esoren.com](https://quota.esoren.com). The local sync feature in this branch has not yet been published to npm; use a build containing `codex-usage cloud` until its release.

1. On the collecting computer, open **Settings → 云端查看**, optionally name the device, and select **连接 GitHub 云端**. Or run `codex-usage cloud connect --name "My laptop"`.
2. Sign in to GitHub on the binding page, compare its code and device name with the local app, and confirm. A code expires after 10 minutes. Binding enables sync; it is off beforehand.
3. Open the cloud site on your phone or another computer and sign in with the same GitHub account. New devices join your space while existing devices and history remain. Upgrade an older quota-only collector using **启用完整历史同步（含原标题与路径）** in the updated local settings.

Reinstallation resumes automatically when the local identity files remain. If that identity was lost, begin binding again and select **接续** for the original device on the confirmation page. This retains its cloud history and pause preference while rotating the upload credential; the former credential immediately stops working. Only your own devices with retained history are eligible. A different computer should join as a new device. Resumption cannot recover history that was explicitly deleted.

The following behavior describes the unreleased v3 development build; see the [implementation record](design/multi-device-cloud-panel-implementation-progress-2026-09-11.md) for its validation status. The cloud uses the same overview, analysis, tasks, turns and Agent UI as the local app. It first reconciles usage across all sources, then applies the selected execution-device filter. **选择设备** filters one or several devices; the selection stays in the URL during navigation, pagination and task/Agent drill-down. A copied session is counted once, while new events from work continued on another computer are added. Titles, project names and equal token counts are not deduplication keys. Historical execution origin remains unknown when the evidence cannot identify it.

Initial sync transfers the extracted history in batches; later uploads contain newly completed records. Rewritten sources publish their replacement events, titles and relationships together after the new generation is complete. Settings → **采集设备** distinguishes collection, durable receipt and application times, complete sources and pending batches. A receipt does not yet mean the statistics have changed. Paused, offline and failed collectors retain their previous data with a status label.

The browser prepares recent history first and then completes the full baseline. Its progress describes the browser cache; device coverage describes collection and upload progress. Cloud refresh reads applied cloud results. Each computer controls its own collection interval, while cloud usage/account refresh intervals, timezone and prices are saved for the GitHub user. A zero usage interval disables periodic updates while retaining manual refresh. Offline viewing supports pages and exact filters already opened and cached; an uncached query reports that limitation. A complete entity cache does not imply every possible query can run offline.

Settings → **项目归并** shows source paths and association evidence. Shared sessions, reliable repository identity and App project metadata can organize sources across devices into logical projects; conflicting evidence stays separate. Preview and apply merges, splits, renames or a reset to automatic organization. A manual split constrains later automatic associations. Operations retain source evidence and update project filters throughout the UI. Organization cannot be edited offline.

Settings → **旧历史设备归属** lets you select historical sessions and assign records whose execution origin cannot be established. The records retain a **用户指定** (user assigned) label. Selection is fixed to records already present in that read version; later additions are excluded. Reliable execution origins and conflicting origin evidence cannot be overwritten with this action. The same screen can revoke assignments. Large operations publish a complete replacement together, without changing the global token total. Deleting the assigned target's history revokes its manual assignments; actual uploaded facts are still deleted according to their uploader.

Cloud system-timezone mode resolves the timezone separately in each browser and checks it on window focus and once per minute. Manual mode uses the shared saved timezone. Offline account observations are shared for the current user across usage-device filters; cached usage queries still require their exact page, filters, timezone and read version.

Account quotas and daily history are separate from device usage. A confirmed account shared by multiple devices has one quota view; different accounts remain separate. Unknown identity stays unknown, and switching accounts stops presenting the old account as current. Original collection time is preserved. A passed reset time displays **等待更新确认**, never an assumed 100% remaining quota. Account writes are spaced by at least 60 seconds per device, independently of usage batches. The durable outbox resumes after restarts and network failures.

```powershell
codex-usage cloud connect --name "My laptop" --no-open --json
codex-usage cloud status --json
codex-usage cloud pause
codex-usage cloud resume
codex-usage cloud disconnect
```

`connect --json` returns the verification URL without opening a browser; add `--wait` to wait for confirmation. Pause and disconnect preserve history; disconnect revokes upload access. Offline disconnect retains a pending revocation and its credential only to finish that operation. **删除云端历史** separately revokes access and deletes that device's cloud records, leaving local data and other devices' copies intact. History remains until explicitly deleted; detached storage is reclaimed in background batches. Logging out of the website does not stop device sync.

Full sync includes parsed event timestamps and token components, models, reasoning effort, original titles, full project paths, task/turn/response identifiers, Agent relationships, quality flags, and account snapshots with opaque account references. Tokens stay decimal strings and missing values stay `null`. Chats, tool bodies, raw session files, login credentials, raw account identities and the original SQLite database stay local. The cloud can read the statistics metadata; this is not end-to-end encrypted storage. GitHub login requests no repository scopes. Keep `cloud-credentials.json` out of bug reports.

The public example remains synthetic. [usage.esoren.com](https://usage.esoren.com) still redirects to the current computer and shows only its local data; it does not fetch other devices from the cloud. A cloud deployment does not release a new npm package.

## Start and stop

```powershell
codex-usage start
codex-usage status --json
codex-usage stop
```

Closing the browser or launch terminal does not stop the background service. Enable **登录系统后后台启动** in Settings, or use `codex-usage autostart enable`, to start it at system login. This is off by default and does not open a browser. `autostart disable` affects future logins, not the running process; `autostart status` reports its state.

With the default service running, [usage.esoren.com](https://usage.esoren.com) redirects to this computer's local address. It needs internet, cannot install or start the app, and does not access another computer. A custom port needs its own local URL. Local statistics remain accessible offline through the CLI and local address.

## Upgrade, migrate, or uninstall

macOS data defaults to `~/Library/Application Support/CodexUsage`, overridden by `CODEX_USAGE_DATA_DIR`. A user LaunchAgent registers startup for the next login and does not continuously restart a manually stopped service. If macOS blocks the Node background item, allow it in System Settings. Registration alone is not proof of successful login startup. After changing Node or the npm prefix, reinstall the Skill and re-enable previously enabled autostart to refresh absolute paths. The same CLI upgrade/uninstall sequence applies; migration uses a quoted POSIX path. Full commands: [macOS lifecycle](MACOS_COMPATIBILITY.md#paths-and-lifecycle).

For an installation managed by the installer, rerun the [installation procedure](INSTALL_FOR_AGENTS.md): it stops the service, verifies the new release, preserves the cache, and updates an enabled startup launcher. Run `codex-usage skill install` afterward to update the Skill.

For a manual installation, run `codex-usage stop`, verify the new package, and install it into the original npm prefix. Reinstall the Skill; if login startup was enabled, rerun `codex-usage autostart enable` to update its absolute paths.

Data defaults to `%LOCALAPPDATA%\CodexUsage`. To copy a cache from an old source checkout, stop that checkout's service and run `codex-usage migrate --from C:\absolute\old-checkout\data\usage.sqlite`. The command refuses to overwrite a destination, checks integrity and SHA-256, and preserves the original.

Before uninstalling, run `codex-usage autostart disable`, `codex-usage stop`, and `codex-usage skill uninstall`. Uninstall `@esoren/codex-usage` (or `codex-detailed-usage` for a legacy installation) from its actual npm prefix. Script installations use `%LOCALAPPDATA%\CodexUsage\tools`; the [complete procedure](INSTALL_FOR_AGENTS.md#upgrade-migrate-or-uninstall) covers its private Node runtime. Cache, logs, launcher files, and Skill backups are retained by default.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Command is not found after installation | Open a new terminal. Windows: use `codex-usage.cmd` from the actual prefix. macOS: use `"$(npm prefix --global)/bin/codex-usage"`. |
| Dashboard does not open | Run `codex-usage doctor --json` and `codex-usage status --json`; inspect the reported port and service state. |
| History looks empty or incomplete | Check the selected dates, filters, import progress, and Codex data directory. Archived local sessions are included. |
| Account panel is unavailable | Inspect the separate limits/history errors in Settings. Local statistics do not depend on them. |
| Daily totals changed after switching timezone | Different day boundaries move records between dates; raw UTC timestamps are unchanged. |
| Skill installation reports a conflict | Preserve the existing unmanaged Skill; resolve its ownership before retrying. |

To wait for a local import, run `codex-usage refresh --source local --wait --timeout 300 --json`. For persistent errors, include the app, Node, and OS versions and architecture with sanitized reproduction details in an [issue](https://github.com/Cusnd/codex-usage/issues). Do not attach login files, private instance tokens, databases, or real-session screenshots.
