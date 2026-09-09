# 项目工作流

本文是本项目分支、提交、集成和发布流程的统一说明。正常流程为：

```text
codex/<任务名> → develop → main → 推送版本标签 → 发布工作流 → npm
```

以下是项目约定。标签发布由 `.github/workflows/publish.yml` 执行，复用 `windows.yml` 的平台检查。工作流需先进入 GitHub，npm Trusted Publisher 也需完成绑定，之后推送版本标签才会自动发布。

## 分支

日常任务从最新的 `develop` 创建 `codex/<任务名>` 分支，同一目标的后续修改继续使用原分支，例如 `codex/fix-usage-count`。

默认在当前工作目录使用任务分支；只有用户明确需要并发任务时，才为并发任务启用独立 worktree。

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

## 版本与发布

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

### 简短示例

以下以 `0.1.4` 为例，实际执行时替换为本次版本。

在版本准备任务中更新版本，随后按正常提交和 PR 流程进入 `develop`，再进入 `main`：

```powershell
npm version 0.1.4 --no-git-tag-version
# 更新发布说明，并将版本修改与锁文件一并提交。
# 提交标题：release: prepare 0.1.4
```

发布 PR 合并后，获取并查看准备发布的 `main` 提交：

```powershell
git switch main
git pull --ff-only origin main
git log -1 --oneline
node -p "require('./package.json').version"
```

当前提交为选定的发布提交时，创建并推送标签：

```powershell
git tag -a v0.1.4 -m "Release 0.1.4"
git push origin v0.1.4
```

只在本地创建标签不会触发远端发布。标签推送后，跟进发布工作流和 npm 上的版本、渠道结果。

## npm 自动发布配置

在 npm 包 `@esoren/codex-usage` 的 Settings → Trusted publishing 中选择 GitHub Actions，填写用户 `Cusnd`、仓库 `codex-usage`、工作流文件名 `publish.yml`，Environment 留空，并允许直接 `npm publish`。不需要配置长期 `NPM_TOKEN`。

发布 job 使用 Windows、Node 24、npm 11 和 OIDC。它在标签对应提交上验证版本及 main 归属，等待平台检查，构建并打包，通过 `CODEX_USAGE_TEST_TARBALL` 验收同一份包后发布。结果摘要记录版本、渠道和 integrity；发布命令报错时也会查询 npm，只有内容和渠道完全一致才报告已验证。

正式验证认证和远端发布，需要一次明确发版。更新工作流或配置绑定不会自行发布。

## 收尾与紧急修复

发布后将 `main` 合回 `develop`，按需清理已完成任务的分支与 worktree。

紧急修复从 `main` 创建任务分支，完成后通过 PR 合入 `main`，按版本标签流程发布，再将修复同步回 `develop`。
