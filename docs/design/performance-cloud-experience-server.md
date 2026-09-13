# 云端体验：服务端读取与设备接口性能

2026-09-12，本轮以此前所有未提交优化均已存在的工作树作为新基线，HEAD 为 `f25aaf9dcdb4ad31232bb78b2ab5876b95949390`，不是该提交的干净代码。服务端文件指纹、时间、原始 SQL 轨迹与完整响应指纹记录在 `artifacts/performance-cloud-experience/server/`。本轮只在本地实施代码和加性索引迁移；生产测量仅使用 Cloudflare API 的 SELECT / EXPLAIN，未部署、未在远端创建索引或写入数据。

真实 D1 的只读库存测量当时得到 23,134 个当前事件、23,710 个实体版本、242 个来源。用于库存诊断的聚合扫描消耗 943.9ms、47,498 读行，不能代表页面接口延迟。针对设备 coverage 的独立 SQL 探测确认，原 MIN/MAX 各自沿非覆盖设备索引读取候选行：59,954 读行、135.7ms；单遍聚合候选为 29,981 读行、88.2ms。两次均为 `rows_written=0` / `changed_db=false`，只返回设备数量和结果长度，未保存设备身份或覆盖日期。该生产探测仅支持扫描瓶颈判断；生产数据库期间仍可能接受采集写入，完整结果等值由下述隔离本地夹具证明。

本地基准使用锁定依赖中的真实 Workerd/D1、25,000 个事件、250 个来源、2,500 个批次回执、每个候选约 2KB 附加 JSON；运行环境为 Node 24.16.0、Windows 10.0.26200、i7-13700KF。每条路径先预热一次，再测五次中位数；setup 与正确性读取不计时。`devices-http` 经过实际 Worker 路由、会话认证和响应解析，其余路径直接调用真实服务端函数与 D1。已协调其他本地构建/基准暂停，仍不把这些毫秒数当作生产网络或多租户队列延迟。

| 路径 | 本轮基线中位数 | 最终中位数 | SQL 数 before → final | D1 读行 before → final | D1 结果 JSON 字节 before → final |
| --- | ---: | ---: | ---: | ---: | ---: |
| authenticated devices HTTP | 209ms | 7ms | 6 → 2 | 66,607 → 13,257 | 59,125 → 863 |
| syncStatus | 206ms | 9ms | 5 → 5 | 66,605 → 16,607 | 59,060 → 59,060 |
| createRead，full 无设备筛选 | 56ms | 28ms | 4 → 4 | 126,509 → 25,756 | 66,369 → 66,369 |
| manifest，200 项 | 12ms | 10ms | 4 → 4 | 208 → 208 | 146,921 → 15,587 |
| entities，200 项 | 9ms | 9ms | 3 → 3 | 1,204 → 1,204 | 213,625 → 82,291 |
| summary | 274ms | 263ms | 5 → 5 | 150,012 → 150,012 | 198,917 → 3,164 |

结果字节按 `TextEncoder(JSON.stringify(D1Result.results))` 计算，衡量返回字段的序列化体积，不是压缩后的真实传输字节。六条路径、各六轮的完整规范化响应 SHA-256 全部与基线相同；只规范化合成用户/设备/采集器/epoch 标识以及生成的 lease/到期/绑定时间。业务字段、计数、实体 payload、cut 中的版本计数、覆盖来源和设置均参与比较。manifest/实体/summary 的小幅时间变化不作为可靠加速结论；其明确收益是消除重复返回覆盖清单。summary 的实际聚合扫描量没有改变。

实施内容是三处独立的减少工作量：`/api/v3/devices` 直接调用 `deviceViews`，省去原来经 `syncStatus` 读取后丢弃的 domain、来源清单、回执聚合和 jobs；`getRead` 增加有类型约束的 metadata/settings 投影，所有前后有效性检查以及内嵌实体查询的租约校验均保留，创建读取时仍返回完整冻结 coverage/settings；未筛选 full 范围直接统计其固定 cut 上非墓碑版本，避免经过递归 scope 物化 payload，recent 和设备筛选范围沿用原计数逻辑。

