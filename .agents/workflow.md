# 项目工作流

本文是本项目分支、提交、集成和发布流程的统一说明。正常流程为：

```text
明确发布指令 → 准备版本并上传 → 启动云端任务 → CI → develop → main → 标签 → npm → 同步 develop
```

自动发布由 `.github/workflows/release.yml` 统一编排，复用 `windows.yml` 的平台检查和 `publish.yml` 的 npm 发布。普通提交和 PR 合并不启动自动发布；手动推送版本标签仍可启动 npm 发布。

## 分支

日常任务从最新的 `develop` 创建 `codex/<任务名>` 分支，同一目标的后续修改继续使用原分支，例如 `codex/fix-usage-count`。

默认在当前工作目录使用任务分支；只有用户明确需要并发任务时，才为并发任务启用独立 worktree。

### 阶段预览

`preview` 是长期保留的阶段成果分支，对应当前线上 `https://quota.esoren.com`（Worker `codex-usage-cloud` 和现有 D1）。首次从现有开发成果保存快照；后续只纳入用户本次要求预览的成果。日常功能任务仍使用 `codex/<任务名>`，正式集成和 npm 发布仍走下文的 develop/main 流程。

用户明确说“更新预览”，即授权保存本次阶段源码快照、提交并推送到 `preview`、部署现有云端并进行有界线上检查。普通 push 不自动部署。不要为预览创建目标为 develop/main 的 PR、运行完整 CI、创建版本标签或发布 npm；这些动作需各自的任务指令。

预览步骤：确认纳入范围和当前工作树 → 保存源码快照并推送 `origin/preview` → `npm run cloud:preview` → 核对线上版本、健康接口和 CUA 页面 → 记录来源提交、Worker 版本、迁移与验证边界。未提交的实验、原始数据和凭据不纳入阶段源码快照。部署命令要求当前分支为 `preview`，部署输入已提交，且远端 preview 与本地提交一致。

预览跳过 GitHub CI 平台矩阵和完整测试套件，保留部署所需的类型检查、前端构建、Worker dry-run、包边界检查和线上 smoke。构建准备可用 `npm run cloud:preview -- --prepare-only`，不会执行远端迁移或部署。首次 v2→v3 上线使用 `npm run cloud:preview -- --backend-first`，先部署兼容后端再切换页面。增量 D1 迁移保留现有数据；回退 Worker 不会撤销数据库迁移，须选择兼容版本。

现有工作流仅在目标为 develop/main 的 PR、手动运行或版本标签时启动。保持 `preview` 的 push/PR 不触发完整 CI，不使用全局禁用 Actions 或提交信息的 skip 标记。

## Commit

按有意义的变化创建提交，标题使用：

```text
type(scope): description
```

`scope` 可省略。说明使用英文，具体描述本次变化；复杂修改可在正文补充原因和影响。

| 类型 | 用途 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 问题修复 |
| `refactor` | 代码结构调整 |
| `docs` | 文档 |
| `test` | 测试 |
| `build` | 构建和打包 |
| `ci` | CI/CD |
| `chore` | 其他维护 |

示例：

```text
feat(analysis): add date range filtering
fix(importer): avoid counting replayed responses twice
docs: explain the release workflow
ci: publish npm packages on version tags
```

版本准备沿用 `release: prepare X.Y.Z`，例如 `release: prepare 0.1.4`。

## 集成

任务 PR 指向 `develop`。跟进 CI 和反馈，完成后使用 squash merge；最终提交说明概括整个任务的变化。

准备发布时创建 `develop → main` 的发布 PR，汇总本次版本内容，使用 merge commit 合并。

### CI 去重

平台检查只由 PR（目标为 develop/main）或手动运行触发，合并及分支同步的 push 不重复触发。每个 PR 先读取实际检出提交的 Git tree；最近 50 次成功运行中，如有同一仓库、同一工作流对完全相同文件树完成全部 30 组检查（Windows x64、macOS x64/arm64、Linux x64/arm64，各 6 个 Node 版本），则复用该结果，否则运行矩阵。旧 18 项记录不能代替新的 30 项验收。手动运行始终执行完整矩阵。

成功矩阵后才生成 `Validated tree <tree>` 任务记录。复用时同时核对原运行成功、文件树记录成功及全部 30 个任务成功，跳过矩阵的运行不能充当新的验收记录。统一结果任务为 `Compatibility result`。文件树包括源码、锁文件、测试和工作流；任一文件变化都会使旧结果不匹配。API 失败会使检查失败，不按通过处理。

发布标签只核对上述已有验收，不再调用完整矩阵。没有匹配记录时停止发布；先在选定发布提交上手动运行平台检查，通过后重跑发布工作流。首次启用此流程也需要生成一份新格式的成功记录。不要因提交 SHA 随 squash/merge 改变而重跑相同文件树；也不要在目标分支产生新合并内容时直接沿用旧 PR 的结果。

构建已包含 TypeScript 检查，CI 不再单独运行 `npm run check`。生产 smoke、安装生命周期 smoke，以及发布 job 对实际上传归档的验收均保留。

## 版本与发布

### 发布授权与完成条件

