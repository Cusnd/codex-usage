# 完全在线浏览器改造：镜像移除依赖审计

2026-09-13。用户已批准云端浏览器完全在线，不再维护实体镜像或持久离线缓存。本文件根据正在修改的实时工作树作依赖清单；只读审计，没有删除文件或修改生产源码、测试、`modules.json`、配置及数据库。审计中已看到 `modules/contracts/read-lease.ts` 新增 `PageRead`，以下旧消费者是实施时必须迁移的路径，不代表主任务尚未开始改动。

主任务已确定落点：新在线数据源在 `modules/web/adapters/cloud.ts`，通用 `jsonRequest`/`RequestError` 在 `modules/web/adapters/http.ts`，项目名称工具迁至同一 adapters 目录并移除 `labelsFromEntities`。旧 `modules/sync/browser` 整块迁出生产，历史材料保存到 `experiments/legacy-browser-mirror-20260913`。下文的“可保留最小 transport”是审计阶段替代选项，实际按这个已选落点执行。

## 浏览器文件的精确保留/移除边界

| 文件 | 建议 | 必须保留或迁出的内容 |
| --- | --- | --- |
| `modules/sync/browser/data-source.ts` | 以 online data source 替换实现，路径可沿用 | `UsageDataSource` 接口、固定 page cut、参数/时区规范化、精确 DTO、账户与 usage 分域、刷新失效代次、GET 合并和独立取消、项目名称 HTTP 获取、bounded lease recovery；去掉 `OfflineCacheMiss`、所有持久 query/account/entity cache、`entity()` |
| `modules/sync/browser/transport.ts` | 删除实体复制类/协议，保留或迁出通用 HTTP | **本机** `modules/web/adapters/local.ts:2` 依赖 `jsonRequest`；其 `/api/*` 查询/修改都使用它。`SyncError`/业务 error.code、版本头校验、VERSION_MISMATCH 事件和 same-origin 凭据不能因删 `HttpSyncTransport` 一起消失 |
| `modules/sync/browser/project-labels.ts` | 保留纯项目名称工具，移除实体镜像转换 | `ProjectLabelView`、`namesFromProjects`、`referencedProjectIds` 仍可用；`labelsFromEntities` 只为实体缓存回退服务，可退役；不要丢 alias cycle-safe 和 source→logical name 映射 |
| `modules/sync/browser/controller.ts` | 旧实体复制实现可整体退役；新 page-read controller 可用新文件或替换内容 | 旧文件还转导出 `jsonRequest`/`SyncError`/transport/`entityHash`；先迁移直接消费者与测试导入。不能为保留 HTTP 再保留整个旧 controller |
| `modules/sync/browser/cache.ts` | 退役 | 其 re-export 会牵入 Memory 和 IndexedDB 实现 |
| `modules/sync/browser/cache-model.ts` | 退役镜像/IDB模型 | `namespaceOf` 的 origin+user+排序去重 device IDs 逻辑、`sameCut` 可提取到新的 online 模型；`queryLeaseOf` 依赖 active/baseline，不能直接当新的 PageRead 模型使用 |
| `modules/sync/browser/cache-memory.ts` | 退役 | 不是 online 页面 React Query 内存缓存；它仍实现完整镜像/staging/持久缓存接口，不应改名后继续使用 |
| `modules/sync/browser/cache-indexeddb.ts` | 退役 | 可以单独保留一次性的旧数据库清理迁移，不能继续为统计或账户查询读写 IDB |
| `modules/sync/browser/verify.ts` | 实体 hash/manifest 校验退役；若新 page-read 需要，提取纯值检查 | `validCut`、未来 `verifyPageRead` 有必要；`verifyLease` 要求 total_entities/expected_entities，与轻量 PageRead 不匹配。`entityHash`/`verifyEntities` 只需历史 fixture 或服务端自身校验，不能为了旧实验保持生产镜像依赖 |

没有名为 `integrity.ts` 的当前浏览器文件；实体完整性实现在 `verify.ts`、`controller.ts` 和 cache finalization 中。

通用 HTTP 的两个现有实现不能直接互换：`sync/browser/transport.ts:24` 的 `jsonRequest` 抛 `SyncError(message, code, status)`；`modules/web/adapters/cloud-http.ts` 当前业务失败只附 `status`，并对 `/me`/`compatibility` 有例外，还单独标记 `CLOUD_NETWORK_ERROR`。如果合并，需同时保留这些业务差异，尤其 `BASELINE_REQUIRED` 恢复依赖 code。本机接口不应被强制要求云同步响应头。

