# 云端身份与兼容性门控优化

本轮相对于 2026-09-12 第一轮性能优化后的工作树建立独立基线。此报告只覆盖门控；实体同步、查询和真实生产页面时序由其他报告覆盖。没有部署。

## 基线与决定

原始 `CloudGate` 等 `/api/v3/me` 返回后才挂载 `CloudVersionGate`，后者再发 `/api/v3/compatibility`。即使 HTTP 缓存和 IndexedDB 均已就绪，第一次显示内容仍要顺序等待两个往返。原逻辑还要求 `!version.error`：已通过兼容核对的页面断网后，15 秒轮询报错就会卸载整个 `CloudSyncProvider` 和页面树。TanStack Query 实际保留了之前的兼容数据，但渲染条件不再允许展示。

本轮没有直接并发两个身份未绑定的请求。服务端提供 `GET /api/v3/me?bootstrap=1`，在同一次 `sessionUser` 认证内查询该用户的兼容状态并返回 `{ user, compatibility }`。普通 `/me` 响应保持原合同。前端把这份同响应的数据及 `me.dataUpdatedAt` 用作兼容查询的 `initialData` / `initialDataUpdatedAt`；15 秒内不重复发初始兼容请求，后续轮询、窗口聚焦和恢复连接仍会重新核对。旧服务器缺少 `compatibility` 字段时，回退到原来的独立兼容请求。

## 已实施的同会话容错

`CloudVersionSession` 仅存在于当前挂载的用户组件，不写入 localStorage、IndexedDB 或共享查询许可。换用户由 `key={user.id}` 创建新实例；新的离线文档没有兼容许可时仍需先通过验证。

已成功验证的会话遇到明确的 fetch 传输失败、HTTP 408 / 429 / 5xx 时继续保留页面树，并显示核对暂时失败的提示。`cloudRequest` 只标记 fetch 阶段的传输错误，JSON 解析和程序 TypeError 不作为离线错误放行。

401、403、其他非暂态错误、未知错误以及不兼容响应立即取消许可。取消后再发生离线错误，也不能从旧 Query 数据恢复许可。真实 `cloud-version-mismatch` 事件立即关闭门控、取消之前的检查，再发新检查；检查使用代次和序号，事件之前发出的旧响应不能重新打开界面。撤销设备仍通过真实 DELETE 接口并等待新的兼容核对。

这项变化保持了客户端已验证内容的短时离线使用；它没有承诺在无法联系服务器时获知服务器上刚刚发生的撤销。收到明确的拒绝或不兼容信号时立即关闭，联网恢复后重新核对。

## 独立测量

### QueryObserver 门控模型

使用实际 TanStack QueryObserver、合成请求延迟 `/me = 40 ms` 与 `/compatibility = 60 ms`，7 轮。轮询错误用手工 `refetch` 触发，与生产 15 秒轮询执行相同操作，但没有将 15 秒等待伪装成实际耗时。

| 指标 | 原逻辑 | 容错候选 |
| --- | ---: | ---: |
| 顺序查询就绪中位数 | 107.66 ms | 108.00 ms |
| 已通过后，暂态失败仍保留内容许可 | 0 / 7 | 7 / 7 |
| 暂态失败后 Query 仍保留旧兼容数据 | 7 / 7 | 7 / 7 |

这个模型刻意保持两个顺序请求，用来隔离容错状态变化；没有从其中宣称首屏加速，也没有把许可判断当成真实 DOM 挂载证据。

### 真实本地 Workerd / D1 门控 HTTP

同一合成用户完成真实 72K tokens 上传后，比较普通 `/me` → `/compatibility` 与 `/me?bootstrap=1`。本地 fixture 对上述每个 HTTP 请求固定增加 **120 ms**，7 对 AB / BA 交替采样：

| 指标 | 原串行路径 | bootstrap |
| --- | ---: | ---: |
| HTTP 请求数 | 2 | 1 |
| 全部门控数据返回中位数 | 278.61 ms | 139.87 ms |
| 相对变化 | — | −49.80% |

这是受控延迟场景中的实际 HTTP 测量，并非真实生产 RTT、浏览器 FCP/LCP、INP 或用户体验百分位。浏览器最终构建验收和生产测量由主任务通过 CUA 单独进行。

## 验证与复现

8 项 Node 回归覆盖新用户/新文档隔离、成功 bootstrap、初次失败、网络/5xx 容错、401/403 后旧数据不复活、版本不符、旧请求竞态、fresh bootstrap 不重复请求、旧服务器回退，以及 query string 不误触发版本头断言。类型与架构检查通过。完整集成测试由主任务执行。

```powershell
node --import tsx --test tests/cloud-gate.test.ts
node --import tsx scripts/benchmark-cloud-gate.ts after
node --import tsx scripts/benchmark-cloud-bootstrap.ts http://127.0.0.1:18789
```

