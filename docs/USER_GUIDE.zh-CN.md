# Codex Usage 使用指南

[首页](../README.zh-CN.md) · [English](USER_GUIDE.md) · [技术参考](TECHNICAL_REFERENCE.md)

## 安装与打开

0.1.3 版本支持 Windows x64 和 macOS x64/arm64，需要 Node.js 22.13+（22.x）、24.x 或 26.x。本地统计不要求安装 Codex CLI；账户功能依赖现有且受支持的 Codex 登录。

当前开发源码已加入 Linux x64/arm64 支持；Ubuntu WSL x64 的实际安装、启动／停止和 systemd 用户服务已验证。Linux arm64 与完整平台 CI 仍待验证，新增能力尚未通过 npm 正式发布。源码安装、无桌面使用和自启动方式见 [Linux 兼容性说明](LINUX_COMPATIBILITY.md)。

推荐把 [Agent 安装指南](INSTALL_FOR_AGENTS.md)交给 Agent。安装器会校验发布包，必要时配置用户级 Node 环境。安装需要联网下载发布包和依赖，网页已经预构建。

### 手动安装

Mac 请使用 0.1.3 或更高版本，按[安装和验证状态](MACOS_COMPATIBILITY.md)使用已有的兼容 Node/npm。不含 PowerShell 变量的 CLI 示例也适用于 zsh/bash；私有运行时安装器和旧归档示例仅用于 Windows。

```powershell
npm install -g @esoren/codex-usage
codex-usage
```