## 直接消费者和页面适配

| 消费者 | 旧依赖 | online 改造要求 |
| --- | --- | --- |
| `modules/web/data/cloud-provider.tsx` | 创建 IDB、CloudSyncController；state phase、自动/手动镜像、重连继续初始化 | 替换成 online page read 生命周期；按用户和设备范围取消旧请求/更换状态；刷新只取得新 page cut 并使查询失效，无 manifest/entities/changes；保留账户独立间隔与用量间隔为0语义 |
| `modules/web/adapters/local.ts` | `transport.jsonRequest` | 明确迁出通用 HTTP 或保留最小 transport；本机数据源功能不能受影响 |
| `modules/web/features/devices/CloudSyncStatus.tsx` | phase、baseline count、received/applied、coverage | 删除镜像进度 UI 或替换成在线读取状态；不能显示“正在补齐”“完整历史缓存”或“离线已保存页面” |
| `modules/web/shell/App.tsx:224` | `CloudSyncStatus` | 更新 import/挂载与新在线状态保持一致 |
| `modules/web/features/projects/CloudProjects.tsx:19` | `sync.state.activeLease.cut.organization_version` | 使用当前 PageRead 的 organization_version，继续固定管理操作的 base version；不能因删除 activeLease 不再刷新项目名 |
| `modules/web/features/projects/CloudOrigins.tsx:19` | `sync.source.controller.identity` | 用新 online source/provider identity；保留全设备管理 lease、归属操作幂等性/ACK 丢失恢复与刷新调用 |
| `modules/web/features/devices/DeviceSettings.tsx:31` | `sync.invalidateHistory()` | 删除成功后取消/清空当前用户全部相关内存查询、使旧 PageRead 失效；不能因为没有 IDB 就省略晚到 HTTP 响应的代次校验 |
| `modules/web/features/devices/queries.ts` | `sync.online` | 保留在线 gating，决定断网错误/暂停行为；不再回退历史 IDB |
| `modules/web/features/projects/CloudProjects.tsx`、`CloudOrigins.tsx` | `sync.refresh`、`sync.online` | 可以保留 provider 接口名降低修改量，实义改为页面读取刷新，无完整镜像副作用 |
| `modules/web/shell/cloud-gate.tsx:74` | logout 调 `source.controller.invalidateForDeletion()` | 取消/丢弃用户级在线 source 和 QueryClient，并清理旧 cache 迁移；不要留下已删除 controller 访问 |
| `modules/web/data/data-query.ts`、`modules/contracts/data-source.ts` | capture/revision/clock/QueryView | 继续保留整页固定 cut、稳定 rolling clock 和时区；QueryView.lease 改为轻量 PageRead 或相容抽象，不再要求实体镜像统计 |

无需为“完全在线”删除本机离线功能、本机 SQLite、采集器持久待发/ACK、云端持久历史；这些都不是浏览器实体镜像。

当前持久浏览器状态的额外检查：

- `cloud-gate.tsx:16`/`:24` 的 `codex-usage:last-cloud-user:v3` localStorage 用于离线 identity 回退，应随取消离线访问调整，不再据旧 identity 展示持久页面。
- `CloudOrigins.tsx:14`/`:35`/`:53` 的 sessionStorage 保存已确认操作的不可变 operation ID 和线程选择，用于 ACK 丢失恢复，**不是统计离线缓存**。不要为了删除 offline cache 顺手删除业务幂等恢复；若要完全不保存任何 sessionStorage，应另实现可恢复的在线操作查询。
- 旧数据库命名为 `codex-usage-cloud-${SYNC_VERSION}`。代码不再引用并不等于旧数据已从用户浏览器消失。建议独立迁移只清理本应用已知版本/前缀数据库和离线 identity key；禁止全域删除其他应用 IDB/localStorage。清理阻塞时要处理旧标签页连接，且新页面不能回退读取旧数据。

## 测试：哪些失效，哪些语义必须改写保留

### 整份实体镜像测试退出现行产品门槛

