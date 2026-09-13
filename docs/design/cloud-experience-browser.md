# 云端浏览器同步与查询链路优化

本轮在 2026-09-12 第一轮性能优化后的工作树上，先测量组件基线，再实施同步与查询变化。范围是 `modules/sync/browser/`；身份与版本门控、Worker 读取 SQL 的独立变化见其他报告。没有部署生产。

## 问题与决定

主任务通过 CUA 观察到两种实际等待：已有 IndexedDB 的生产页面因读凭证过期，多个卡片同时续期并收到 409，重试后仍需用户手动刷新；新的单设备命名空间有 1,015 个实体，图表在 22.180 秒后出现，完整缓存耗时 29.010 秒。后一案例是单设备范围，不能当作 23,553 个实体的全库冷启动测量。

原控制器必须完成 recent 实体下载，才提供页面查询凭证。在线查询本身由服务端固定 cut 和 device IDs 限定，并不读取浏览器下载中的实体，也不受 recent manifest 的时间范围限制。因此冷启动可以在 read 响应验证并持久化后查询完整的服务端统计，同时继续下载本地离线缓存。

新增 `queryLeaseOf(state)` 统一选择规则：有 `activeLease` 时始终使用完整旧视图；只有完全冷启动、没有 active 时，才使用经过验证的 baseline lease。提前查询不会设置 `coverage`、增加 `appliedCommitSeq` 或冒充 `recent_ready`。首次查询的显示时钟在 baseline 建立时固定，recent 到 full 的同 cut 升级保留该时钟和页面 revision。

## 实施的变化

- 同一个读凭证的续期合并为一个请求，旧页面捕获的凭证复用已存储的新过期时间。已明确失效的 ID 在当前控制器内记忆，避免各查询重复发送相同 409 请求。
- 对 `BASELINE_REQUIRED` 执行一次共享的自动恢复。完整、未限定设备范围的缓存优先沿用原增量流程；cut 未变化时，新凭证直接服务原页面。cut 变化时拒绝旧捕获视图，并通过 revision 更新整页，禁止混用两个 cut。恢复后的读取再次失败就停止，不形成无限恢复循环。
- 冷 baseline 失效时，恢复等到新的 verified baseline 即可返回，不等待实体下载。已有 active 的页面仍等待新完整视图正常提升。
- 相同 URL、查询参数和读取代次的 GET 合并，包括 usage、项目名称与 accounts。每个订阅者独立取消，只有最后一个订阅者取消才中止共享 HTTP 请求。合并表属于数据源实例，凭证 ID 与参数进入键；accounts 另包含失效代次。
- manifest 请求上限从 200 提升至服务器已支持的 500。实体仍按每请求最多 100 条下载，每一轮最多并发两个请求；响应校验和持久写入保持 manifest 顺序。一支失败时中止并等待另一支，不提升部分覆盖。
- `putQuery` 在 MemoryCache 和实际 IndexedDB 原子事务内检查当前可查询 cut。冷查询可持久缓存；删除或别的标签页清理后，晚到的响应不能重新写入。删除版本比较也使用可查询 cut，覆盖“冷查询已缓存、baseline 未完成、删除已结束后重开”的情形，并清理该用户全部设备命名空间。

显式手动刷新仍按既有策略进行完整核对。对于 23,553 个 manifest 项目，500 条分页意味着理论请求数从 118 降至 48；这是分页算术，不是新的生产计时。设备限定范围的完整刷新策略也保持原合同。

## 固定组件基线

`scripts/cloud-experience-browser.ts` 使用实际 `CloudSyncController`、`CloudUsageDataSource`、`HttpSyncTransport` 与 MemoryCache。HTTP dispatcher 提供确定的服务端应答，每次网络请求注入 80 ms 延迟；因此测试确实经过 transport 的 500 条限制，而不是另写一套分页规则。实体为 1,000 条固定内容，recent 包含 200 条，三次独立重复，Node v24.16.0。

所有轮次完整缓存均与原始 1,000 条实体深度相等。相同查询结果逐个深度相等，包含超过 JavaScript 安全整数范围的十进制 token 字符串。以下时间为中位数：

| 指标 | 修改前 | 最终修改后 | 解释 |
| --- | ---: | ---: | --- |
| 首个可用于在线查询的 lease | 464.50 ms | 186.25 ms | −59.9%；after 在 recent 实体未完成时可用 |
| 完整缓存完成并核对内容 | 1,488.19 ms | 1,036.78 ms | −30.3% |
| recent + full manifest 请求数 | 6 | 3 | recent 1 页，full 从 5 页降为 2 页 |
| entity 请求数 / 最大并发 | 10 / 1 | 10 / 2 | 总内容和请求粒度不变 |
| 6 个同时相同 usage 请求 | 6 | 1 | 结果相同；项目名称请求同样 6 → 1 |
| 6 个不同过滤器接近过期时的 renew | 6 | 1 | 保留 6 个不同 usage 请求 |
| 失效凭证下 6 个查询成功数 | 0 / 6 | 6 / 6 | after 共 1 renew、1 status、1 read，无 manifest 重扫 |

