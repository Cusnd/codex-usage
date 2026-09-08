# Codex 用量图录

本机 Windows 个人工具：账户额度和每日用量、本地项目／模型／推理强度分析、任务与全局轮次明细、时段对比、可选 API 参考成本，以及 HTTP 查询 Skill。

## 启动

需要 Node.js **26.7.0 或以上**。本地统计不要求安装 Codex CLI；账户功能需要相应的现有 ChatGPT 登录。使用 Node 内置 SQLite，不需要 Python 或独立数据库。

```powershell
npm ci
npm run build
npm start
```

打开 [工作台](http://127.0.0.1:8765)、[API 文档](http://127.0.0.1:8765/docs)或 [OpenAPI](http://127.0.0.1:8765/openapi.json)。关闭启动终端中的程序即可停止服务，不安装常驻服务或开机任务。

开发使用 `npm run dev`，打开 `http://127.0.0.1:5173`。`npm run check` 检查类型，`npm test` 执行统计、账户适配和接口测试；构建后 `npm run smoke` 在隔离空目录检查生产页面与 API，不使用个人登录信息。Windows CI 在中文空格目录执行同样的检查。

## 页面操作

界面使用 Lucide SVG 图标和本地打包的 Inter 字体，样式规则及视觉稿见 [设计说明](docs/design/README.md)。

- 分析页的“按项目／按模型／按推理强度”按钮切换分组；顶部同名选择器用于限定范围，两者分工不同。
- 选择器在页面内展开，支持实际鼠标点选、方向键和 Enter、Escape 关闭；项目、模型及时区可搜索。项目选项附完整路径，区分同名目录。
- 点击分组名称会显示筛选标签；可移除单个条件或清除全部。使用“查看当前筛选下的任务”进入对应任务，再下钻到轮次。
- 总览、分析、任务列表和设置之间保留共同的时间／维度条件；详情返回保留原列表的排序与分页。
- 自定义时间按所选时区解释，填写后点击“应用时间范围”。对比结果支持独立分页。

## 数据与刷新

- 默认读取 `CODEX_HOME`，未设置时读取用户目录下 `.codex/sessions` 与 `.codex/archived_sessions`。原记录只读。
- 首次导入逐文件进行，大型历史可能需要几分钟；页面显示进度。后续跳过未变化的文件，增长的文件从上次完整行继续读取。
- `data/usage.sqlite` 保存统计元数据、任务标题和账户快照，已加入 Git 忽略；不保存聊天正文、工具输出或登录凭据。数据库包含项目路径和账户标识，发布源码时不要携带 `data`。
- 启动时更新一次；页面打开期间默认每 60 秒检查本地记录、每 300 秒读取账户。设置中可以分别修改，0 表示关闭自动刷新。
- 页面关闭后停止发起周期刷新；正在执行的导入可以完成。手动刷新可选本地、账户或全部。
- **时区可随时调整**：设置页支持“跟随系统时区”和“手动指定时区”，顶栏时区链接可快速打开设置。跟随模式每分钟及窗口重新获得焦点时更新系统时区；手动模式提供常用时区候选，也接受有效 IANA 名称。切换后重算本地日期筛选和趋势分桶，调整任务时间显示，不改写原始 UTC 时间。账户每日桶保留服务端日期。既有安装默认保持手动时区。
- **账户数据源按 CLI 是否存在选择**：检测到 Codex CLI 时使用 App Server；未检测到时，额度通过现有 ChatGPT OAuth 登录访问固定的 `https://chatgpt.com/backend-api/wham/usage`。CLI 已存在但启动或接口失败时报告错误，不切换 OAuth。每次刷新重新检测，安装 CLI 后下次刷新即使用 CLI。
- OAuth / HTTP 只读取当前 Codex 目录中的文件登录，访问令牌仅存在于服务端内存；不发起模型请求、不重置额度、不刷新或写回令牌。HTTP 超时 15 秒且拒绝重定向。API Key 登录、缺失或损坏的登录文件，以及 `keyring`、`auto` 等非明确文件存储模式不会尝试 HTTP，页面说明不可用原因。此版本不提供独立 OAuth 登录界面。
- 账户每日 Token 历史仍需要支持 `account/usage/read` 的 CLI。额度与每日历史独立刷新、保存、展示错误；任一账户能力失败都不影响本地统计。两者共用现有账户刷新间隔。
- Windows 支持 PATH 中的 Codex `.exe`、标准 npm `codex.cmd` 和默认 npm 全局 JS 入口；`CODEX_BIN` 可明确指定 `.exe`、`.js/.mjs/.cjs` 或标准 npm `.cmd`。JS 使用当前 Node 启动，`.cmd` 解析为 npm JS 入口，不执行 shell。显式入口无效时直接报错，不自动选择其他安装或 OAuth。
- `PORT` 可修改监听端口；默认只监听 `127.0.0.1:8765`。Vite 开发代理使用默认端口。

## 统计口径

账户统计与本机记录分开，不能相加；缺失账户日期不代表零。额度与每日历史分别保留同一身份的最后成功快照，并标注来源、更新时间和过期状态；缺失百分比显示未知。文件登录按用户身份与工作区组合隔离，登录发生变化时丢弃无法确认归属的结果，不按邮箱合并账户。

重启后，匹配当前文件登录的旧快照先标为历史，成功读取后才确认身份。仅由 App Server 管理的非文件登录使用进程内隔离标识，不跨重启复用旧快照；缺少后端账户标识时无法确认归属。此类登录的每日历史可能需要额度接口提供工作区标识，无法取得时保守报告身份不可确认。历史快照不会自动当成当前账户数据。

数据库升级仅为账户快照增加身份与来源列，不删除既有记录。旧版本没有用户身份依据的快照保留在数据库中，但不自动关联到当前用户；重新刷新即可生成可确认归属的新快照。

主视图的“今天／最近 7 天”、趋势和时段对比都按所选时区重新计算日界线，切换时区可能改变每天和所选期间的总量。官方账户接口只有每日总数，没有足够明细进行时区重分桶，因此原始日期记录放在独立折叠参考区，不参与主视图的新时区统计。

新记录优先采用 `token_usage_record.usage`，以响应 ID 去重。同任务／轮次存在明确记录时排除旧 `token_count` 镜像。旧格式先排除重复快照，再采用 `last_token_usage`，最后才使用累计高水位差值。未知继承历史保守排除并记录异常；这种数据不应被当成完整账本。

`active` 是导入时确定的明细参与标记，不是汇总缓存。重复文件各自保留来源贡献，查询只统计选中的一份；文件重新解析后在事务内重新确定参与记录。删除过的源文件已导入数据会保留；如需彻底从现存文件重建，可停止服务后移走本工具的 `data` 目录再启动。

输入已含缓存，输出中的推理不再重复加总。缓存比例使用有效记录的缓存之和除以对应输入之和，非各条比例平均。未知模型／项目／轮次保留并标注。项目按规范化工作目录分组，不合并 worktree。

所有 token API 字段是十进制字符串，大整数从 JSON 解析到 SQLite 读取保持精度；图表转换成百万单位绘图，明细保留精确值。默认显示时区为 `America/New_York`，可以在设置中修改；账户日期保持服务端日期。

第一版不提供订阅费用换算、多机／云端完整覆盖、工具性能分析或多用户功能。历史文件格式不是稳定协议，解析异常会出现在设置页。

## API

统一 `{ data, meta }`。本地范围 `from` 包含、`to` 不包含，ISO 时间必须携带偏移。`project/model/effort` 精确匹配；`unknown=project|model|effort` 选择缺失值；复合缺失条件可重复传递 `unknowns`。`threadId` 可限定单任务的范围内统计。分页默认 50、最大 200。

核心入口：

- `/api/local/summary`、`trend`、`breakdown`：共用筛选与 SQL 指标。
- `/api/local/threads`：标题／项目／ID 搜索 `q`、排序与分页，可加 `cacheBelow=0.2` 查询低缓存占比任务。
- `/api/local/threads/:id`、`/:id/turns`：完整任务与可筛选轮次；轮次提供模型／推理强度构成。
- `/api/local/turns`：跨 Session 轮次，支持共用筛选、`q` 搜索、`sort=tokens|recent|oldest` 与分页。
- `/api/local/threads/:id/agents`：当前 agent、后代 subagent 与团队用量，支持时间、项目、模型、推理强度及未知维度筛选。返回 `self`、`subagents`、`team` 指标及 `agents` 列表；列表包含当前 agent（depth=0），每项提供 `id`、`parentId`、`depth`、`title`、`project`、`models` 和自身 `usage`。路径 ID 决定根节点，查询参数 `threadId` 不限制其后代。
- `/api/pricing`：官方价格预置、来源、核对日期；设置中的 `costEnabled` 和 `modelPrices` 控制显示与覆盖。
- `/api/local/compare`：前一个等长时段对比；也支持成对 `baselineFrom/baselineTo`。按 `groupBy=thread` 定位任务增量。
- `/api/account/usage`、`limits`：账户每日桶与多额度窗口。
- `/api/settings`、`/api/status`、`POST /api/refresh`：设置、状态与采集。状态新增 `accountLimits` 与 `accountHistory`，包含 `provider`、`accountId`、不含凭据的 `identityKey`、`identityConfirmed`、`available`、`stale`、`errorCode` 和 `fallbackReason`；`account` 保留为兼容汇总，不能代替两个独立状态。
- `POST /api/refresh` 保留 `source: local|account|all`，新增 `accountLimits|accountHistory`；`account` 刷新两类账户数据。额度与历史响应的 `meta.updatedAt/warnings` 各自独立，并提供 `provider/accountId/identityConfirmed/stale`。窗口中的 `usedPercent/remainingPercent` 允许 null。

完整参数和响应以自动生成的 OpenAPI 为准。SQL 聚合与排序在服务端，前端只负责查询状态、交互与显示。

## Skill

仓库的 `skills/codex-usage` 是可独立安装的 Skill，包含无额外依赖的 Node 查询脚本。复制整个目录至个人 skills 目录后可使用。当前项目不会自动改动全局 Skill 安装。

```powershell
node skills/codex-usage/scripts/query.mjs summary --days 7
node skills/codex-usage/scripts/query.mjs compare --days 1 --groupBy thread
node skills/codex-usage/scripts/query.mjs threads --days 30 --cacheBelow 0.2
```

`CODEX_USAGE_URL` 覆盖默认服务地址。Skill 仅调用 API，不读取会话或数据库；回答必须保留范围、来源、更新时间和缺失说明。

## 参考实现

本工具按自身数据口径独立实现，参考了以下源码中的组织方式和算法思路：

- [CC Switch Codex 导入](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/session_usage_codex.rs)：快照去重、明确增量优先、批量事务。
- [CC Switch 查询服务](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/usage_stats.rs)：公共过滤与分组聚合。
- [CC Switch React 查询](https://github.com/farion1231/cc-switch/blob/main/src/lib/query/usage.ts)：查询键和刷新失效。
- [New API 日志查询](https://github.com/QuantumNous/new-api/blob/main/model/log.go)：参数过滤、统计与分页。
- [New API 日志表格](https://github.com/QuantumNous/new-api/blob/main/web/src/features/usage-logs/components/usage-logs-table.tsx)：URL 筛选与服务端分页。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：账户协议。


## 图录界面与用量分项

当前视觉图与交互说明见 [设计说明](docs/design/atlas/README.md)。时间、维度、搜索、选择与分页保存到 URL；支持单日／小时下钻、Session 内轮次及跨任务 Turn 排行。

任务标题只读 Codex 本机 `session_index.jsonl`，按 ID 关联最新有效名称；缺失时回退为项目名与短 ID，不读取聊天正文来编造标题。

Session 详情的「Agent 用量」分别显示当前 agent、Subagent 合计和团队合计，可展开每个 agent 的输入、缓存命中、输出及总 Token，并跳转查看其轮次。团队合计递归包含嵌套 subagent；顶部 Session 总数和每个 agent 行保持自身用量口径。缓存命中属于输入，不应再次加到输入和输出之和中。开启成本设置时沿用现有参考费用估算。

团队关系只采用明确的 `source.subagent.thread_spawn.parent_thread_id`；`forked_from_id` 单独保存，普通 fork 不计入团队。关联任务导航会区分子 agent、父 agent、Fork 任务和 Fork 来源。筛选先确定完整关系，再过滤用量，所以无匹配记录的中间 agent 不会隐藏其后代。完整 Session 使用完整范围；范围内详情沿用当前筛选。已知但无有效用量的 agent 仍可打开详情，并标记「暂无用量记录」。

首次使用此功能会自动迁移本地 SQLite 缓存，并在下一次本地刷新时重新解析旧版本已导入的日志（包括未增长的日志），一次性回填关系类型；之后恢复增量导入。原日志保持只读。关系未知或原日志缺失时不推断团队归属，结果只代表本机已保留的可识别记录，不是完整账户账单。新的 agents API 对已知无用量任务返回空指标，对不存在的任务返回 404；原任务详情 API 也支持已知无用量任务。

默认显示非缓存输入、缓存读取和输出。非缓存输入包含写入；写入缺失不会补零，普通输入无法可靠分离时返回 null。`cacheWriteMissingEvents` 标明缺失覆盖情况。

设置中可以开启参考成本与缓存写入列，按模型覆盖 USD / 百万 Token 单价。价格预置核对于 2026-09-08，来源为 [OpenAI API 定价](https://developers.openai.com/api/docs/pricing)。参考额按请求档位计算再汇总，使用整数金额精度；缺失字段或单价时保留不完整标记。它不代表订阅费用，也不含工具费用、Fast/Batch/Flex 或区域附加费。

数据库升级只增加本工具的任务标题字段，现有导入与统计数据保留。不会修改 Codex 的源索引或数据库。