- `tests/web-cloud-prefetch.test.ts`：全部 5 项是 manifest 预取、内容失败、持久进度和镜像删除竞态，作为历史方案归档；新在线 source 的 abort/deletion 测试另写。
- `tests/web-cloud-cache.browser.ts`：全部真实 IDB 镜像/查询/account cache 检查归档。新的 CUA 应验证统计请求零 manifest/entities/changes、无新业务 IDB 写入、断网明确不可读取、刷新与换用户/设备晚到请求隔离；不能把旧11项仍通过当新方案验收。

### 混合文件不能整份丢弃语义

`tests/web-cloud-sync.test.ts` 中，以下是旧镜像/持久缓存模型专有，可归档：

- 近期/全量同cut、hash复用、manifest/body断点（原65–97行）；完整commit/delta/staging/CAS（100–170行）。
- 缓存DTO旧算法排除及离线重开（172–205行）的持久实现；所有跨标签 IDB 删除和snapshot回填测试（217–231行）。
- account reload/跨scope IDB持久、stale marker、原子持久账户写入（252–297行）；实体项目名回退与中间 delta 隔离（340–355、370–379行）。

以下测试目标必须用新 online source 改写保留：

- 系统/手动时区、查询键与固定显示时钟（52、60行）。
- 同一页相同 cut、错 cut 拒绝、删除/换用户/刷新后晚到 HTTP 响应不得替换新视图（172、209、243、278、299行）。持久写入断言改为内存响应代次/会话隔离。
- 账户忽略用量 device filter、不标 usage cut，账户更新独立于 usage lease（233、299、312行）；改成在线重取而非“重开仍离线保留”。
- settings mutation response normalization 和 bounded lease recovery（321、328行）。
- namesFromProjects、referencedProjectIds、alias cycle-safe、source ID 映射、固定 page lease 的标签响应校验（357、381行）。
- 保留 origin/user/device namespace 规范化规则，但它不再依赖 `cache-model`（334行）。

`tests/cloud-experience-browser.test.ts`：旧1–4项冷baseline/持久离线/删除重开及最后entity并发测试退役；共享renew、共享恢复、changed-cut拒绝、删除期间恢复、共享GET独立取消/最后订阅取消（83–150行）仍是 online source 必须有的回归。新用例应明确无任何 baseline 镜像下载或持久读写。

### 其他测试/fixture

- `tests/cloud-display.test.ts:52` 的“browser sync completion follows workspace timezone”使用 `full_ready` fixture，替换成在线状态或删除该镜像文案用例；其余 rename/device/account 内容和时区测试保留。
- `tests/fixtures/cloud-display-components.tsx` 显式 import/render `CloudSyncStatus`；`tests/fixtures/cloud-display-hooks.ts` 提供 `useCloudSync` mock，需对齐新 state shape。`cloud-display.test.ts:16` 的 esbuild拦截也按组件名称匹配。
- `tests/cloud-gate.test.ts` 保留身份/版本拒绝、过期响应竞态和bootstrap测试。与离线继续浏览绑定的断言按用户批准的新行为调整，不能移除权限与协议门控。
- `tests/refresh-ui.test.ts`、`tests/web-runtime.test.ts`、`tests/cloud-navigation.test.ts`、项目/归属操作相关测试仍有效，重点回归新 provider 接口与本机 jsonRequest。

## scripts / experiments / 类型检查和历史证据

以下入口直接引用旧 browser 模块：

| 入口 | 动作建议 |
| --- | --- |
| `scripts/cloud-experience-browser.ts` + `scripts/cloud-experience-browser-fixture.ts` | 旧镜像组件计时归档；不要让新线上测试再import旧fixture |
| `scripts/browser-cache-performance.ts` | 归档旧IDB性能基准 |
| `scripts/browser-performance-server.ts:18` | 启动时无条件bundle前述cache性能和`tests/web-cloud-cache.browser.ts`；即便只看非缓存页面也会因删文件失败。移除/显式legacy模式化这两个bundle入口及`/__cache*`路由，保留其他页面性能用途 |
| `scripts/cloud-gate-browser-worker.ts:23` | 本地`/api/test/cache-checks`只适合历史构建；新online CUA无需它，保留历史文件时注明使用已冻结产物 |
| `experiments/sync-fast-path-20260913/browser-import.ts`、`browser-shadow.ts`、`run-browser-import.mjs` | 完整镜像实验归档，保留数据/报告/已构建JS。shadow仍import生产verify；生产verify删除后如需复现，必须使用冻结验证实现，不改成少校验来让实验继续跑 |
| `experiments/cloud-request-analysis-20260913/analyze.mjs:64` | 运行时读取固定旧源码清单/hash，旧文件删除后会失败；保留已有request-analysis.json，复现用明确历史source snapshot，或把新online版本作为新场景另写分析 |
| `cloud/test/run-read-benchmark.mjs` 及read compare/reporter | 包含旧createRead/manifest/entities基准；服务端保留旧接口时可以继续回归，精简这些接口时归档旧分项而保留devices/query真实性能测试 |

