# Windows 可迁移性：参考 New API、Sub2API 与 CC Switch

核对日期：2026-09-08。此次是公开 GitHub 源码调查，未调用用户账户、读取用户登录凭据、运行上游服务或改动本项目产品代码。各仓库固定提交及逐项源码证据见配套报告。

> 实现阶段策略更新：用户选择“检测到 CLI 就使用 App Server；只有未检测到 CLI 才使用现有 OAuth HTTP 查询额度”。不再在 CLI 接口运行失败后自动切换。下文保留研究时的方案比较，最终行为以仓库 README 为准。

## 核心结论

账户额度有不依赖 Codex CLI 启动的 HTTP 获取路径。三个项目都包含 `GET https://chatgpt.com/backend-api/wham/usage` 实现，并通过 OAuth access token 与账户上下文访问。这可以减少 Windows npm 路径、shim 和子进程启动依赖，但会把凭据存储适配、失效处理及 HTTP 后端格式兼容带到应用自身。

必须区分三种数据：

| 数据 | 来源 | 本项目应采用的边界 |
|---|---|---|
| 本机任务、轮次、模型与 Token 历史 | 本地 Codex JSONL | 保留现有导入器；只覆盖保留在该设备上的记录 |
| 当前账户额度百分比和重置时间 | App Server 或 wham HTTP | 拆成独立可用能力，可增加 HTTP 适配器 |
| 账户级每日 Token、累计值、连续使用天数 | 现有 App Server account/usage/read | 保留为可选增强；本次未找到三项目中等价的替代实现 |

New API、Sub2API 的请求历史主要由经过其网关的请求产生。此类账本不能补全未经过网关的客户端活动。额度百分比也不能换算成精确 Token 数量。

## 三项目分别值得借鉴什么

- [CC Switch 调查](cc-switch-data-sources.md)：与本工具形态最接近，本地会话扫描、额度查询、代理记账分别存在；额度 HTTP 分支无需启动 Codex CLI；Windows 发布包降低目标电脑的环境要求。
- [New API 调查](new-api-data-sources.md)：明确的渠道身份、独立额度查询、401/403 刷新重试及前端内嵌分发。其 OAuth 由自身管理，不能不加区分地复制到复用用户原生 Codex 登录的只读工具。
- [Sub2API 调查](sub2api-data-sources.md)：同时使用网关 usage、限额响应头和独立 wham 查询；主动探测路径可能发起模型请求，不能把它当成本工具的只读刷新策略。

## 对现有代码的具体设计建议

现状：`server/account.ts` 的 `AccountReader.read()` 顺序查询额度、账户历史、额度，并一起返回；`server/refresh.ts` 一次提交两类快照。任一历史查询错误都会使成功读取的额度一起失效。`shared/contracts.ts` 只有一个 account 刷新状态。

建议后续实现：

1. 拆分 `localHistory`、`accountLimits`、`accountHistory` 的可用性、更新时间、错误及刷新。必要时保持 API 兼容，通过附加状态字段逐步迁移。
2. 保留 App Server 实现，优先独立修复其 Windows 入口解析；额度增加可选 HTTP 实现，在已支持的登录存储下可独立工作。最终来源顺序应由兼容性测试决定。
3. HTTP 读取必须有明确账户身份。不能只删掉现有 accountId 校验；应同时考虑用户身份与工作区归属，避免切换登录后复用错误快照。
4. 若复用原生登录，初期仅在服务端内存读取所需凭据，避免把 token 保存到统计 SQLite 或返回前端。凭据失效明确提示重新登录；不直接照搬网关的刷新并写回逻辑。
5. 对 keyring 等未实现存储显示明确状态，并可保留由 Codex 管理登录的 App Server 路径；不能宣称只读 auth.json 就覆盖所有安装方式。
6. wham 数据模型应按能力处理主窗口、次窗口、多额度桶及可选字段。CC Switch 的两窗口映射不能直接覆盖本项目所有限额结构。
7. 若额度或账户历史不可用，本地统计继续正常；缺失保留 null/不可用，不能补零或伪装成完整账户账本。
8. 分发单独推进：Windows 干净环境 CI、中文空格路径、无 Codex、不同凭据/安装方式，以及包含运行时的发行包。HTTP 改造不能替代这些验证。

## 建议的完成顺序

先拆分能力与失败状态，再实现和验证额外额度适配器，最后补分发与跨机器测试。不要为获取统计数据把本工具扩展成请求中转网关。以上为研究后的建议，尚未实施或验证新 HTTP 适配器。
