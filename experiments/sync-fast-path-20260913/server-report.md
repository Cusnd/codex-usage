# 云端下行协议：本地 Workerd / D1 实验

2026-09-13。结论：**冷缓存完整下载值得从“清单 + 按键取正文”改为带 hash 的有界实体页。** 在相同认证、设备兼容检查、固定 cut 和逐实体完整性条件下，25k 事件全量下载的本地中位数从 3,911 ms 降至 799 ms（1,000 条 / 1 MiB）或 596 ms（5,000 条 / 4 MiB）。连续 gzip 流为 708 ms，未比大页更快，也没有更早交付首字节。这里只实施了隔离原型；生产 `modules/`、`apps/`、迁移和线上资源均未修改。

## 最终公平对照

最终结果只采用 `artifacts/sync-fast-path-20260913/server/parity-final.json` 的 **12 个样本**：相同 25,000 事件 + 250 个 thread，四方案各三轮，顺序为 A/B/C/D、D/C/B/A、A/B/C/D。各请求均使用真实 loopback HTTP 和 gzip。候选执行与生产相同的 `versionGate → sessionUser → scope/lease` 校验链，包含全部未撤销设备的协议兼容检查；没有靠省略门禁获得收益。

| 方案 | 完整到达中位数 ms | 范围 min–max ms | HTTP | D1 SQL | D1 rows_read | 原始响应 JSON 字节 | gzip 实际正文总字节 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A：manifest 500 + entities 100 × 2 | **3,911.1** | 3,897.1–3,948.3 | 304 | 2,381 | 182,023 | 20,707,020 | 3,661,905 |
| B：内联实体 1,000 / ≤1 MiB | **798.9** | 797.2–800.0 | 26 | 208 | 177,247 | 17,504,964 | 2,487,363 |
| C：内联实体 5,000 / ≤4 MiB | **596.1** | 589.6–597.7 | 6 | 48 | 176,867 | 17,499,544 | 2,474,424 |
| D：连续 gzip NDJSON，每块 1,000 / ≤1 MiB | **707.9** | 674.3–737.6 | 1 | 135 | 177,001 | 17,505,749 | 2,479,350 |

A 忠实复现当前调度：读取下一页 manifest 与本页正文重叠，正文按 100 条分批且最多两个并行请求。候选仅改变传输形态，没有把 A 人为串行化。计时从首个下载请求开始，到 Node 完整接收、解压并解析结束；不含建库、seed、创建 lease、正确性 hash 校验、IndexedDB 写入、云端 RTT 或任何模拟 RTT。gzip 字节只统计响应正文，不含 HTTP/TLS 头。

全量 D1 rows_read 只下降约 3%，而 HTTP 和 SQL 数大幅下降，说明主要收益来自少发请求、少做重复认证/兼容/租约校验和少传清单元数据。C 的本地总耗时下降约 84.8%，gzip 正文下降约 32.4%；这些百分比不是线上端到端改善承诺。

| 指标，中位数 | A | B | C | D |
| --- | ---: | ---: | ---: | ---: |
| 首个响应正文的首字节 ms | 13.0 | 29.5 | 99.0 | 570.1 |
| Workerd 进程 CPU 增量 ms | 2,984.4 | 625.0 | 500.0 | 515.6 |
| Node 接收端 CPU ms | 297 | 125 | 78 | 125 |
| 最大单响应解压 JSON 字节 | 70,029 | 698,023 | 3,489,025 | 17,505,749 |
| D1 结果序列化累计字节 | 23,213,791 | 23,169,132 | 23,147,532 | 23,163,175 |

A 的首响应是清单，B/C 才是实体正文，不能把上表当作“首个实体可用时间”的直接比较。D 的首个实际网络数据块较晚，本地结果没有证明流式首屏更快。性能 runner 先收完整 gzip 再解压；它不是浏览器增量消费基准。另一个功能脚本确实增量解压并在首页后断开，用于验证续传，未把它的时间混入上表。

CPU 是从本实验拥有的两个 `workerd.exe` 进程读到的累计 CPU 增量，包含 D1/runtime/压缩，并且 Windows 有计时粒度；**不是云端计费的 isolate CPU**。原始文件中的 private memory 是整个进程的前后快照，不是 JS heap、单 isolate 或峰值，不能用它认证 128 MB 内存上限。