类型/测试包含规则必须同时处理：

1. 根 `tsconfig.json` **包含整个 tests 目录**，不只是 `*.test.ts`；把旧测试改名为 `.legacy.ts` 仍会进入检查。移动到 `experiments/.../legacy/` 或明确exclude，并断开任何现行测试的import。
2. TypeScript 的 exclude 不会阻止被现行文件 import 的依赖；`tests/cloud-experience-browser.test.ts` 当前还会牵入 `scripts/cloud-experience-browser-fixture.ts`。仅从 modules.json 删除测试名不够。
3. `npm test` 是 `tsx --test tests/*.test.ts`，应让现行测试文件只包含新合同；保留旧tests于tests根目录会继续运行。不要全局禁用tests目录。
4. `cloud/tsconfig.json` 包含整个 `cloud/test`，旧服务端测试若import已删除manifest等，即使Vitest配置不运行也仍可能类型失败。
5. `tooling/check-architecture.mjs` 枚举所有 `apps/` 和 `modules/` 的TS，不只入口可达图；失效旧代码留在这些目录会造成unresolved/public/ownership失败。历史源码应去production树以外，或保存为明确不可执行源码快照；不能仅指望tree-shaking。
6. 历史原始记录不可被新online输出覆盖。已有 CUA JS产物、source hashes和before/after结果继续是旧镜像方案证据；需要可执行历史复现时保存依赖闭包，不能让archive继续依赖当前已改变的PageRead类型。

## modules.json 建议（主任务统一修改）

按已选 adapters 落点，应移除 `sync/browser` 模块条目，以及 `web/adapters`/`web/data` 对它的依赖；`web/adapters` 新增 `analytics` 依赖用于 `USAGE_QUERY_REVISION`，已有 contracts/foundation 保留。public 列实际跨模块使用的 `cloud.ts`、`http.ts`、现有 `local.ts`/`cloud-http.ts`；`project-labels.ts` 若只供同模块内部使用无需额外公开。新 online tests映射到 web/adapters 与 web/data，旧prefetch映射从两处移除。没有生产代码后，architecture 对sync/browser的硬编码framework检查可作为同步清理，不是新增架构豁免。

以下保留此前通用建议，供检查遗漏；涉及保留sync/browser的分支已被上述决定替代：

- `sync/browser`（当前596行）：若online source仍放该目录，可保留模块ID和browser runtime，删除 `cache.ts`/旧`controller.ts` public；public换成实际 online data-source/page-read/最小HTTP入口。没有真实调用需求不必公开全部内部helper。依赖 contracts/foundation/analytics 仍合理（DTO、参数、query revision）。
- `sync/browser.tests`：移除旧`web-cloud-prefetch.test.ts`映射，混合两个测试文件映射指向新online回归文件；不要将纯legacy tests继续列为现行验证。
- `web/data.tests`（当前708行）**也映射** `tests/web-cloud-prefetch.test.ts`，需一起替换，不是只改sync/browser那处。
- `web/adapters` 当前依赖sync/browser仅因local jsonRequest。若最小HTTP仍在sync/browser，则保留该依赖；若迁到新的低层platform/browser模块，则更新两者依赖和public。
- 不要让sync/browser为了HTTP反过来import `web/adapters/cloud-http`，同时web/adapters仍importsync/browser；这会构成architecture的模块环。可保留最小transport、注入HTTP实现，或建立低层HTTP模块。
- `web/features/devices` 所属模块public目前列有 `CloudSyncStatus.tsx`（804行）；组件删除或改名需同步public。其render fixture/test映射也应对齐。
- `sync/reads` 保留服务器读取模块，public `snapshots.ts`可维持兼容re-export或重命名，但analytics/organization/app依赖必须同时迁移。不要因用户取消浏览器镜像直接删整个模块。

