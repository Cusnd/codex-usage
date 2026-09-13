# 已退役的浏览器实体镜像与离线缓存

2026-09-13 用户批准云端浏览器改为完全在线，不再建立实体镜像或持久离线缓存。本目录归档此前的实现、专项测试和性能夹具，供解释历史结果及独立复现。**不属于现行产品，不得重新接入生产入口，也不计入新在线方案的测试通过数。**

## 保存范围和迁移验证

- `browser/`：原 `modules/sync/browser/` 全部9个文件，包括控制器、数据源、HTTP复制协议、4个缓存文件、实体校验和项目名称工具。
- `tests/`：原 `web-cloud-sync.test.ts`、`web-cloud-prefetch.test.ts`、`cloud-experience-browser.test.ts`、`web-cloud-cache.browser.ts`。前三个共51项Node专项，最后一个是历史11项真实IndexedDB浏览器检查。旧混合文件也含时区/固定cut/账号隔离测试，新产品需要自己的在线合同回归，不是沿用其持久缓存要求。
- `scripts/`：原 `cloud-experience-browser.ts`、`cloud-experience-browser-fixture.ts`、`browser-cache-performance.ts`。
- `contracts/`：冻结旧 `QueryView`、`UsageDataSource`、镜像 `ReadLease` 形状，避免当前 `PageRead` 改造改变历史实现的类型合同。
- `copy-verification.json`：16个来源文件逐项复制时的SHA-256完全相同记录。
- `relocation-verification.json`：修改导入后各归档文件SHA-256、删除前原文件仍未变化的复核及原路径移除状态。所有目标和原路径均在当前workspace内。

先逐文件复制并核对，再调整相对导入，独立类型检查和测试通过后才移除原文件。没有更改历史raw结果。一次计算路径批量删除命令被自动审批拒绝；改为单独只读复核并列出16个绝对文件路径，使用PowerShell原生 `Remove-Item -LiteralPath` 完成，没有递归删除或跨shell路径传递。

归档调整仅涉及路径/冻结接口，另外给原RTT脚本的nullable `view()`结果加了真实非空断言，并把重跑输出移至独立目录避免覆盖旧证据。原有hash、count、连续commit、覆盖提升、删除与取消校验未减弱，没有用`any`跳过新旧合同不兼容。

## 独立验证

从仓库根目录执行：

```powershell
npx tsc -p experiments/legacy-browser-mirror-20260913/tsconfig.json
node --import tsx --test experiments/legacy-browser-mirror-20260913/tests/web-cloud-sync.test.ts experiments/legacy-browser-mirror-20260913/tests/web-cloud-prefetch.test.ts experiments/legacy-browser-mirror-20260913/tests/cloud-experience-browser.test.ts
```

归档时这两项通过：strict TypeScript无错误，51项旧合同测试全部通过。日志分别为 `typecheck.log` 和 `legacy-tests.log`。`verification/browser-bundles/` 与 `bundle-check.log` 记录三个浏览器入口的构建检查；构建成功不是新的CUA或新的性能测量。

旧基准单独重跑：

```powershell
node --import tsx experiments/legacy-browser-mirror-20260913/scripts/cloud-experience-browser.ts replay
```

该命令写入 `artifacts/legacy-browser-mirror-20260913/browser/replay.json`。其`before`参数不会自动切换到旧优化前源码；这里归档的是9月12日优化后、完全在线改造前的版本。

25k接收端的入口仍为 `experiments/sync-fast-path-20260913/run-browser-import.mjs`，但原runner会写回历史artifacts路径；重新计时时应先把runner的evidence输出改到新的目录或在独立副本运行，不能覆盖已有raw记录。本次只构建验证，没有重新运行计时。`browser-import.ts`和`browser-shadow.ts`已改为导入本归档的cache/verify；浏览器验收仍使用CUA。该实验没有网络或服务端snapshot生成成本，不能据此宣称线上完整同步耗时。

`scripts/browser-performance-server.ts`原有的两个镜像bundle入口已指向本目录，其他性能路径保持。该服务使用者若只测新在线页面，不应把旧 `__cache` / `__cache-checks` 结果计作新产品验收。

## 可复现边界

这是冻结旧浏览器逻辑和接口的**源码归档**，不是独立复制全部仓库和依赖的发行包。仍引用仓库公共 `SyncCut`/`SyncEntity`、DTO/Settings类型、`stableJson`、queryParameters、同步版本校验及query revision。`shared-dependencies.json`记录归档时这些文件的指纹；严格对照历史结果时，应使用对应锁文件和公共依赖版本。不要将共享hash实现的未来变化默默用于重测旧方案。

历史原始结果仍在原位置：

- `artifacts/cloud-experience/browser/`：固定80ms dispatcher的before/after与专项结果。
- `artifacts/cloud-experience/gate/`：当时真实Workerd/D1/IndexedDB的CUA证据。
- `artifacts/sync-fast-path-20260913/browser-shadow-comparison.json`：25k实体current/shadow的三对AB/BA/AB。中位导入10,810.7 → 5,485.9 ms，shadow提升448.1 ms含physical count与seal；不是仅指针写入时间。
- `experiments/sync-fast-path-20260913/REPORT.md`、`browser-design.md`：原方案比较、数据口径与用户后续选型背景。

shadow仅是独立临时IDB实验，未实现delta overlay、GC、跨标签删除/reset和生产迁移。完整镜像和shadow/Blob方向保留为历史探索；用户已选择完全在线，不能据归档存在重新要求浏览器完成镜像。

`experiments/cloud-request-analysis-20260913/analyze.mjs`的旧sourceFiles清单包含已移除的生产路径，它不是现行生产检查。已有request-analysis.json原样保留；如要重跑，应明确使用本归档/当时源码快照并将输出写成新实验，不能覆盖历史指纹。