## 夹具与正确性

25k 输入的实体 payload 原始字节为 **14,139,948**；10k 为 **5,668,698**。`padding_bytes = 0`，没有重复 `x` 填充。每事件都有 thread/turn/response/observation、日期、项目、模型、effort、来源设备及十进制 token 字符串；每条使用独有的确定性 SHA-256 observation id 和 128 bit response id，thread 含中文标题。常见结构字段、日期、模型自然重复；不能将这一压缩率外推到所有真实 payload。

两台设备交错产生事件。近期只覆盖部分 thread，但 recent 按生产合同包含这些 thread 的旧事件，并补齐递归父 thread。25k full 为 25,250 实体；device / recent 各为 12,626 实体、12,500 事件。10k full 为 10,250 实体；device / recent 各为 5,126 实体。额外插入旧版本、墓碑和未来版本，固定 cut 不得串入它们。

12 个最终样本均逐实体检查真实 SHA-256、唯一键、数量、完整排序 JSON 等值；25k 全量指纹为 `bedb2bad983da45e96e255686f8ea125c91ea3877226e25f49d08c43f154b904`，精确 token 总和为字符串 `225179981368525025000`。单事件 token 高于 JS 安全整数，未转换为浮点数求和。

`server-check.mjs` 最终实际通过：

- 匿名访问 401；错误浏览器协议版本的 page / stream 均 426 `VERSION_MISMATCH`。
- 另一有效 synthetic 用户 cookie 访问前一用户的 page / stream lease 均 409 `BASELINE_REQUIRED`。
- lease 建立后将 head 提升，仍返回原 cut 的 10,250 实体，不含未来版本或墓碑。
- 5,000 条请求设置 65,536 字节上限，实际提前结束为 92 实体 / 64,169 JSON 字节；前缀逐字段一致，next_cursor 有效。过小预算显式 413。
- gzip 增量 reader 收到首个 1,000 实体块后主动断开，用其 next_cursor 重新请求，续回 9,250 实体；拼接后完整 hash 与参考一致，无重复或漏项。
- 已过期 lease 返回 409；首块后模拟 deletion_version 改变，只交付 1,000 实体，流以 `failed` 结束而不发 `complete`，后续 page 同样 409。

旧 `results.json` 保留了 10k/25k × full/device/recent × 四方案 × 三轮，共 72 样本，全部数量、范围、精度和 hash 检查通过。**这批早期候选尚未接 versionGate，所以时间只作为历史原型记录，不用于最终公平加速率。** 最终补齐门禁后重测了 25k full；没有重新给 device/recent 发布性能比较结果。对应范围 SQL 未因门禁补齐而改动。

## 原型如何有界

实体页执行两次数据 SQL：先查询有界 key/revision/hash 和 `length(payload AS BLOB)` 元数据，在字节预算内选连续 key 前缀，再只读这些 key 的 payload。两个 SQL 都复用生产 `readScope`、固定版本和实体范围谓词，前后读 lease，再延长到既有 max expiry 内。这样避免先取 5,000 个任意大小正文再截断。分页数量和序列化字节同时有上限。

连续流重复上述每页流程，发送完整 entity/hash/cut/scope 和 next_cursor；结束前再验证 lease。只有终结记录才表明传输完备，客户端仍需验证数量、hash、当前用户/删除代次和 CAS 后才能提升 coverage。错误流的 HTTP 状态可能已经是 200，必须识别 `failed` 或缺失终结记录，不能只看 HTTP 成功。

续传证明逻辑游标与内容一致；断开时服务端可能已经提前处理部分后续块，本次没有证明网络断开能立即取消全部 D1 工作。此流也未集成生产浏览器的 staging / coverage 提升，不能据此宣称完整恢复流程可发布。

1 MiB 的默认页面无法容纳所有合法的大实体，本原型明确 413。生产方案需要给单个大实体调整预算或回退到现有 entities 路径，不能截断或跳过。4 MiB 只是响应字节上限，JSON 字符串、解析对象、metadata、压缩和并发都会额外占用内存；上线前仍需做真实 isolate 内存与并发预算验证。

## 平台与选型边界