## 归档最小闭包与具体路径

按要复现的历史证据，生产旧文件的最小闭包如下：

1. **只复现 25k current/shadow 及 10k IDB性能**：`cache.ts`、`cache-model.ts`、`cache-memory.ts`、`cache-indexeddb.ts`、`verify.ts`、`transport.ts`，共6个。即使IDB基准不使用Memory，原cache barrel会解析两种实现；verify用cache里的entityKey和transport的SyncError。
2. **另保留旧manifest预取或11项IDB CUA源码**：在上述6个基础上加`controller.ts`，共7个。旧IDB测试从controller转导出entityHash。
3. **保留旧RTT数据源实验、混合web-cloud-sync测试**：再加`data-source.ts`与`project-labels.ts`，共9个。建议9个全部归档，以免历史项目名称、账户和失效恢复证据失去可复现源码。

推荐目录（这里仅给清单，不移动文件）：

```text
experiments/legacy-browser-mirror-20260913/
  browser/               # 原9个 modules/sync/browser 文件
  contracts/             # 冻结旧 QueryView / UsageDataSource / ReadLease 形状
  tests/                 # 旧镜像 tests + web-cloud-cache.browser.ts
  scripts/               # cloud-experience-browser{,-fixture}.ts, browser-cache-performance.ts
  README.md              # 旧方案、基准范围、来源指纹、独立复现命令
```

这个layout中，`browser/*.ts` 的内部 `./cache.js`/`./transport.js` 原样保留；到仍活跃公共模块的路径例如：

- 原 `../../contracts/sync.js` → `../../../modules/contracts/sync.js`。
- 原 `../../foundation/query-parameters.js` → `../../../modules/foundation/query-parameters.js`。
- 原 `../../analytics/revision.js` → `../../../modules/analytics/revision.js`（若要求旧query-key精确复现，应冻结原常量`token-usd-v1`）。
- 旧 `../../contracts/data-source.js` → `../contracts/data-source.js`；旧ReadLease类似转archive contracts。**不能让旧data-source实现继续类型依赖新PageRead的QueryView**。
- archive `tests/*.ts` 到原browser imports改为`../browser/...`，其fixture helper改为`../scripts/cloud-experience-browser-fixture.js`；archive `scripts`到browser也为`../browser/...`。
- 若保留 `experiments/sync-fast-path-20260913/browser-{import,shadow}.ts` 的原位置，旧cache/verify导入改为`../legacy-browser-mirror-20260913/browser/...`。它们原`SyncEntity`仍为服务器有效合同，可以保留到当前modules/contracts的type-only导入。
- `scripts/browser-performance-server.ts` 的legacy cache bundle entry需改为archive paths或显式可选；单纯迁走旧tests/scripts却不改这个无条件esbuild循环，会破坏其他页面性能fixture的启动。

最小可运行闭包可以复用当前稳定公共函数，但必须在README明确这一点；严格冻结历史环境还应保存当时 `stableJson`、`sync-version`/`cloud-version`及生成的build-version、query revision，并用当时锁文件/产物指纹对齐。旧ReadLease/QueryView与真实校验代码必须保持原语义；不能用`any`、空verify或删hash检查来规避新合同导致的类型错误。

归档若仍有独立TypeScript检查，旧contracts/data-source.ts里ApiResponse可指向当前`modules/contracts/responses.ts`的type，旧ReadLease的Settings可指向`modules/contracts/settings.ts`，避免复制整个`contracts/index.ts`的全部re-export闭包。如果未来这些结构也改变，再补齐归档的旧最小类型定义。归档不进入根tsconfig/npm test/modules.json的现行产品验证；旧可执行测试通过只能说明旧算法，不计作新online实现的通过数。

## 服务端安全收缩边界