`scripts/cloud-gate-browser-worker.ts` 是本地专用入口，拒绝非 localhost / 127.0.0.1 主机。它复用原有真实 Workerd / D1 浏览器 fixture；生产仍部署 `apps/cloud/index.ts`。控制页可以创建合成用户、同步匹配版本、真实上报旧协议、删除合成用户的登录 session、模拟兼容接口 503，以及模拟旧服务器不提供 bootstrap。

CUA 本地入口：

- before：`http://127.0.0.1:18788/api/test/gate`，使用第一轮保留的 `after-final/cloud` 前端。
- after：`http://127.0.0.1:18789/api/test/gate`，使用本轮 `artifacts/cloud-experience/after` 构建。
- 各自点“创建新合成用户”→“同步匹配版本”→“打开云端面板”。两套 D1 状态目录隔离。

如需重启：

```powershell
node cloud/node_modules/wrangler/bin/wrangler.js dev --local --config artifacts/cloud-experience/gate/before.wrangler.jsonc --port 18788 --persist-to artifacts/cloud-experience/gate/before-state
node cloud/node_modules/wrangler/bin/wrangler.js dev --local --config artifacts/cloud-experience/gate/after.wrangler.jsonc --port 18789 --persist-to artifacts/cloud-experience/gate/after-state
```

before 前端仍调用未改变的普通 `/me`，因此可以与候选共享当前服务端代码路径进行门控比较；服务端修改前源码另有快照。同步控制器源码冻结后已重建最终 after：`index-Dfn7gbQe.js`，938,842 bytes。`candidate-build-final.json` 记录所有文件的 SHA-256。最终构建只用于最终功能回归；主任务较早取得的浏览器计时须引用各自实际采样的构建，不移植为最终构建的测量结果。

控制页另有“实体下载延迟 2 秒”，只延迟合成用户的实体下载请求，便于 CUA 验证图表先显示、缓存仍未完成。真实 IndexedDB 回归入口为 `http://127.0.0.1:18789/api/test/cache-checks`，包含原 9 项与新增 2 项冷查询/删除竞态检查；其 JS 仅在本地 fixture artifact 中单独编译，生产入口不引用。

## 证据索引

- `artifacts/cloud-experience/gate/cloud-gate.before.tsx`：修改前门控源文件，SHA-256 `49859f2956610afbcb3dc56c9e38175bbe03a7db82f8d016d0a3c87d859c3d21`。
- `artifacts/cloud-experience/gate/cloud-index.before.ts`：本轮 bootstrap 前的服务端入口源码。
- `artifacts/performance-current/browser/after-final/cloud/`：本轮 before 前端，保持第一轮构建原样。
- `artifacts/cloud-experience/gate/before.json` 与 `after.json`：7 轮 QueryObserver 原始记录、源文件指纹与方法。
- `artifacts/cloud-experience/gate/bootstrap-http.json`：真实 Workerd 7 对 HTTP 原始记录。
- `artifacts/cloud-experience/gate/gate-tests.log`：8 项最终门控回归通过记录。
- `artifacts/cloud-experience/gate/candidate-build-final.json`：最终本地候选与独立 IndexedDB harness 的产物指纹。
- `artifacts/cloud-experience/gate/{before,after}.wrangler.jsonc`：本地配置；对应 `*-state` 是合成数据、日志和状态文件。
- `artifacts/cloud-experience/gate/processes.json`：任务启动的 fixture 父进程；主任务完成 CUA 后统一清理并记录。

合成身份 cookie 仅在 benchmark 进程内使用，没有写入报告或测量文件。所有测试服务只在本地运行，未修改生产状态。

## 最终 CUA 验收与清理

主任务已完成最终构建的真实 CUA 回归：IndexedDB **11/11** 通过；协议 **3.1.1 拒绝、3.1.2 恢复**及删除真实登录 session 后 **401 关闭内容**均通过。最终构建断网后仍保留 **72K tokens** 内容。实体请求增加 2 秒的冷场景中，summary 在 **673.1 ms** 返回，chart 在 **729.6 ms** 出现、stats 在 **735.7 ms** 就绪，首个 entity 响应在 **2697.2 ms**，确认内容显示无需等待实体下载完成。该场景是固定延迟的本地功能证据，不替代生产性能数据。

最终浏览器证据见 `artifacts/cloud-experience/gate/final-*.txt/json`，完整方法与边界见 [本轮云端体验总报告](cloud-experience-2026-09-12.md)。主任务已关闭本任务浏览器页并恢复网络模拟；本子任务已停止两个 fixture 进程树，18788 / 18789 无监听，记录为 `artifacts/cloud-experience/gate/cleanup.json`。
