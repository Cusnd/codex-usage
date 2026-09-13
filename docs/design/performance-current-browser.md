# 浏览器性能基线与实施结果

本轮把本地和示例入口的分析、任务和设置代码移出首页静态依赖，并单独拆出分析页使用的 `MotionBar`。总览仍同步加载并立即发起原有查询；图表算法、动画参数、查询键和数据合同没有改变。云端通过入口注入 `eagerPages`，仍一次性加载全部路由，保留已有页面实例首次离线进入其他路由的能力。

基线是保留的 HEAD `f25aaf9` 生产构建。最终证据在 `artifacts/performance-current/browser/after-final`，中途的 `after` 只是“仅拆路由”的候选，最终结论不使用该候选的浏览器时间。所有构建都执行了原有 Vite 数据边界校验，没有部署远端服务。

## 可确认的收益

以下为最终磁盘文件大小；gzip 使用 Node `gzipSync`。最初 `generateBundle` 钩子会早于 Vite 的预加载映射注入，因此采集脚本已改为在构建完成后重读磁盘文件，前后报告也按保留文件统一核对。

| 入口首次静态 JS | 优化前 raw / gzip（字节） | 最终 raw / gzip（字节） | raw / gzip 变化 |
| --- | ---: | ---: | ---: |
| 本地 | 894,132 / 273,934 | 794,351 / 246,821 | −11.16% / −9.90% |
| 示例 | 898,017 / 275,910 | 797,119 / 248,136 | −11.24% / −10.07% |
| 云端 | 934,293 / 286,543 | 934,484 / 287,016 | +0.02% / +0.17% |

本地/示例入口还把 4,007 字节设置样式（gzip 1,199）延后加载，首页 CSS 从 48,952 / gzip 10,046 降为 44,946 / gzip 9,302 字节。`MotionBar` 单独拆分相对于仅拆路由额外减少约 20.4 KB 首次 JS（gzip 4.55 KB）；它复用原有 `usePlotMotion`，没有调整动画算法。

延后加载不会减少访问所有页面时的总下载量；压缩分块也会有少量额外开销。首次进入分析/设置会请求对应代码，导航悬停和键盘焦点可提前发起预取。加载中保留原有页面框架，失败时提供重新加载操作。云端这次没有首包优化收益，略增的压缩大小明确列在表中。

## 浏览器实测

操作全部由 CUA 完成，没有使用 Playwright。采用无扩展的 Codex 内置 Chromium 152，所有纳入样本的 `innerWidth/innerHeight` 都是 **1280 × 720**，汇总脚本从样本读取并断言一致。前后静态包分别由 localhost 4181 和 4183 服务，相同 30 天合成 API fixture，汇总为 119.21M Tokens、28 Sessions、92 Turns。API 响应保留到公共 fixture 目录，未查询用户真实用量。

计时窗口与其他代理的基准、测试分开。最终对照采用 A1/B1、A2/B2……的顺序，两侧均启用相同 CDP Network 观测。`shellDomMs` 是 MutationObserver 首次观察到 h1 的时刻，`chartDomMs` 是首次观察到 Recharts SVG 的时刻；它们不是绘制完成时间。FCP/LCP 来自 PerformanceObserver。

| 场景与中位数 | 原版 | 最终 | 结论 |
| --- | ---: | ---: | --- |
| 暖缓存 FCP / LCP，5 对样本 | 64 / 64 ms | 64 / 64 ms | 没有证明暖缓存加速 |
| 暖缓存图表 DOM，5 对样本 | 121.8 ms | 125.3 ms | 小幅波动，不作为收益 |
| 模拟慢网络冷下载 FCP / LCP，3 对样本 | 1,712 / 1,712 ms | 1,576 / 1,576 ms | −7.94% |
| 模拟慢网络冷下载图表 DOM，3 对样本 | 1,884.9 ms | 1,767.2 ms | −6.24% |
| 冷下载实际 JS transferSize | 274,234 B | 247,121 B | −9.89% |

冷下载条件为 **禁 HTTP 缓存、80 ms 网络延迟、上下行各 196,608 B/s（约 1.5 Mbit/s）、无 CPU 节流**。这是受控的下载场景，不代表正常本机 localhost 访问或实际线上服务速度。暖缓存没有传输 JS；暖缓存 CLS 均为 0，冷下载 CLS 均约 0.0161，各纳入样本未观察到长任务或脚本错误。小样本、单台机器和本地合成服务不足以得出线上 p95、INP 或用户体感普遍改善的结论。

最初 Chrome 试测受用户浏览器扩展悬浮图片污染 LCP，另有一个使用不支持的 `range=all` 的试测产生错误；这些 pilot 原始记录保留但不纳入任何统计。分离时间窗口的早期暖缓存结果也保留，最终表使用同条件交替样本。