用户要求发布，即确认当前 develop 可发布，并授权完成本次发布闭环：必要的 bug/CI 修复及相应验证、版本准备、集成到 main、标签、npm 发布、分支同步和收尾。常规修复或所需补丁版本号不单独触发再次审批；只有超出本次目标的实质变化（例如新增产品范围、费用或破坏性迁移）才重新讨论。用户明确限定版本或禁止某项操作时遵守该限制。

对修改后的内容执行相关验证；完全相同的已验收内容复用 CI。发布工作流验收正式归档后上传同一份包，registry 查询确认版本可用、渠道正确且 integrity 与上传归档一致，即判定发布完成。扫描期间可在现有有界等待窗口内查询，成功后停止。

发布完成后直接报告结果并收尾，不默认下载 npm 包重跑完整安装/生命周期测试，不与早期本地候选逐文件比较，也不把换行或构建格式差异变成新的验收门槛。仅当出现具体异常（如正式归档与上传记录不一致、安装失败）时，针对异常调查。发布记录只保留版本、来源提交、工作流和结果所需信息；历史调查记录不是后续版本必须重复执行的清单。

准备版本时更新 `package.json`、锁文件和发布说明，将这些修改随发布 PR 合并到 `main`。随后在选定的 `main` 提交上创建并推送附注版本标签，由发布工作流验证该版本、打包并发布 npm。

Git 标签定位源码提交；npm 包版本对应 `package.json` 的 `version`；npm dist-tag 表示安装渠道。

| Git 标签 | npm 包版本 | npm 渠道或用途 |
| --- | --- | --- |
| `v0.1.4` | `0.1.4` | `latest`，正式版 |
| `v0.2.0-alpha.1` | `0.2.0-alpha.1` | `alpha`，预览版 |
| `v0.2.0-beta.1` | `0.2.0-beta.1` | `beta`，测试版 |
| `v0.2.0-rc.1` | `0.2.0-rc.1` | `next`，候选发布版 |
| `milestone/macos-support` | — | 定位里程碑，不发布 |
| `baseline/before-importer-rewrite` | — | 定位代码基线，不发布 |

发布工作流按版本后缀选择 npm 渠道。`v*` 会同时匹配正式版本和预发布版本，不能仅靠这个触发条件区分渠道。

### 自动发布

用户说“自动发布”即授权本次发布。启动前准备版本号、锁文件和发布说明；未指定版本时，普通修复默认递增 patch。推送任务分支并创建指向 develop 的 PR，然后在 main 上调用统一入口：

```powershell
gh workflow run release.yml --ref main -f version=0.1.7 -f branch=codex/release-0.1.7 -f source_sha=<完整40位提交SHA>
```

版本号与分支仅为示例，替换为本次已上传内容。入口需要先随代码集成到 main；新入口的首次安装不需要发版。确认对应运行已进入执行状态后，回复“已开始自动发布”并附运行链接。

云端依次完成：校验来源与版本 → 复用或运行精确文件树 CI → 任务 PR squash merge 到 develop → 发布 PR merge commit 合入 main → 创建附注标签 → 显式启动并等待 npm 发布和 registry 验证 → 同步 develop。手动 CI 的 revision 参数用于固定实际合并候选提交。

整个流程只依赖 GitHub 云端。CI 未通过时不执行相关合并；工作流摘要和 cloud-release artifact 记录阶段、来源、PR、CI 及发布结果。普通运行不逐步播报，完成或失败时说明结果和相关链接。

重新运行相同输入即可复用已合并 PR、标签及成功发布记录。npm 子任务失败时先查看并恢复该任务，再重跑主任务。发布成功后的分支同步失败仅表示收尾未完成。

入口使用仓库 GITHUB_TOKEN 的 contents、pull-requests 和 actions 写权限，npm 继续使用现有 OIDC 绑定，无需新增长期 token。GitHub 仓库需允许 Actions 创建 PR。

## npm 自动发布配置

在 npm 包 `@esoren/codex-usage` 的 Settings → Trusted publishing 中选择 GitHub Actions，填写用户 `Cusnd`、仓库 `codex-usage`、工作流文件名 `publish.yml`，Environment 留空，并允许直接 `npm publish`。不需要配置长期 `NPM_TOKEN`。

发布 job 使用 Windows、Node 24、npm 11 和 OIDC。它在标签对应提交上验证版本及 main 归属，核对相同文件树的成功平台检查记录，构建并打包，通过 `CODEX_USAGE_TEST_TARBALL` 验收同一份包后发布。结果摘要记录版本、渠道和 integrity；发布命令报错时也会查询 npm，只有内容和渠道完全一致才报告已验证。

npm 接收上传后可能还需等待发布扫描完成。工作流会每 30 秒核对 registry，最多等待 20 分钟；发布 job 的总时限为 35 分钟。上传前会记录完整 integrity，便于等待超时后核对已有版本。暂时的 404 不能直接证明上传失败。

正式验证认证和远端发布，需要一次明确发版。更新工作流或配置绑定不会自行发布。

## 收尾与紧急修复

发布后将 `main` 合回 `develop`，按需清理已完成任务的分支与 worktree。

紧急修复从 `main` 创建任务分支，完成后通过 PR 合入 `main`，按版本标签流程发布，再将修复同步回 `develop`。
