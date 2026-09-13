# 浏览器完整镜像与查询缓存：下行最快路径审计

2026-09-13，只读审计当前 `codex/performance-baseline-20260912` 工作树。没有修改生产源码、协议或部署，没有运行性能基准。本记录的结论来自当前代码和需求合同；数值性能下限需结合主任务本轮的请求/字节测量。工作树包含 9 月 12 日尚未发布的优化，不能将当前行为当作线上已经生效。

## 结论

页面体验的第一优先候选是**在线 query cut 与实体镜像 active cut 独立管理，同时继续完成完整后台镜像**。当前 cold 首屏已解耦，但已有镜像时手动刷新仍等完整同步提升才公开新 query cut。将当前页数据更新与全部镜像落盘分开，可保持完整镜像承诺，又避免页面等待后者。必须继续保证同一页所有查询一致、旧镜像标签不混入新查询，不能只改某一处 lease 选择。

若目标仍是**相同 cut、相同设备范围、相同全部实体、相同可恢复和删除语义的完整镜像**，最有希望的方向是：冷启动使用带实体正文的压缩 snapshot 分块或流，随后沿用已有的 payload 内联 changes；有缓存的日常刷新优先做增量，不因为点击刷新就反复枚举全库 manifest。200 → 500 仅减少清单页数，没有去掉“列清单，再请求缺失正文”的依赖，不能代表下行的性能上限。

若目标是**尽快用网页查看云端统计并保留已打开页面**，成本最低的方向是只保存固定读取 cut、页面查询结果和标签，完整实体镜像按需或后台进行。但这改变了默认的浏览器完整缓存工作范围，不能称为同一完整同步任务加速。当前代码已做到冷启动在线查询不等待实体完成；停止背景下载主要省带宽、请求、校验和存储，不应重复宣称这项已有的首屏解耦收益。

另一个关键纠正：**现在的 changes 已经内联完整实体 payload 和删除引用，不需要再实现一次“changes 内联”。** 真正可探索的是少量提交合批、压缩、断点流、同实体多次修订合并，以及有明确 before/after 范围的设备筛选增量。

## 当前实体镜像到底供谁使用

| 路径 | 当前数据来源 | 全部实体镜像是否必要 | 代码依据 |
| --- | --- | --- | --- |
| 总览、趋势、分析、任务/轮次/项目分页等统计 | 精确键匹配的 `query_results`；缺失且在线时服务端 SQL | 否；浏览器没有扫描全部 entities 计算这些结果 | `modules/sync/browser/data-source.ts:145`，`modules/analytics/worker/executor.ts:5` |
| 离线已打开页面/相同筛选 | 已保存的 API DTO，匹配 query revision、cut、route、参数和时区 | 否；未命中明确报 `OFFLINE_CACHE_MISS` | `data-source.ts:14`、`:150`、`:157`、`:164`；`modules/web/data/data-query.ts:16` |
| 项目名和 alias | 同 cut 保存的标签 → 同 cut 且 applied 对齐的 project entities → 在线 `/projects?lease_id=...` | project entities 是可选回退；不是全 event 镜像必要条件 | `data-source.ts:71`、`:82`、`:95` |
| 单实体读取 | `CloudUsageDataSource.entity(ref)` 读取 active epoch 的缓存实体 | 此 API 需要相应缓存；但生产页面无调用 | `data-source.ts:206`；全量检索 `modules/`、`apps/` 的 `.entity(` 无调用；`modules/contracts/data-source.ts:5` 页面接口不含 entity |
| 同步去重、恢复和镜像完整证明 | entities 哈希、staging、expected counts、连续 commit | 是，这是镜像自身的用途 | `modules/sync/browser/controller.ts:251`、`:281`、`:296` |
| 账号额度 | 独立账户 observation 缓存或账户 API | 否，不依赖 usage lease 或设备用量范围 | `data-source.ts:119`；`modules/sync/browser/cache-model.ts:12` |

单实体 API 返回实体及 `appliedCommitSeq`，并不是完整离线分析引擎；当前增量过程中实体可先按完整 commit 应用、页面仍保持原 cut，项目标签因此额外要求 applied 与 page cut 相等。不要把这个底层 API 擅自解释为所有页面可任意离线计算。