这里的原始 JSON 字段 `recentMs` 表示脚本 `controller.view()` 首次返回时间，不能在 after 中解释成 recent 缓存完成时间。为了隔离变化，还保留了实施合并、恢复和并发下载后、提前提供 cold lease 之前的 `after-recovery-only.json`；其中首可查询 lease 中位数为 374.89 ms，完整缓存为 1,030.89 ms。

请求合并主要减少负载，不能据此宣称单批查询延迟下降：相同 usage 批次的中位数为 174.22 → 177.25 ms，接近过期的不同过滤器批次为 186.13 → 187.30 ms。原失效查询约 92 ms 即失败，after 约 372 ms 自动成功；这两项结果不同，不能计算为性能回归或加速比例。

## 浏览器与正确性证据

主任务已通过 CUA 验证含初版 cold lease 的本地实际 Workerd / D1 / IndexedDB 构建。72K tokens 合成 fixture 将实体响应人为延迟 2 秒，summary 在导航后 820.4 ms 返回，图表 DOM 在 872.2 ms 出现，总量在 885.6 ms 出现，而第一个实体响应在 2,843.1 ms 才返回。这证明图表无需等待实体下载。它是受控本地验收，不是生产网络的新耗时，也不是 72,000 个实体。

最终边界修复后的构建 `index-Dfn7gbQe.js` 已再次通过同类 CUA 验收：summary 在导航后 **673.1 ms** 返回，图表在 **729.6 ms**、统计在 **735.7 ms** 出现，首个实体响应为 **2,697.2 ms**；完整缓存随后就绪，最终浏览器离线仍保留 **72K tokens**。真实 IndexedDB harness **11 / 11 项全部通过**，包括冷查询缓存的持久化、跨标签页删除后晚到写入拒绝，以及完整 active cut 优先于新的 baseline。两次 CUA 是先后功能验收，不用其时间差计算新的优化收益。最终构建指纹、完整集成结果与发布边界统一见[云端体验总报告](cloud-experience-2026-09-12.md)。

51 项 Node 专项测试通过，覆盖原同步/manifest 预取回归与本轮 11 项独立场景：冷缓存在线查询和离线重开、缺失查询、换用户/设备隔离、同 cut 完整升级、跨标签页晚到响应与删除、删除已完成后的冷重开、冷 checkpoint 自动恢复、共享续期、不同 cut 的整页失效、恢复时删除、独立请求取消、两路实体失败和部分覆盖不得提升。

另在真实浏览器 IndexedDB harness 添加两项检查：冷查询的持久缓存与删除后晚到写入，以及完整 active cut 优先于更新中的 baseline。这两项已经包含在上述 CUA 的 11 项通过结果中，Node 测试与实际 IndexedDB 证据分别保留。三个 TypeScript 配置检查均通过。完整集成及最终 CUA 结果见上述总报告。

## 复现与原始记录

```powershell
node --import tsx scripts/cloud-experience-browser.ts after
node --import tsx --test tests/cloud-experience-browser.test.ts tests/web-cloud-sync.test.ts tests/web-cloud-prefetch.test.ts
npx tsc --noEmit
npx tsc -p tsconfig.node.json
npx tsc -p tsconfig.browser.json
```

`before` 是修改前实际运行保留的结果。当前源码已优化，直接以 `before` 参数重跑只会使用当前源码，并不自动切换版本。第一轮保留的前端构建仍位于 `artifacts/performance-current/browser/after-final/cloud/`，主任务将其用于浏览器 before 对比。组件脚本中的网络延迟、实体数量、固定 cut 与接口 dispatcher 都是明确的合成测试条件。

- 组件原始数据：`artifacts/cloud-experience/browser/before.json`、`after-recovery-only.json`、`after.json`。
- 对应控制台：`artifacts/cloud-experience-browser-before.log`、`artifacts/cloud-experience-browser-after.log`。
- 最终专项输出：`artifacts/cloud-experience/browser/focused-final.log`。
- 初版真实冷查询 CUA：`artifacts/cloud-experience/gate/after-delayed-entities.json`。
- 最终真实 IndexedDB、冷查询与离线 CUA：`artifacts/cloud-experience/gate/final-indexeddb.txt`、`final-delayed-entities.json`、`final-offline.txt`。
- 生产基线：`artifacts/cloud-experience/production-expired-cache.json`、`production-manual-recovery.json`、`production-cold-device.json`。

这些改动保留固定 cut、哈希校验、原子覆盖提升与命名空间隔离。线上全量耗时仍会受到数据体积、网络 RTT 和服务端执行影响；本轮本地结果不能替代部署后的生产复测。
