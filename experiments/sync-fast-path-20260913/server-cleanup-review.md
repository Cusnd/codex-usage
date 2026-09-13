# 定时 cleanupVersions 风险：只读代码审查

2026-09-13。未修改生产、未执行远端清理/统计大查询，也没有启动新服务或基准。

父任务保存的 `artifacts/sync-fast-path-20260913/production-worker-errors.json` 包含三条抽样 scheduled 事件（04:58:57、05:02:09、05:04:57 UTC），均为 D1 自报 CPU 超限并 reset，调用栈为 `cleanupVersions(index.js:9096:115) → scheduled`，部署版本 `29db4b4d-d328-416a-956d-eac4475d530e`。抽样结果不能作为事故总次数。

最强线索是 `modules/sync/reads/cleanup.ts:10` 的旧 epoch 五表删除循环。当前 `artifacts/cloud-experience/worker-dry-run/index.js:8738` 中该循环的 `await` **正好位于第 115 列**，与线上栈列号吻合；本地较早的 product bundle 也保留同一行结构。尚未核对线上版本的精确 bundle/source-map，因此这是高可信定位线索，不能据此断言具体失败表。

核心 SQL 形态是：

```sql
DELETE FROM <table>
WHERE rowid IN (
  SELECT v.rowid
  FROM <table> v
  JOIN v3_sync_domains h ON h.user_id=v.user_id
  WHERE v.epoch<>h.active_epoch
    AND NOT EXISTS(<active read lease for v.user_id,v.epoch>)
    AND NOT EXISTS(<pending/running job whose checkpoint epoch=v.epoch>)
  LIMIT 1000
)
```

最可能的风险：**LIMIT 1000 限制命中/删除的根记录数，没有限制为找到它们而扫描的行数。** 当绝大多数数据属于当前 epoch，或旧 epoch 仍被 lease/job pin 住时，可能扫描整个大表却删除零条；五张表每分钟重复此工作。条件 `v.epoch<>h.active_epoch` 需要先取得外表对应的 domain，没有明确旧 epoch 等值范围；现有主要索引以 user/epoch 开头，本身不代表查询能绕过全部活跃数据。必须通过 EXPLAIN 和 rows_read 验证具体 planner，而不是仅凭这段 SQL 宣称已测到全表扫描。

另有两项放大风险：

- 当前 epoch 的历史 commit 清理（同文件第 7 行）没有 LIMIT，删除 commit 会通过外键级联删除 `v3_changes`；最终五表循环即便限制 1,000 个 commit，级联变化记录也不受该数量上限限制。
- `scheduled` 每分钟先做 cleanup、advanceJobs，再做 cleanupVersions。现有注释约束的是 SQL 条数；没有为这些 GC 查询设扫描行数预算。单个 D1 数据库依次处理查询，长 GC 会阻塞同库前台请求；health 本身执行 `SELECT 1 FROM users LIMIT 1`，所以“简单 health 也变慢”与 D1 被占用/重置相符，但仍不是完整因果证明。[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

现有 `cloud/test/v3.test.ts` 的 GC 回归覆盖 7 天 history floor 和活动 lease 保留，只用很小的数据，不能排除规模瓶颈。日志明确指向 D1 reset；不应直接当作 Worker JS CPU 超限，或未经验证就提高 Worker CPU 配额。

下一步局部验证建议：

1. 本地建立 100k、再按必要性扩至 1m 的“只有当前 epoch、完全无可清理数据”夹具。逐表运行原查询的 EXPLAIN / 只选 rowid 的等值 SELECT，记录 rows_read、时间和命中零行，先定位无效扫描。
2. 分别增加已废弃 epoch、活动 lease pin、pending/running 私有 epoch、很多历史 commit 与 changes。校验完整清理范围、级联影响和 lease 正确性，不能只测删得快。
3. 对比以 `(user, old_epoch)` 为明确工作项、持久游标、每轮扫描预算的候选；检查“暂时被 pin 的前缀”不会让后面的可清理项永久饿死。索引候选必须以实际 planner 和写入代价决定，不能先假设加索引即可修复。
4. 正确性和负载验证后才讨论生产缓解；本轮没有改 cron、关闭清理、删除历史或做任何远程迁移。