服务端 `queryScope()` 只用 cut 的版本行、用户和 `device_ids` 限定有效事件，**没有 recent 的 `from_at` 限制**。因此 current cold baseline 即使只准备 recent 镜像，也能在线查询该 cut 全历史范围的统计。snapshot 的 recent 范围则包含最近 30 天相关任务的记录、父线程闭包及元数据，不能只拿一个 `at >= from` 截断代替。

## 已确认的产品边界

需求入口 `docs/design/multi-device-cloud-panel-requirements-2026-09-11.md:27`–`:31` 明确：第一次访问端取得活跃/最近 30 天，第二轮补全部历史；全量复用已有数据、初始化后按变化更新；完整离线分析引擎不是必要功能。`:164` 要求不能把近期状态当作全量，`:166` 要求无变化不重复全量处理。

具体实现方案 `docs/design/multi-device-cloud-panel-implementation-plan-2026-09-11.md:306`–`:318` 进一步规定同一 cut 的 recent/full、本人租约范围、断点和校验、完整 commit 后推进 applied，完成数量/分页链校验后才 `full_ready`。其中 manifest → 缺失实体的两段式是工程选择；用户最新性能探索可选择更快的等价传输方式，但完整性条件仍需保留。

现行用户指南 `docs/USER_GUIDE.zh-CN.md:124` 明确写出：“完整实体缓存不代表全部筛选均可离线计算”；`:130` 要求用量缓存相同页面、筛选、时区、读取版本。`CloudSyncStatus.tsx:8`–`:13` 同时对用户显示完整镜像进度和仅保存已打开筛选的离线范围。

| 行为 | 保留完整镜像、换传输方式 | 默认 query-only 的变化 |
| --- | --- | --- |
| 在线全部页面/任意服务器支持的筛选 | 保留 | 可以保留，固定 cut 查询照常执行 |
| 已缓存的相同离线查询 | 保留 | 可以保留 DTO 和标签；切换 cut 后的失效规则仍需一致 |
| 从未打开的离线筛选 | 当前本就不支持 | 仍不支持；不可声称因镜像变少新失去了一项当前能力 |
| 已解析完整实体副本 | 保留 | 不再默认具备；`entity()` 可读范围减少，需明确按需策略 |
| `full_ready`、完整覆盖和 applied | 校验后照常报告 | 必须区分“页面就绪”和“镜像未建立”，不能伪造这些状态 |
| 另一设备组合/另一用户/另一 origin | 独立 namespace | 仍需独立查询许可与缓存 namespace；不能把其他范围 full_ready 当本范围已完整 |
| 真正断网且重新打开一个新文档 | 当前整个 UI 的版本门控需在线首次许可 | 不因保存 DTO 而获得绕过版本门控的离线启动许可 |
| 删除历史、撤销/明确身份拒绝 | 按原规则清除/关闭，拒绝晚到旧写入 | 同样强制；没有实体副本不等于可省略所有缓存删除 |

当前 `CloudVersionSession` 许可仅在已核对的挂载会话内保留；新文档的离线 API 单元测试通过并不等于整站允许离线首次解锁。具体入口见 `modules/web/shell/cloud-gate.tsx:36`–`:62`，解释见 `docs/design/cloud-experience-gate.md:13`–`:19`。

## 为什么目前还有这么多往返

1. `HttpSyncTransport.manifest` 请求 500 条，server 上限也是 500；`entities` server 上限 200，但当前 client 每批 100、两路并发，入口请求体还有 64 KiB 限制。源：`modules/sync/browser/transport.ts:45`–`:52`，`modules/sync/reads/baseline.ts:7`、`:22`，`apps/cloud/routes.ts:65`。直接放大数量未必适合长 ID 或大实体。
2. manifest 是 keyset cursor，前页返回才能知道后页 cursor。现有 client 最多预取下一页并与正文下载重叠，仍存在一条分页依赖链；冷缓存正文还需要独立请求。
3. `controller.ts:93` 已有自动刷新 same-cut 且有效 full lease 的短路；但 `:105` 对显式 manual、设备范围、epoch 改变都走 full baseline。实际点“刷新全部”因此可以重新枚举已有的完整镜像，即使没有缺失正文。
4. 默认 `autoFull=true`；即使设成 `false`，仍会下载 recent，下一轮见 `coverage.scope=recent` 仍进入 full（`:103`）。它是一个用于控制首次续作的选项，**不是现成的 query-only 开关**。Provider 在初始/重连时恢复未完成镜像，也要一起处理（`modules/web/data/cloud-provider.tsx:37`、`:64`）。
5. `IndexedDbCloudCache.write` 的最终 baseline 提升仍对全部 staged refs 做完整性验证，复用旧正文并枚举/prune 全部旧键（`cache-indexeddb.ts:91`–`:111`）。网络缩短后，这段 O(N) 最终事务和逐实体 SHA-256 校验可能成为下一个瓶颈；本审计没有计时，不能宣称当前占比。