| 服务端内容 | 是否仍是在线/上传必要依赖 | 安全处理 |
| --- | --- | --- |
| `reads/leases.ts` 的固定read创建、getRead、assertDeviceScope、有效期/删除检查 | 是 | 查询、项目组织、归属预览/操作、settings 都需要。改成轻量 PageRead 可去掉新page-read路径的manifest count/coverage成本，但保留固定cut和所有有效性检查 |
| `reads/model.ts` 的lease字段、leaseCut、MINUTE | 是 | 可以拆掉旧mirror专有类型；完整SyncCut不能只剩commit_seq |
| `v3_read_leases`、`v3_entity_versions`、domain active epoch/commit/deletion/organization/config version | 是 | `analytics/worker/executor.ts` SQL直接读版本表/lease；publication与rebuild继续产生有效版本。删除会破坏统计与原子发布 |
| `reads/cleanup.ts` | 是 | cron调用；清理过期leases和旧版本时保护active leases与正在构建epoch，不能全删 |
| `reads/baseline.ts` manifest/entities和对应GET/POST路由 | 当前浏览器镜像专用，上传不消费 | 可以在明确不支持旧镜像客户端之后退役；先迁移cloud tests及旧benchmark。保留接口也不意味着新browser应调用 |
| `reads/changes.ts`及`/api/v3/sync/changes` | 当前是浏览器镜像下行消费者，上传不调用 | 可单独退役下行API；不能自动连带删除publication写日志、cleanup和commit表 |
| `v3_changes`表和`publication/store.ts:133` INSERT | 正式在线查询不读取；但当前每次发布仍写 | 后续单独优化可停止冗余日志写入并调整测试/保留策略；不是删一个路由就自动消失的成本，本轮不要直接DROP表 |
| `v3_commits`和`changes_floor` | publication、cleanup、rebuild仍使用 | 当前publication写commit元数据，cleanup按7天commit时间算floor后保护版本。要精简需设计独立的版本GC水位；不能随changes消费者消失一起删 |
| `reads/scope.ts` | 当前createRead count及manifest/entities使用；analytics有自己的queryScope | 若所有page-read创建切新轻量函数且旧baseline退役，scope的recent/父线程闭包可缩；仍存在createRead老fallback时不能直接删除 |
| `/api/v3/sync/status` GET | 浏览器mirror可以不再轮询 | 实际route还在ctx.waitUntil推进后台jobs；在线PageRead创建/计划任务是否承担进度需检查，不能意外丢掉触发器 |
| `/api/v3/sync/status` PUT、ingest/receipts、publication/jobs | 上传和业务应用必要 | 与GET下行同名前缀不同用途，必须保留；云端已保留历史、重建、删除和跨来源去重不受本次浏览器选择影响 |

具体仍调用 `createRead/getRead` 的生产入口：

- `modules/analytics/worker/queries.ts:17`–`:18`（缺lease时fallback新read、固定settings）；`executor.ts:23`、`:26` 前后校验。
- `modules/organization/worker/projects.ts:127`–`:130`（按lease cut取project版本）。
- `modules/organization/worker/origins.ts:52`、`:57`、`:71`（分页读取和明确操作校验）。
- `apps/cloud/routes.ts:81`（settings GET）；`:64`（renew）。
- `apps/cloud/index.ts:126`（scheduled cleanupVersions）。

服务端测试也应按语义分开：`v3-query-scale.test.ts`、`performance-analytics-current.test.ts`、`v3-projects.test.ts`、`v3-billing.test.ts`、`version-gate.test.ts`继续验证在线统计/组织/计价/权限，read fixture可换新PageRead；`v3.test.ts`是上传/发布/恢复/删除/lease/下行混合文件，不能整份归档。`v3-read-projections.test.ts`保留getRead的用户/删除/过期隔离与固定cut，退役仅manifest并发删除/镜像counts项目；`v3-read-performance.test.ts`拆出仍有效的devices/query分项和历史mirror分项。

## 必须保留的新合同验收

新页面从冷状态和旧IDB存在状态打开，都只发送页面读取与统计请求，无实体manifest/entities/changes；不读取旧统计IDB。旧IDB清理单独可验证。相同页查询同cut，刷新后全部采用新cut，换设备/用户/时区及删除/失效恢复时拒绝晚到响应。账户不受usage设备筛选约束，本机适配器正常工作。断网不从历史持久缓存显示统计，版本/身份明确拒绝关闭当前用户内容。云端上传历史和后台应用/重建/删除继续保持原合同。

这些是现行online实现的回归目标；旧镜像性能指标、11项IndexedDB测试和shadow/Blob原型保留为方案选择证据，不再作为新产品必须完成的工作。