## 缓存基线与语义验收

真实 IndexedDB 合成基线使用 10,000 条实体，每条带 256 字符负载：分批暂存 534.4 ms、原子提升 778.7 ms、读取 173.5 ms；200 行查询页缓存读取 7 次中位数 0.2 ms。每条实体的 ID 和全部 200 行都校验，并确认暂存区已清理。这只是当前实现的基线；本轮没有修改 IndexedDB 缓存事务、失效策略或离线查询语义，也没有把这组数字称作优化后的收益。

通过现有 `tests/web-cloud-cache.browser.ts` 在真实浏览器完成 9 项检查：原子提交、重开持久化、哈希复用与清理、失败回滚、600 条跨批次提升、并发 CAS、删除防复活、账户快照代次与跨用户隔离全部通过。

CUA 功能检查覆盖：

- 本地总览、分析、任务列表、任务详情和设置；本地合成详情保留 18.2M 当前 agent、6 Turns、48.6M 团队合计。
- 最终拆分后的柱状图正常显示 119.21M，并能切换到“每小时消耗”；截图检查布局未见缺失。
- 最终示例入口加载真实 sql.js 浏览器适配器，保持示例提示、参考日期和完整 119.21M 汇总。
- 云端使用现有 `cloud/test/browser-worker.ts`、隔离的本地 Workerd/D1、当前迁移和正式 v3 握手/上传端点。通过测试页面 UI 创建合成用户，真实上传并提交 72,000 Tokens；仅登录入口是合成夹具。
- 在一个页面实例中保存查询缓存后，另开全新页面实例，只访问总览便切换 CDP 离线。随后该新实例首次进入分析、任务列表、任务详情和设置均成功；72K、Turn 和 Agent 数据仍可见，设置中的联网管理项显示原有离线提示。云端构建图也确认 Atlas、SettingsPage、Recharts Bar 均在首次静态依赖中，没有通过预取路由掩盖首次离线代码缺失。

离线验收同时暴露一项**既有局限**：约 15 秒后 `CloudVersionGate` 的兼容性轮询失败会隐藏面板，即使已显示双方版本均为 3.1.2。当前源文件相对基线 HEAD 完全无修改，保留的原版 cloud bundle 也包含相同失败门槛；这是源码与构建复核，未另行对原版包重复这段运行时交互。本轮不修改协议安全门槛。上述首次离线路由检查在该门槛触发前一次连续 CUA 操作中完成，不声称长期离线能力已通过。

## 复现与证据

```powershell
node scripts/browser-performance-build.mjs before
# 应在改动前运行并保留目录；不要用修改后的源覆盖本轮 before。
node scripts/browser-performance-build.mjs after-final
node --import tsx scripts/browser-performance-server.ts before 4181 production
node --import tsx scripts/browser-performance-server.ts after-final 4183 production
node scripts/browser-performance-report.mjs
```

使用 CUA 打开 `/?range=30&perfRun=paired-before-1` 等样本地址。冷下载样本命名为 `cold-before-1` / `cold-after-1`；暖缓存命名为 `paired-before-1` / `paired-after-1`。汇总脚本要求完整首屏、图表、FCP、无脚本错误及一致 viewport。浏览器缓存基线入口为 `/__cache`，现有真实 IndexedDB 回归入口为 `/__cache-checks`。测量脚本只注入临时 localhost 测试服务，没有进入生产 bundle。

原始证据均相对仓库根目录：

| 文件 | 内容 |
| --- | --- |
| `artifacts/performance-current/browser/before/bundle-report.json` | 原 HEAD 三入口模块图和最终磁盘体积 |
| `artifacts/performance-current/browser/after-final/bundle-report.json` | 最终三入口模块图和体积 |
| `artifacts/performance-current/browser/before/browser-production.jsonl` | 原版浏览器原始观察，含已排除的 pilot |
| `artifacts/performance-current/browser/after-final/browser-production.jsonl` | 最终浏览器原始观察与交互记录 |
| `artifacts/performance-current/browser/browser-summary.json` | 5 对暖缓存、3 对模拟冷下载逐样本和中位数 |
| `artifacts/performance-current/browser/before/cache-performance.json` | 真实 IndexedDB 10k 基线与数据完整性结果 |
| `artifacts/performance-current/browser/browser-acceptance.json` | CUA 功能验收、离线首访与既有门槛的证据边界 |
| `artifacts/performance-current/browser/wrangler.browser.jsonc` | 隔离本地 Workerd 验收配置 |

全部浏览器网络仿真已恢复，测试创建的浏览器页与本任务服务在收尾关闭。完整根目录、云端类型与测试套件结果由主任务的综合报告记录。