设备覆盖先试过单遍聚合，在无新索引的中间版本中，devices 为 106ms、syncStatus 为 110ms。继续实验后选择 `0002_device_coverage_index.sql` 的 partial covering index：`(user_id, uploader_device_id, at) WHERE active=1`，使原 MIN/MAX 各查一个有序边界。最终 SQL 保留边界查询，不保留中间聚合。迁移只增加索引，不改 payload、同步协议、解析规则或设备握手，**无需升级采集器协议**。未应用此迁移的数据库仍得到相同结果，但不能获得覆盖范围查询的主要收益。

独立索引 A/B 在同一隔离 D1 中使用 25,000 条候选、其中 20,000 条 active、28 个不同日期，并记录 EXPLAIN。无索引单遍聚合中位 100ms / 25,003 读行，原双边界查询为 196ms / 50,001 行；有索引的单遍聚合为 6ms / 20,003 行，最终边界查询为 **3ms / 3 行**。两个子查询均命中 `USING COVERING INDEX v3_candidates_device_coverage`。新索引使该夹具数据库增加 2,162,688 字节（约 2.06MiB，20k active 项约 108 字节/项）；本地建索引耗时 113ms、20,001 写行，这是一次性迁移成本，不能外推为生产建索引时长。

| 同输入实际 apply/publication | 无索引中位数（五次范围） | 有索引中位数（五次范围） | SQL 数 | D1 写行 before → indexed |
| --- | ---: | ---: | ---: | ---: |
| 200 个事件、20 个来源 | 77ms（73–93） | 73ms（71–82） | 67 → 67 | 5,301 → 5,501 |
| 500 个事件、20 个来源 | 152ms（151–154） | 148ms（146–151） | 72 → 72 | 12,201 → 12,701 |

写入测试使用有效当前协议批次、真实压缩/接收准备、claimJob 与 applyBatch，计时覆盖 claim/apply/publication；网络传输、gzip 与 receive 准备不计入该写入成本对比。每事件精确 token 为 `9007199254741001`，完整事件指纹、聚合大整数总和与 applied 确认一致。索引每个新增 active 候选增加一个索引写入，总写行增加约 3.8% / 4.1%；没有观测到本地明显写入耗时回退，不能从小样本顺序 A/B 推断写入变快。每个样本后的删除清理也在计时外。

运行命令：

```powershell
# 在本轮修改前的工作树捕获；原始结果已保存，不会自动回退当前代码。
node cloud/test/run-read-benchmark.mjs baseline
# 当前包含 0002 迁移的最终工作树。
node cloud/test/run-read-benchmark.mjs indexed
node cloud/test/compare-read-benchmarks.mjs baseline indexed
# 在隔离本地测试库中暂时删除/重建该索引，同时量化读写代价。
node cloud/test/run-coverage-index-benchmark.mjs
node node_modules/typescript/bin/tsc -p cloud/tsconfig.json --noEmit
cd cloud
node node_modules/vitest/vitest.mjs run test/v3-read-projections.test.ts test/display-views.test.ts test/v3.test.ts test/v3-status-background.test.ts --no-color
```

产物包含 `baseline.{json,log}`、中间无迁移方案的 `after.{json,log}`、最终 `indexed.{json,log}`、`comparison.json`、`coverage-index.{json,log}`、`production-read-only.json` 与 `regression.log`。类型检查和 44 条聚焦回归均通过；回归覆盖跨用户/多设备/无活跃候选、partial index 的 active 切换、retained 与 unavailable/replacement、revoked/deleting、冻结设置、过期/删除拒绝、旧 cut 克隆计数和 manifest SQL 完成后并发删除 lease。通用完整测试与 CUA 体验验收由主任务汇总。

生产 me/devices 曾出现秒级等待的原因尚不能全部归因于本次扫描。Cloudflare 官方说明单个 D1 数据库逐个处理查询，并在并发过多时排队，因此昂贵读取/发布竞争是合理的待验证解释；缺少该线上请求的数据库执行与排队分解时不把它当成已证实根因。[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) 当前 runtime 验收仍使用仓库锁定依赖；最佳实践和类型参考已查阅最新 Cloudflare 文档与临时下载的 `@cloudflare/workers-types@5.20260911.1`，没有升级依赖。[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
