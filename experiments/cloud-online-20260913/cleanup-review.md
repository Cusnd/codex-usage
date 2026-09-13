# 旧 epoch 清理：100k 本地复现与最小修复

2026-09-13。已确认原 `cleanupVersions` 旧 epoch 删除查询在“全部属于当前 epoch、没有可删除数据”时仍扫描整个事件索引。经任务确认后，仅将生产旧 epoch 五表循环改为两个索引范围；没有新增表、索引、迁移、持久游标或调度协议，没有部署和远程数据操作。

## 实测范围与结果

真实本地 Workerd/D1，使用项目锁定的 Wrangler / Vitest 和现有 0001、0002 迁移。独立测试只给 **v3_events** 写入 100,000 条当前 epoch 事件，payload 为合成的 `{"total_tokens":"7"}`，没有旧 epoch、lease 或构建任务。其他四张表只取得 EXPLAIN，没有制作大夹具或执行全表规模矩阵。没有扩大到 1m。

直接运行真实 DELETE，三轮按 A/B、B/A、A/B 顺序；正确结果应始终删除零行。结果：

| 方案 | D1 rows_read，每轮 | rows_written / 删除数 | Workerd 本地 wall ms，三轮 | D1 duration ms，三轮 |
| --- | ---: | ---: | --- | --- |
| 原 `epoch<>active_epoch` JOIN，LIMIT 1000 | **300,001** | 0 / 0 | 25 / 24 / 25 | 22 / 22 / 23 |
| domain 外层 + 两个 epoch 索引范围 | **5** | 0 / 0 | 2 / 3 / 2 | 0 / 0 / 0 |

`rows_read` 包含索引、关联和保护条件访问，不代表存在 300,001 条事件。原查询计划明确显示 `SCAN v USING COVERING INDEX v3_event_effective_origin`，候选改为先 `SCAN h`，再 `SEARCH v ... (user_id=? AND epoch<?)` / `(user_id=? AND epoch>?)`。全部 100,000 当前事件完整保留。

**LIMIT 1000 限制命中的候选数量，没有限制扫描工作量。** 无旧 epoch 时原查询为了确认零命中仍扫描当前事件，候选则从现有 `(user_id,epoch,...)` 索引直接定位当前 epoch 两侧的空范围。此测试支持消除该无效扫描，不是线上 CPU reset 的完整复现；本地没有发生 reset。wall 数字仅为短时 loopback 实验，D1 duration 为 0 也不表示执行没有成本。

五表 EXPLAIN 均从原事件/版本索引扫描变为 epoch 范围定位，包括 `v3_entity_versions`、`v3_events`、`v3_aggregates`、`v3_aggregate_members` 和 `v3_commits`。只有 events 的 100k 行数属于本次实测，其余表仅确认 planner 形态。

## 已实施的最小变更

生产文件为 `modules/sync/reads/cleanup.ts`，仅改最后一个旧 epoch 循环。其逻辑结构是：

```sql
DELETE FROM <table>
WHERE rowid IN (
  SELECT v.rowid
  FROM v3_sync_domains h CROSS JOIN <table> v
  WHERE v.user_id=h.user_id AND v.epoch<h.active_epoch
    AND <原 live lease / pending-or-running job 保护>
  UNION ALL
  SELECT v.rowid
  FROM v3_sync_domains h CROSS JOIN <table> v
  WHERE v.user_id=h.user_id AND v.epoch>h.active_epoch
    AND <相同保护>
  LIMIT 1000
)
```

epoch 非空且两侧互斥，与原 `<>` 条件等值。CROSS JOIN 固定 domain 为外层，使已有复合索引可按 user + epoch 范围查找。LIMIT 位于整个 UNION ALL 之后，因此仍然是**每张表、一次调用、所有用户和两个范围合计最多 1,000 个根记录**，不是每分支各 1,000。所有选择和删除仍在同一 SQL 内，lease/job 保护没有移到会产生竞态的独立查询中。

没有改已关闭版本的清理、7 天 changes floor、commit 的级联关系或 cron。删除 commit 的 changes 级联仍可能影响多于 1,000 个物理记录，和旧合同一致；此次不将根记录上限误称为所有物理写入上限。

## 正确性与回归

独立实验附带的四条旧数据确认了两侧各一条可删除记录、一个活动 lease 和一个 pending 私有 epoch 的保护。随后新增常规小夹具 `cloud/test/v3-cleanup-epochs.test.ts`，实际调用生产 `cleanupVersions`，覆盖：

- 五张表两个方向的旧 epoch 均被收集，当前 epoch 保留。
- 未过期 lease、pending 和 running 构建保留各自用户的 epoch；同名 epoch 在另一用户下不会被错误保留。
- 过期 lease 删除后，其旧 epoch 可以收集。
- 两个用户分处两个范围，各 600 条记录，五表分别剩 200 条，证明全局合计删除 1,000 条；commit 对应 changes 正确级联。

定向回归合计 **9 项通过，30 项按名称筛选跳过**：新 GC 两项、既有旧版本/活动 lease GC 一项，以及页面读取六项。完整 cloud TypeScript 和 deploy TypeScript 均通过。100k 性能实验保留在 `experiments/`，不进入常规测试集合。

另修复真实 HTTP 验收发现的页面续期空 body：网络 POST 的 `request.body` 可能是非 null 的零字节流，因此改为有界读取实际字节；零字节允许，非空仍要求 JSON 且只能为 `{}`。新增零字节流回归，浏览器代理的真实 HTTP 复验也已通过。这项在 `apps/cloud/routes.ts` 和 `cloud/test/page-read.test.ts`，与 GC 变更分别记录。

## 边界与后续

该修复消除了“全部是当前 epoch”这一已复现的无效扫描。若有大量旧 epoch 记录被 lease/job 长期保留，候选仍可能扫描许多旧记录；它不是严格的每次扫描预算。首先验证此小改动的实际收益即可，不需要为了当前问题新增持久 cursor 表。

若未来必须给所有场景提供严格扫描预算，需要额外的持久进度和公平轮转，处理用户、表、epoch、游标及任务/lease 状态变化，并验证不能跳过保护解除后的数据；这会增加 schema、迁移和恢复语义。此次没有引入这些成本，也没有尝试调整线上 cron。

## 复现与证据

在 `cloud` 目录执行隔离实验：

```powershell
node node_modules/vitest/vitest.mjs run --config ../experiments/cloud-online-20260913/cleanup-vitest.config.ts
```

配置复用现有本地测试隔离和迁移，不含远程命令。结果自动保存到 `artifacts/cloud-online-20260913/cleanup/results.json`，含全部 SQL、五表 EXPLAIN、六个样本和正确性记录；`run.log` 保存原始输出。

生产回归记录为 `focused-tests.log`，完整 cloud 类型检查记录为 `cloud-typecheck.log`，deploy 类型检查为 `typecheck.log`，生产 GC diff 为 `production.diff`，均在同一 artifact 目录。没有启动常驻实验服务。
