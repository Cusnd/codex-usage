# 完全在线云端 CUA 夹具

仅本地验收。生产入口、构建配置、数据与远端均不修改。包装已有 `cloud/test/browser-worker.ts`，使用真实 Worker / D1 / 当前 `/api/v3/view` 与全部既有统计、设备、项目、设置和账户路由。

主代理负责候选构建与所有 CUA 操作。请先把最终候选构建到 `artifacts/cloud-online-20260913/build`，例如在仓库根目录执行：

```powershell
node node_modules/vite/bin/vite.js build --mode cloud --outDir ../../artifacts/cloud-online-20260913/build
powershell -NoProfile -File experiments/cloud-online-20260913/start.ps1
```

启动脚本只应用隔离本地数据库迁移、监听 `127.0.0.1:18790`；窗口隐藏，日志与根进程/子进程身份记录在 `artifacts/cloud-online-20260913/`。端口已占用时直接拒绝启动，不杀其他服务。控制入口：<http://127.0.0.1:18790/__online>；完整页面：<http://127.0.0.1:18790/>。

控制页先创建合成用户与双设备：A 为 72,000 Tokens，B 为 18,000，默认全部 90,000。快速模式共两个 token events，规模模式共 1,001 个 token events；这里的 72K / 18K 都是 Tokens，不是实体数量。每次种子创建新用户，不覆盖前一用户，便于测试身份隔离。所有数据由真实 handshake/ingest 创建；B 同时上传严格合成的 25% 已用配额，账户历史为空。生产接口没有用假结果替代。

现有 API 合同：`POST /api/v3/view` 接受 `{device_ids?: string[]}`，返回 `{user_id,lease_id,cut,settings,expires_at}`；`POST /api/v3/view/:id/renew` 不接新范围，返回同形结果。实际读取由真实 Worker 实现。额外延迟默认每个 v3 请求 120 ms，可切 0 ms。故障仅可让 view/usage 或全部 v3 返回 503，**不拦截 `/auth/logout`**。这模拟服务器不可达/故障体验，不能称作浏览器物理断网。

推荐 CUA 顺序：

1. 创建新种子，打开首页，等待真实图表与 90K 统计；保存浏览器观测与服务端观测，检查首开 API 序列和控制台错误。
2. 依次访问 overview、trends、analysis、projects、tasks、turns、agents、accounts、settings、devices 等现有路由，并走项目/任务/回合下钻。路由名称以当前应用导航实际提供的为准，不杜撰页面。B 配额为合成 25% 已用，缺失账户历史须显示真实空状态。
3. 切 A / B / 全部，分别检查 72K / 18K / 90K；切换后所有图表与标签保持一致范围。刷新无新数据不应下载镜像。
4. 控制页点击真实上传 +9K，页面刷新后全部应为 99K、B 为 27K，A 仍 72K。可验证刷新取得新 cut、旧视图迟到请求不覆盖新视图。
5. view/usage 503 时刷新与切路由：明确错误状态，无虚构“离线缓存完整”；恢复后重新读取。全部 v3 503 超过 15 秒再检查门控与页面；登出始终走真实 `/auth/logout`。
6. 旧协议拒绝、恢复协议，撤销登录会话后应关闭私有页面。再次新种子验证换用户不沿用旧统计。
7. 真实删除 B 历史，下一有效视图不再显示 B 用量；删除过程中失败/重试不回退到已撤销数据。全局账户删除使用现有 UI 流程；种子可以新建用户恢复后续阶段。
8. 每阶段都断言没有 `/sync/read`、manifest、entities、changes 请求，没有 IndexedDB 统计 add/put 写入。若有一次旧缓存清理 `deleteDatabase`，应单列且不能算数据缓存写入；已有数据库残留也不能据此推断本轮有写入。

本地 HTML 在应用脚本前注入 metadata-only 观测器。它包装 fetch 和 IndexedDB 方法，记录路径、状态、时间、数据库/存储名称及操作，**不保存统计 payload 或读取 IndexedDB 缓存值**。`window.__cloudOnline.snapshot()` 返回当前文档观测，`window.__cloudOnline.report()` 将它提交本地夹具。页面空闲后与 pagehide 自动保存；控制页“读取观测”可查看最近文档记录。完整响应还可由只读 shell 抓取 `GET /api/test/online/observation` 保存 artifact。观测脚本本身增加少量开销；固定延迟的时长只能声明本地模拟，不能与历史线上直接相减。

旧/新 A/B：最终 candidate build 完成后运行 `node experiments/cloud-online-20260913/copy-baseline-assets.mjs`。只添加旧版缺少的 hash 命名资源，共用同内容资源；原 `artifacts/cloud-experience/after` 保持只读。旧资源不得算作候选 bundle 体积。控制页选择“旧版完整镜像 UI”或“候选在线 UI”，再打开相同 `/`；每次新文档的 `snapshot.variant` 固定为实际加载版本。一次仅保持一个面板标签，切换前保存/关闭上一面板。重新构建 candidate 会清空旧资源，必须再次运行复制脚本。`verify-variants.mjs` 验证 HTTP/资源 hash 并恢复 candidate，不操作浏览器。

观测器通过同源外部脚本 `/__online-telemetry.js?variant=...` 加载，保留生产的 `script-src 'self'` CSP。`instrumentation.scriptExecuted`、`fetchInstalled`、全部 `indexedDBHooks` 都要实际为真，才可把零操作报告为零；只有 HTTP 验证不能证明脚本已执行。IDB 精确计数在 `indexedDBCounts`，`indexedDBOperations` 仅保留前 250 个样本防止观测流量影响性能。

`milestones.summary` 是 `.metrics-total strong` 首次出现可见数字的 DOM 时间（同时记录 `summaryText`，例如 90K），不使用 shell/chart 时间替代；它不是浏览器首次绘制/FCP。`summaryTransitions` 记录后续数值变化。每个 API 的 `decodedResponseBytes` 是实际读取的解码响应字节数，`headersEnd` 与 `bodyReadEnd` 分列；`resources` 提供 ResourceTiming 的传输/编码/解码字节与请求阶段。每 3 秒自动报告，加空闲/离开报告。记录只提取响应元数据和字节长度，不保存统计 payload。

所有数据都在本地隔离目录。完成后：

```powershell
powershell -NoProfile -File experiments/cloud-online-20260913/stop.ps1
```

停止脚本先校验记录的根 PID 创建时间与命令行，再清理该任务的进程树，保存 `cleanup.json` 并验证端口关闭。不删除任何数据库、代码或其他任务服务。
