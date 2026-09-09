# Agent 查询入口

[返回总体统筹](README.md)

工作项：AGENT-01。状态以总览为准；具体复选框和完成证据在本文件维护。

## 目标与当前基础

让 Agent 通过 CLI/API/Skill 稳定回答用量问题，保留来源、范围和数据质量信息。

以下为 2026-09-09 本地源码和文档核查基线，实施时复核可能变化的行为；历史验收不代表本轮已验证。

| 方向 | 当前仓库证据 | 后续工作 |
| --- | --- | --- |
| Agent 入口 | 已有 [Skill](../../skills/codex-usage/SKILL.md)、[安装指南](../../docs/INSTALL_FOR_AGENTS.md)、CLI、OpenAPI | 验证自然语言需求能否正确触发并完成查询，保持版本一致 |

## 范围与依赖

依赖 [POS-01](discoverability.md)；远程 Agent 查询范围与 [REMOTE-01](remote-access.md) 协调。

共同目标、数据边界和阶段安排见[总体统筹](README.md)。

## 待办与验收

### AGENT-01：查询契约与使用场景

- [ ] 对照 [server/cli.ts](../../server/cli.ts)、[server/app.ts](../../server/app.ts)、[shared/contracts.ts](../../shared/contracts.ts) 和 Skill，检查命令、参数、分页、错误与版本说明。
- [ ] 补齐团队自身/后代/合计、跨任务轮次、期间变化和低缓存任务的可执行示例。
- [ ] 使用合成数据走通“确认来源与新鲜度 → 查询 → 保留范围、时区和缺失说明”的流程。
- [ ] 远程初版是否开放 Agent 查询单独定义；保留本地 CLI 默认行为，不为手机 Web 需求自动放开 CODEX_USAGE_URL。

#### 验收标准

同一筛选下 Web、CLI、API 的数值与范围一致；大整数、未知值、账户身份与陈旧状态不丢失；Skill 不绕过服务直接读原始会话。

## 待决策问题

远程首版是否开放 Agent 查询；本地默认行为保持明确。

## 完成记录

尚无完成记录。完成时记录工作项编号、实现文件或 PR、验证日期、实际结果及剩余限制，再勾选对应任务并更新总览状态。