已安装旧包 `codex-detailed-usage` 时，先按照[迁移步骤](INSTALL_FOR_AGENTS.md#migrate-a-legacy-package-to-npm)切换。更新 scoped 包时，先停止服务，再安装到相同前缀、重新安装 Skill，并在原来已启用自启动时重新启用自启动。

### 备选：GitHub Release 安装包

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
npm install --global ".\$package"
if ($LASTEXITCODE -ne 0) { throw 'Installation failed' }
codex-usage
```

上述文件名对应旧 GitHub v0.1.1 安装包 `codex-detailed-usage`。新的 scoped 归档文件名为 `esoren-codex-usage-<版本>.tgz`，以实际 Release 附件为准。公开 npm 包名是 `@esoren/codex-usage`，命令名仍为 `codex-usage`。不要替换为 npm 上另一个项目的无 scope 包。

运行 `codex-usage` 会启动或复用后台服务，并打开浏览器。默认地址为 [127.0.0.1:8765](http://127.0.0.1:8765/)。首次导入可能需要几分钟，可在页面查看进度。

## 查看用量

| 页面 | 用途 |
| --- | --- |
| 总览 | 同时查看近期本机活动与可用的账户额度。 |
| 消耗分析 | 查看趋势，按项目、模型、推理强度、任务或轮次组织用量。 |
| 任务明细 | 搜索任务、查看轮次、了解 Agent 团队消耗。 |
| 设置 | 调整刷新、时区、参考成本与 系统登录启动，检查数据源状态。 |

### 从高峰追到轮次

先选择时间范围，再在分析页选择一天查看小时分布。顶部项目、模型和推理强度选择器用于限定范围；分组标签用于改变结果的组织方式。

点击项目或任务，继续查看轮次。全局 Turn 视图可以跨任务比较单轮用量。移除筛选标签即可扩大范围。跨页面保留共同条件；从详情返回时保留原列表排序和分页。

自定义日期按当前时区解释，填好后点击 **应用时间范围**。今天默认按小时，最近七天和三十天默认按日；当前范围内也能手动切换粒度。

### 查看 Agent 团队

任务内的 **Agent 用量**分别显示当前 Agent、所有后代与团队合计。表格每行只计该 Agent 自身用量，缩进展示嵌套子 Agent；点击名称可查看其轮次。

普通 fork 不属于子 Agent，团队只依据明确记录的委派关系。缺失本机历史可能导致团队覆盖不全；已知 Agent 在当前范围内没有记录时仍会显示，并标注暂无用量。

### 对比与构成

展开分析页的 **与上一时段比较**，查看前一个等长时段。按任务分组可定位增量来自哪些工作。自定义基准时间可通过 CLI/API 成对传入 `baselineFrom` 与 `baselineTo`；网页使用前一个等长时段。

默认构成为非缓存输入、缓存读取和输出。缓存读取已包含在输入中，不能再加到输入与输出之和。设置中开启 **显示美元参考消耗 / 成本** 后，显示参考估算和缓存写入列；未知信息不会直接补零，详见[统计口径](TECHNICAL_REFERENCE.md#counting-rules)。

参考成本统一显示 **美元（USD）**，直接按 Token 数量乘美元单价计算。默认订阅模式对已识别的 Fast 消耗乘 **2.5**；官方 API Key 用户可勾选 **使用官方 API 计价（API Key 用户勾选）** 并保存，使用 API 规则，当前已核验预置模型的 Fast 倍率为 **2**。订阅美元参考表只读；API 模式可编辑模型单价，往返切换会保留自定义值。原有的费用显示开关保持不变。本地与云端设置分别保存在各自工作台。

Fast 按每条用量记录及该任务自己的历史识别。金额提示包含 Standard、Fast 和未知档位的分项，摘要在有数据时显示 Fast 与未知档位的 Token 数。无法确认的记录仍计入 Token 总量，但暂不计价；运行中切换模式或历史缺少标记时，会显示“不完整估算”。升级采集器后，会重新处理仍然存在的原始日志以恢复档位证据，已删除的原件无法补回。美元金额是 Token 参考成本，不代表套餐剩余额度、限额百分比或实际订阅付款。

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

后台服务启动时采集一次，之后由服务调度周期刷新，关闭所有网页也会继续。默认仍为本地记录每 60 秒、账户每 300 秒；两者可分别修改，账户可设为 60～86400 秒，0 关闭周期刷新。升级保留已有设置，修改配置立即重新安排下一次检查；休眠恢复后只执行一次到期任务，不补跑休眠期间的全部周期。手动刷新保持原有行为；停止后台服务才会停止采集。

时区可跟随系统，也可手动指定 IANA 名称。本机日期边界、趋势与任务时间随之变化。官方每日记录保持来源日期，单独显示；既有安装保留已保存的时区行为。

## 在手机或其他电脑查看额度

云端入口为 [quota.esoren.com](https://quota.esoren.com)。本分支的本地同步功能尚未发布到 npm；正式发布前，需使用包含 `codex-usage cloud` 命令的开发构建。

1. 在采集电脑打开 **设置 → 云端查看**，可填写设备名称，然后点击 **连接 GitHub 云端**。也可运行 `codex-usage cloud connect --name "我的电脑"`。
2. 在绑定页登录 GitHub，核对绑定码和设备名称，再确认。绑定码有效期 10 分钟；绑定前同步默认关闭，确认后启用。
3. 在手机或其他电脑访问云端站点，用同一个 GitHub 账号登录。每台新设备都会加入你的空间，已有设备与历史继续保留。旧版“仅额度”设备需在新版本地设置中点击 **启用完整历史同步（含原标题与路径）**。

重装后若本机身份文件仍在，沿用原身份接续。身份已丢失时重新发起绑定，在核对页选择 **接续** 原设备，可保留云端历史并轮换上传凭证；原凭证立即失效，暂停设置保留。只有本人尚未删除历史的设备可接续。不同电脑仍应选择加入新设备；已主动删除的历史不能通过接续恢复。

以下说明对应尚未正式发布的 v3 开发构建；实际验证状态见[实施记录](design/multi-device-cloud-panel-implementation-progress-2026-09-11.md)。云端使用与本地相同的总览、消耗分析、任务、轮次与 Agent 界面，先在全部来源中归并同一消耗，再按执行来源筛选设备。顶部 **选择设备** 可限定单台或多台设备，选择会随导航、分页、完整任务和 Agent 下钻保留在地址栏。复制同一会话不会重复累计，跨设备继续产生的新事件会加入合计；相同标题、项目名或 Token 数不会被当成重复依据。无法证明过去执行机器的记录保留来源未知，不猜测归属。

首次绑定分批同步全部已提取历史，之后按新增完整记录增量上传。重写文件时，完整新代次就绪后一起替换旧事件、标题和任务关系。**设置 → 采集设备** 分别显示采集、持久接收和业务应用时间，以及完整来源和待应用批次数；接收成功不等于页面统计已更新。暂停、离线或同步失败会保留已有数据并标注状态，尚未同步完成的数据不能视为完整总量。

浏览器首次准备近期历史，再补齐完整历史；进度条描述当前浏览器缓存，设备覆盖状态描述采集端上传进度。云端 **刷新全部** 读取云端已经应用的结果；本机采集间隔由各设备本地设置控制。云端设置中的用量／额度刷新间隔、时区、费用开关和模型价格保存在当前 GitHub 用户下。用量间隔为 0 时关闭周期更新，手动刷新仍可用。断网时可查看已打开并缓存的页面及同样的筛选结果；未缓存查询会明确提示，完整实体缓存不代表全部筛选均可离线计算。

**设置 → 项目归并** 展示来源路径和关联依据。同一任务、可靠仓库身份和 App 项目元数据可把跨设备来源组织为逻辑项目；冲突证据保持分开。可预览并执行合并、拆分、重命名或恢复自动归并。人工拆分会约束后续自动关联，项目操作保留原始来源信息并更新各页项目筛选；离线时不能修改组织。

**设置 → 旧历史设备归属** 可按 Session 批量选择确实无法确认来源的旧记录，预览后指定设备，记录保留 **用户指定** 标记。选择只包含本次读取时已经存在的记录，之后新增不会自动纳入；已有明确执行来源或来源冲突的记录不能被这个操作改写。可在同一入口撤回用户指定。大批操作完成后一次切换完整结果，全局 Token 总量保持不变。删除指定目标设备的历史会撤回相关人工归属，仍按实际上传者决定删除哪些来源。

云端“跟随系统时区”在每个访问浏览器中分别解析当地时区，并在重新回到窗口和每分钟检查变化；手动时区由所有访问端共用。离线额度缓存按当前用户共享，不随用量设备筛选丢失；用量缓存仍要求相同页面、筛选、时区和读取版本。

账户额度和每日历史独立于设备用量。同一已确认账户跨设备展示一份快照，多个账户分别展示；无法确认的身份保持未知，切换账户后不会把旧账户当成当前账户。保留原始采集时间，云端接收时间单列。重置时间已过时显示 **等待更新确认**，不会自动把剩余额度改成 100%。账户更新按设备至少间隔 60 秒，历史分块使用独立的传输与退避。持久化待传队列可在断网或服务重启后继续。

```powershell
codex-usage cloud connect --name "我的电脑" --no-open --json
codex-usage cloud status --json
codex-usage cloud pause
codex-usage cloud resume
codex-usage cloud disconnect
```

`connect --json` 返回绑定链接且不弹浏览器；加 `--wait` 可等待确认。暂停保留历史；断开停止发送并撤销该设备，历史也继续保留。离线断开会显示“云端撤销待完成”，仅为重试撤销保留凭据；保持服务运行，或在云端设置撤销该设备。**删除云端历史** 是独立操作，会撤销上传权限并移除该设备的用量和账户副本；其他设备的副本及本机记录保留。历史持续保留到主动删除，后台分批回收已删除存储。退出网页登录不会停止采集设备同步。

完整同步上传已解析的事件时间、Token 组成、模型与推理强度、原标题、完整项目路径、任务/轮次/响应标识、Agent 关系和质量状态，以及账户快照和不透明账户引用。Token 使用十进制字符串，缺失值保持 `null`。聊天与工具正文、原始 session 文件、登录凭据、原始账户身份和原始 SQLite 数据库不上传。云端可读取这些统计元数据；这不是端到端加密存储。GitHub 登录只用于识别用户，不申请仓库权限。本地 `cloud-credentials.json` 属于秘密文件，不要附到问题报告中。

[usage.esoren.com](https://usage.esoren.com) 继续跳转到当前电脑，只显示本机统计；它不会自动读取云端的其他设备数据。公开示例继续使用合成数据。部署云端服务不会发布 npm 新版本。

## 后台启动与关闭

```powershell
codex-usage start
codex-usage status --json
codex-usage stop
```

关闭网页或启动终端不会停止后台服务。在设置开启 **登录系统后后台启动**，或运行 `codex-usage autostart enable`，即可登录后后台启动。默认关闭，开启后不弹浏览器。`autostart disable` 仅影响后续登录，`autostart status` 查看状态。

默认服务已运行时，[usage.esoren.com](https://usage.esoren.com) 会跳转到当前电脑的本地地址。域名需要联网，不能安装、启动程序或访问另一台电脑。自定义端口须使用对应本地地址。CLI 与本地地址可离线查看本机统计。

## 升级、迁移与卸载

macOS 默认数据目录为 `~/Library/Application Support/CodexUsage`，由 `CODEX_USAGE_DATA_DIR` 覆盖。登录启动使用用户级 LaunchAgent，下次登录生效，不会持续拉起手动停止的服务。若 macOS 阻止 Node 后台项目，需要在系统设置中允许；注册状态不代表已验证真实登录启动成功。更换 Node 或 npm 前缀后重新安装 Skill，并重新启用原先已启用的自启动，以刷新绝对路径。升级和卸载 CLI 顺序相同，迁移使用带引号的 POSIX 路径；完整命令见 [macOS 生命周期](MACOS_COMPATIBILITY.md#paths-and-lifecycle)。

安装器管理的版本可以重跑[安装流程](INSTALL_FOR_AGENTS.md)：停止服务、校验并更新发布包、保留缓存、更新已启用的启动器。之后执行 `codex-usage skill install` 更新 Skill。

手动安装的版本先运行 `codex-usage stop`，校验新包后安装到原 npm 前缀。重新安装 Skill；此前启用了登录启动时，再执行 `codex-usage autostart enable` 更新绝对路径。

数据默认在 `%LOCALAPPDATA%\CodexUsage`。迁移旧源码目录缓存时，先停止旧服务，再执行 `codex-usage migrate --from C:\absolute\old-checkout\data\usage.sqlite`。它拒绝覆盖已有目标，检查完整性与 SHA-256，并保留原件。

卸载前执行 `codex-usage autostart disable`、`codex-usage stop` 和 `codex-usage skill uninstall`，再从实际 npm 前缀卸载 `@esoren/codex-usage`（旧安装对应 `codex-detailed-usage`）。脚本安装前缀为 `%LOCALAPPDATA%\CodexUsage\tools`；含私有 Node 的[完整卸载步骤](INSTALL_FOR_AGENTS.md#upgrade-migrate-or-uninstall)见安装指南。缓存、日志、启动器文件和 Skill 备份默认保留。

## 常见问题

| 现象 | 下一步 |
| --- | --- |
| 安装后找不到命令 | 新开终端；Windows 从实际前缀调用 `codex-usage.cmd`，macOS 调用 `"$(npm prefix --global)/bin/codex-usage"`。 |
| 网页打不开 | 执行 `codex-usage doctor --json` 和 `codex-usage status --json`，检查端口与服务状态。 |
| 历史为空或不完整 | 检查日期、筛选、导入进度和 Codex 数据目录；本机已归档会话也会导入。 |
| 账户面板不可用 | 在设置分别检查额度和历史错误，本机统计不依赖它们。 |
| 改时区后每日总量变化 | 日期边界改变会把记录分到不同日期，原始 UTC 时间未改变。 |
| 安装 Skill 提示冲突 | 保留已有非本工具管理的 Skill，确认归属后再处理。 |

等待本地导入可执行 `codex-usage refresh --source local --wait --timeout 300 --json`。持续出错时，在 [Issue](https://github.com/Cusnd/codex-usage/issues) 中提供应用、Node 和操作系统版本、架构及脱敏复现信息，不要附带登录文件、实例私有令牌、数据库或真实会话截图。