对同一冷完整镜像，至少要传输缺失且不可复用的内容、验证它，并持久保存。能降低的是编码字节量、重复 SQL/JSON、往返依赖和缓存写放大；不能通过跳过实体、哈希、删除或最终校验，把较小任务标为完整镜像。页面可查询时间、最后字节到达、镜像验证与持久提升时间应分别测量。

## 候选一：相同完整镜像的 snapshot + delta

建议先做**有界、含正文、可恢复的压缩 snapshot chunk**，再根据测量决定是否值得一个长流或持久 snapshot。保留现有 lease 元数据和范围算法，冷空缓存不再先逐页索取只有 refs 的 manifest，直接领取该 cut 的有序实体 `{kind,id,revision,hash,value}`；跨网络请求分块依据字节预算和稳定 cursor，不能只凭固定实体数量。

每块必须绑定用户、设备范围、完整 cut、scope、序号/游标和格式版本；按原 canonical JSON 算实体 SHA-256，保留精确十进制 token/null。保存块后提交断点；最终核对每 kind 预期数量、唯一/有序实体链及终结证明，然后同一原子操作切换覆盖与读取状态。半块、缺尾、重试、lease 失效只能保留可恢复 staging，不得 `full_ready`。

一个长 NDJSON/其他 framed 流可将多个分页的浏览器 RTT 收敛到一个 HTTP 响应，但不代表一个无限大的 JSON 数组。当前 `jsonRequest` 全量 `response.json()` 不能直接承载真正的分块消费；需要独立读取器、有界解码/校验/IDB 写入和取消处理。可独立解压的块更方便断点恢复；单一 gzip 流若中途断开需要重新请求/重新解码范围，不能假设从任意字节恢复。

snapshot 已准备好时，少量授权请求加顺序下载可能接近这个任务的带宽/校验/存储下限；首次临时生成则包含 snapshot 生成成本，不得把预构建时间藏到测量前。是否放 R2、按需生成还是 Worker 内部拉取 D1，应依据同条件请求/字节/CPU/内存实验决定，当前需求不预设 R2 必需。

删除安全尤其需要终结条件：在途 snapshot 可能已送出旧数据；删除后服务端不得继续授权旧 snapshot，客户端本地 deletion generation/resetUser 必须让晚到块和终结事务失效。可复用文件应按用户、设备集合、完整 cut 和 schema 标识，不能用公开长期 URL 绕过会话和租约核验。

有缓存时，完整 snapshot 每轮重下反而可能更差。保留 manifest/hash 的差量修复路径，或建立按分区的校验摘要，仅下载不一致的块。不要为追求“一次请求”取消已验证的零正文复用能力。

另一个独立候选是**实体缓存按 generation 存储，最终仅切 active generation 指针**：验证过的内容直接写入新一代实体空间，最后检查终结元数据后原子切换，避免 staging 复制到旧 key 空间的 O(N) 最终写事务。旧 generation 后台清理。它改变缓存键与读取/删除/并发标签逻辑，但不减少应保留的实体，可作为网络优化后仍存在明显提升瓶颈时的后续实验；不能仅将现有一次大事务拆小就声称保持旧视图原子性。

本轮已编写严格隔离的接收端原型 `browser-shadow.ts`，导出 `shadowImport(entities, round)`，供主任务在 CUA 中接入现有 25k 输入。每次独立随机临时 IDB，以 `[namespace,generation,kind,id]` 存正文、另一 store 存版本指针，每批 1,000 条只写一次正文；沿用生产 `verifyEntities` 的逐实体 SHA-256，另检查跨批唯一性、物理计数及每 kind 计数，最后 CAS 切指针。计时含验证、批写、count/seal 和提升；初始化、完整逐字段读回、保护性检查与清理不含在导入计时，保护检查耗时单独返回。

