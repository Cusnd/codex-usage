# Codex Usage 使用指南

[首页](../README.zh-CN.md) · [English](USER_GUIDE.md) · [技术参考](TECHNICAL_REFERENCE.md)

## 安装与打开

当前支持 Windows x64，需要 Node.js 26.7.0 或更新版本。本地统计不要求安装 Codex CLI；账户功能依赖现有且受支持的 Codex 登录。

推荐把 [Agent 安装指南](INSTALL_FOR_AGENTS.md)交给 Agent。安装器会校验发布包，必要时配置用户级 Node 环境。安装需要联网下载发布包和依赖，网页已经预构建。

### 手动安装

已有兼容 Node 和 npm 时，从[同一个 Release](https://github.com/Cusnd/codex-usage/releases/latest) 下载 `.tgz` 和 `SHA256SUMS`。在下载目录执行以下命令，按实际版本调整文件名：

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
npm install --global --ignore-scripts ".\$package"
if ($LASTEXITCODE -ne 0) { throw 'Installation failed' }
codex-usage
```

命令名是 `codex-usage`，安装包名是 `codex-detailed-usage`。不要替换为 npm 上另一个项目的同名 `codex-usage` 包。

运行 `codex-usage` 会启动或复用后台服务，并打开浏览器。默认地址为 [127.0.0.1:8765](http://127.0.0.1:8765/)。首次导入可能需要几分钟，可在页面查看进度。

## 查看用量

| 页面 | 用途 |
| --- | --- |
| 总览 | 同时查看近期本机活动与可用的账户额度。 |
| 消耗分析 | 查看趋势，按项目、模型、推理强度、任务或轮次组织用量。 |
| 任务明细 | 搜索任务、查看轮次、了解 Agent 团队消耗。 |
| 设置 | 调整刷新、时区、参考成本与 Windows 登录启动，检查数据源状态。 |

### 从高峰追到轮次

先选择时间范围，再在分析页选择一天查看小时分布。顶部项目、模型和推理强度选择器用于限定范围；分组标签用于改变结果的组织方式。

点击项目或任务，继续查看轮次。全局 Turn 视图可以跨任务比较单轮用量。移除筛选标签即可扩大范围。跨页面保留共同条件；从详情返回时保留原列表排序和分页。

自定义日期按当前时区解释，填好后点击 **应用时间范围**。今天默认按小时，最近七天和三十天默认按日；当前范围内也能手动切换粒度。

### 查看 Agent 团队

任务内的 **Agent 用量**分别显示当前 Agent、所有后代与团队合计。表格每行只计该 Agent 自身用量，缩进展示嵌套子 Agent；点击名称可查看其轮次。

普通 fork 不属于子 Agent，团队只依据明确记录的委派关系。缺失本机历史可能导致团队覆盖不全；已知 Agent 在当前范围内没有记录时仍会显示，并标注暂无用量。

### 对比与构成

展开分析页的 **与上一时段比较**，查看前一个等长时段。按任务分组可定位增量来自哪些工作。自定义基准时间可通过 CLI/API 成对传入 `baselineFrom` 与 `baselineTo`；网页使用前一个等长时段。

默认构成为非缓存输入、缓存读取和输出。缓存读取已包含在输入中，不能再加到输入与输出之和。设置中可开启 API 参考成本和缓存写入列；未知信息不会直接补零，详见[统计口径](TECHNICAL_REFERENCE.md#counting-rules)。

## 让 Agent 查询，或直接使用 CLI

安装配套 Skill，必要时新开一个 Agent 任务：

```powershell
codex-usage skill install
```

可以问“本周哪些任务最耗 Token？”或“这个任务的子 Agent 用了多少？”。不知道任务 ID 时，Agent 可以先查询任务列表。

直接使用命令：

```powershell
codex-usage summary --days 7 --json
codex-usage breakdown --days 7 --group-by model --json
codex-usage agents --id TASK_ID --json
codex-usage compare --days 1 --groupBy thread --json
codex-usage threads --days 30 --cacheBelow 0.2 --json
```

将 `TASK_ID` 替换为实际任务 ID。查询在需要时启动服务，`status` 只检查状态。比较回答时保留结果中的时间边界和缺失说明。

## 账户、刷新与时区

账户额度与本机 Token 活动独立。额度可通过兼容的 Codex CLI 或受支持的现有文件登录读取；账户每日历史需要支持该能力的 CLI。账户能力不可用时，本地统计仍可使用。设置中分别显示来源状态与更新时间，旧快照会明确标注。

启动时更新一次。页面打开期间，本地记录默认每 60 秒检查，账户默认每 300 秒刷新；两者可分别修改，0 表示关闭自动刷新。关闭页面会停止周期请求，已经开始的导入可以继续完成。

时区可跟随系统，也可手动指定 IANA 名称。本机日期边界、趋势与任务时间随之变化。官方每日记录保持来源日期，单独显示；既有安装保留已保存的时区行为。

## 后台启动与关闭

```powershell
codex-usage start
codex-usage status --json
codex-usage stop
```

关闭网页或启动终端不会停止后台服务。在设置开启 **登录 Windows 后后台启动**，或运行 `codex-usage autostart enable`，即可登录后后台启动。默认关闭，开启后不弹浏览器。`autostart disable` 仅影响后续登录，`autostart status` 查看状态。

默认服务已运行时，[usage.esoren.com](https://usage.esoren.com) 会跳转到当前电脑的本地地址。域名需要联网，不能安装、启动程序或访问另一台电脑。自定义端口须使用对应本地地址。CLI 与本地地址可离线查看本机统计。

## 升级、迁移与卸载

安装器管理的版本可以重跑[安装流程](INSTALL_FOR_AGENTS.md)：停止服务、校验并更新发布包、保留缓存、更新已启用的启动器。之后执行 `codex-usage skill install` 更新 Skill。

手动安装的版本先运行 `codex-usage stop`，校验新包后安装到原 npm 前缀。重新安装 Skill；此前启用了登录启动时，再执行 `codex-usage autostart enable` 更新绝对路径。

数据默认在 `%LOCALAPPDATA%\CodexUsage`。迁移旧源码目录缓存时，先停止旧服务，再执行 `codex-usage migrate --from C:\absolute\old-checkout\data\usage.sqlite`。它拒绝覆盖已有目标，检查完整性与 SHA-256，并保留原件。

卸载前执行 `codex-usage autostart disable`、`codex-usage stop` 和 `codex-usage skill uninstall`，再从实际 npm 前缀卸载 `codex-detailed-usage`。脚本安装前缀为 `%LOCALAPPDATA%\CodexUsage\tools`；含私有 Node 的[完整卸载步骤](INSTALL_FOR_AGENTS.md#upgrade-migrate-or-uninstall)见安装指南。缓存、日志、启动器文件和 Skill 备份默认保留。

## 常见问题

| 现象 | 下一步 |
| --- | --- |
| 安装后找不到命令 | 新开终端，或从实际安装前缀调用 `codex-usage.cmd`。 |
| 网页打不开 | 执行 `codex-usage doctor --json` 和 `codex-usage status --json`，检查端口与服务状态。 |
| 历史为空或不完整 | 检查日期、筛选、导入进度和 Codex 数据目录；本机已归档会话也会导入。 |
| 账户面板不可用 | 在设置分别检查额度和历史错误，本机统计不依赖它们。 |
| 改时区后每日总量变化 | 日期边界改变会把记录分到不同日期，原始 UTC 时间未改变。 |
| 安装 Skill 提示冲突 | 保留已有非本工具管理的 Skill，确认归属后再处理。 |

等待本地导入可执行 `codex-usage refresh --source local --wait --timeout 300 --json`。持续出错时，在 [Issue](https://github.com/Cusnd/codex-usage/issues) 中提供应用、Node 和 Windows 版本及脱敏复现信息，不要附带登录文件、实例私有令牌、数据库或真实会话截图。