Workers 每个 isolate 的内存限制为 128 MB，多个并发请求共享该内存；流式处理可以避免缓冲整个大响应，但不会自动保证 SQL 结果、JSON 解析和压缩的内存用量安全。平台 CPU 与等待时间分开计量，HTTP Paid 默认 30 秒 CPU、最高可配置 300 秒，Free 为 10 ms；本地进程 CPU 无法证明这些限制下是否通过。[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)

D1 单个数据库依次执行查询，单次 invocation 的 D1 查询额度为 Paid 1,000、Free 50；单行/string/BLOB 最大 2,000,000 字节，绑定参数最多 100，查询最长 30 秒。参数通过一个 JSON 集合传递，未依赖超额绑定。[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

最终 D 流的一个 25k 请求执行 135 条 SQL，**不适用于 Free 的 50 次限额**。原型每调用最多 30 个数据块后给 continuation，完整门禁下最多约 155 SQL，仍以 Paid 为边界。若支持 Free，应进一步限制为例如 8 个块并保留额度余量，同时另验 CPU；不能把跨多个 HTTP 的 SQL 总数误认作每请求额度。

本实验显式使用 `CompressionStream('gzip')` 和 `encodeBody:'manual'`；生产传输可能按客户端协商其他压缩，因此字节对比只适用于这里的 gzip 条件。[Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)、[Response](https://developers.cloudflare.com/workers/runtime-apis/response/)

推荐下一阶段以 **1,000 条 + 字节上限的内联页**作为易恢复的初始接入候选，再按首块延迟和内存预算决定是否提升到 5,000 条。5,000 页在本地总耗时最佳，但首个正文开始较晚；连续流增加结束记录、取消和调用预算复杂度，这组数据没有证明它优于大页。高延迟网络下少请求可能另有收益，需要真实同源云端浏览器复测，不能用模拟 RTT代替。

这是冷缓存选择。已有完整镜像时，manifest 可以按 hash 跳过正文，现有 changes 本来就内联实体与删除；应优先复用增量与同 cut 快速结束，不能无条件改成每次重新下载全部内联快照。设备或 recent 范围仍须计算正确的范围变化，不能直接套全用户增量。

预先生成私有不可变压缩快照 + 增量尾部可能进一步让多个浏览器复用 D1 枚举结果，但涉及生成、存储、鉴权、删除和回收；本轮未实现或测量 R2。未证明任意压缩偏移都能续传实体，实际应使用独立压缩块和固定版本清单。

## 复现和交付

基线是当前未提交工作树，HEAD `f25aaf9dcdb4ad31232bb78b2ab5876b95949390`。Node `v24.16.0`、锁定 Wrangler `4.130.0`、compatibility_date `2026-09-10` + `nodejs_compat`，使用本地 D1 同时应用 0001 和 0002，没有升级依赖。关键源码 SHA-256 记录在 `artifacts/sync-fast-path-20260913/server/source-fingerprint.json`。

在仓库根目录，终端一运行并保留前台进程：

```powershell
node experiments/sync-fast-path-20260913/server-launch.mjs
```

等 `http://127.0.0.1:18913/experiment/ping` 返回成功，终端二执行最终矩阵：

```powershell
$env:SERVER_COUNTS='25000'
$env:SERVER_SCOPES='full'
$env:SERVER_ROUNDS='3'
$env:SERVER_LABEL='parity-final'
node experiments/sync-fast-path-20260913/server-run.mjs
node experiments/sync-fast-path-20260913/server-summary.mjs parity-final
node experiments/sync-fast-path-20260913/server-check.mjs
node cloud/node_modules/typescript/bin/tsc --noEmit --project experiments/sync-fast-path-20260913/server-tsconfig.json
```

全部通过。`parity-final.json/.log` 为原始公平结果，`parity-final-summary.json` 为中位汇总，`checks.json/.log` 为逐项功能结果，`typecheck.log` 为类型校验。旧 `results.json/.log` 与 `smoke.json/.log` 保留用于追溯；不可将其候选时间当作完整门禁结果。`source-fingerprint.json` 对应最终候选源码。所有 artifacts 在被忽略目录中。

服务入口仅允许 loopback 指定 origin，配置没有生产绑定。结束时按启动记录核实 Wrangler PID 的命令行及全部子进程，确认 18913 的 listener 属于该树后停止；`cleanup.json` 记录最终零监听。没有保留后台实验服务，没有部署、远程数据写入、commit 或 push。