原型包含构建中旧 generation 可读、未 complete 不提升、CAS 版本冲突不提升、本轮完整实体值相同与旧 generation 保留的检查。定向 strict TypeScript 检查通过。主任务随后用 CUA 完成真实 Chrome 三对 AB/BA/AB 实验，25,000 条实体完整导入中位数从 10,810.7 ms 降至 5,485.9 ms；六次完整逐字段等值及保护检查通过。完整口径与限制见 [总报告](REPORT.md#浏览器接收端实测)，原始证据为 `artifacts/sync-fast-path-20260913/browser-shadow-comparison.json`。**未实现增量 overlay、GC、跨标签页删除/reset 协议、生产存储迁移，也没有接入产品**，不是可直接合入的 cache backend。

还可以探索**不可变压缩 chunk 直接保存为 IDB Blob + 小型范围索引 + active 指针**。统计页面不扫描全部 entities，因此无需为了这些页面把每个 event 反序列化后另存一条 IDB 记录。保留全部实体正文，在块接收时解压并完成原有逐实体 hash、顺序/唯一/范围/计数验证，再保存原始压缩块；核对整体完成证明后切指针。`entity(ref)` 按范围定位块、按需解压，项目标签可以由固定 cut DTO 或小型元数据块提供。

Blob 方案是新的缓存后端：需要 chunk 摘要、无重叠范围、完整计数/终结校验、断点、用户/设备范围、删除代次和跨标签 CAS，不能只保存一个“已下载文件”标记。按需单实体读取会有整块解码成本，增量需有 overlay 或分块替换策略；解析内存和解压缓存也需有界。**本报告没有其计时结果，不能称它为最快实证**；它只提供一个可能减少逐实体 structured clone/IDB 写操作的候选上限。主任务可另做隔离小原型，与 shadow 逐实体写入在同一完整数据与校验条件下比较。

## 候选二：改进已有增量，而不是重复增加 payload

当前完整链路为：

```text
read 固定 target cut
  → changes(after applied, target lease)
      → 完整 commit 内联 entities + deleted
      → verifyEntities → durable staging → 连续完整 commit 原子应用
  → 到 target 后切页面 active cut
```

依据：`modules/contracts/sync.ts:55`，`modules/sync/reads/changes.ts:8`–`:17`，`modules/sync/browser/controller.ts:296`–`:343`。server 每页 limit 最大 100 个 commit，client 固定 20；选择页时通常将总变化项约束在 1,000 内，但第一个大 commit 不拆，因此 1,000 **不是绝对响应大小上限**。

按成本/风险排序的候选：

- **优先验证 manual 刷新完整未限定设备缓存时走现有 delta**，将强制全库核对作为明确单独操作或周期性校验。这样保留最终完整镜像，不是在略过历史；连续完整 commit 是更新依据，过期/epoch/删除仍回 baseline。需对照用户“刷新全部”的含义，而不是静默把核对功能移除。
- **小 commit 多时把 changes limit 20 调至最多 100**，保持当前 1,000 项选择预算和完整 commit 边界。若小 commit 数是瓶颈，可减少请求；若每页已被大 payload 占满，增大该值没有同样收益。需保留真实 byte budget，并测试首 commit 很大和中断恢复。
- **压缩或在同一响应连续送出多个已有 changes page**，保留固定 target 和完整 commit 的持久水位。这减少传输往返，但仍传多次修订的全部中间版本。
- **base → target 的净变化集**：同一实体多次修订只发送 target 最终值，已从 base 消失的发送删除引用。这能减少字节，但不兼容当前逐个 `seq+1` 应用断言。必须新定义“该范围全部提交已覆盖”的终结/摘要和原子 range 应用，只有完整到齐才推进 applied，不能直接跳 commit 序号。输出等价目标为 target 完整实体集合，不要求向浏览器重放全部中间观察。
- **周期性分区哈希/清单校验**：正常连续 delta 不扫描所有 refs；定期证明 base 完整性，发现差异再修补。该校验本身仍有服务器维护和周期成本，不应凭采样就宣布全库内容正确。

changes 保留 7 天并以 `changes_floor` 拒绝过旧 cursor（`modules/sync/reads/cleanup.ts:5`–`:8`）；超出窗口和 epoch 重建仍需 snapshot。不能让客户端无限依赖已回收的日志。

**设备范围不能直接启用当前 delta。** `changes.ts` 查询全用户 commit，返回的 payload 没有按 lease.device_ids 过滤；因此 controller 目前有设备筛选时选 baseline 是语义保护。正确的范围增量需要比较 base/target 的 membership：事件执行来源从 A 移到 B，A 要删除、B 要新增；全局去重候选变化、相关父线程闭包和组织元数据也要保持一致。单纯按新 payload 的设备字段过滤会漏掉旧范围移出和元数据变化。可用固定 base/target 版本差集解决，但要重新定义 scoped coverage、空提交/游标与完整性证明。

## 候选三：查询缓存优先，镜像按需或后台

此方向保留原 UI、在线全部功能、完整云端历史及精准 server query，但改变“每个访问命名空间默认最终下载所有实体”的要求。对当前用户看数值而言，常态传输可以缩为有效 query ticket + 本页 DTO/标签；后台镜像可暂停/稍后继续，或在用户明确需要本地实体副本时启动。

需要正式区分 query cut 与 entity mirror cut，不能把未完成的 baseline 永久当 query-only 状态：

- 新增独立的 page read 状态，覆盖 namespace、cut、expiry、settings/timezone 和稳定显示时钟；实体镜像维护自己的 generation、coverage 与应用游标。
- 查询 ticket 不需要强迫计算完整镜像的 expected entity counts/source coverage；当前 createRead 会做这些工作，真正轻量接口应与镜像 read 分开，同时保留 server-side scope、版本和删除核验。
- 所有页面查询仍捕获同一 query cut，切换时统一 revision；不能各卡片随各自 HTTP 请求拿最新 cut。镜像在后台追赶时只有相同 cut 的 project entities 可以供标签回退。
- cache.putQuery 的事务检查改为独立 query cut；后台 mirror finalize 的 clearQueries 不得误清已经更前的新 query cut。跨标签 CAS、resetUser、logout、删除 generation 仍生效。
- 继续按 origin+用户+排序去重设备集合隔离；可研究同用户内容寻址去重 payload，但 scope membership 和查询许可仍分别保存，不能拿全用户镜像自动宣称某个子范围完整。
- UI 应显示“页面已就绪 / 本地完整历史尚未缓存”等真实状态。原“首次近期再全量”和刷新行为、用户指南、验收合同要同步调整；保留 DTO 的离线能力与取消全镜像成本分开报告。

若选择保持后台自动全镜像，仅调度在页面关键查询后并提供暂停，可以减少前台争抢，仍最终保留原承诺；这并不会缩短实体完整任务本身的工作量。若默认完全不做全镜像，常态网络最少，但应明确是需求取舍。

## 下一轮可比较的独立实验

保持同一输入、同一 base/target cut、同一 namespace，分别测试冷空缓存、同 cut 全缓存、少量新增、同一实体多次修订、设备执行来源移出/移入、删除、变化流过期、大单 commit 和断网续传。现行 500 manifest +100×2 正文路径作为完整镜像对照；payload snapshot 和优化 delta 最终实体逐条/hash/数量/删除集合完全一致。

独立记录：页面首个完整可用查询、最后正文到达、全部校验完成、IDB 原子提升、scope 完整证明；HTTP 请求、压缩/解压字节、D1 rows_read、校验 CPU 和 IDB 写入量。query-only 实验必须单独显示“未执行实体镜像”，不能进入完整同步加速表。用原有真实 CUA 验证取消/换用户/离线页面/删除竞态，不以接口返回时间代替 DOM 可用。

本审计建议先将 query cut 与 mirror cut 分离以消除刷新后的页面等待，同时保留完整后台镜像；再用 snapshot + 已有 delta、generation 指针及可选 Blob 后端减少相同完整任务的传输与落盘。默认取消镜像的 query-only 是另一项明确产品取舍。除上述隔离 fixture 外，没有实施生产变化或承诺任何目标秒数。
