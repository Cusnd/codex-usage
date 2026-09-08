# Sub2API 数据来源与 Windows 迁移参考

检查日期：2026-09-08。仓库：`Wei-Shaw/sub2api`。固定提交：`dbe92a1c241a03c77e2b218761369ff988b8356b`。方法：GitHub 页面与浅克隆源码只读检查；没有运行第三方程序、读取用户凭据或请求用户账户。以下描述是该提交的实现证据，不代表上游接口有长期兼容保证。

## 结论

Sub2API 不依赖本机 Codex CLI 来读取账户额度，它自己管理账户、OAuth token、HTTP 查询和网关日志。因此能避开 Windows npm shim、CLI 安装目录与 app-server 版本问题。但是它的历史 token 统计主要属于自身网关账本；当前账户额度属于上游快照。两者不能替代本项目 `account/usage/read` 的账户 lifetime、daily buckets 和 streak。

## 三种数据渠道

| 渠道 | 具体实现 | 数据范围与限制 |
| --- | --- | --- |
| 网关响应正文 / SSE | `parseSSEUsageBytesWithType`、`openAIUsageFromGJSON` 从 `usage` 提取 input/output/cache token；`OpenAIGatewayService.RecordUsage` 计算价格并写 usage log | 经过该网关的请求；不会自动发现其他电脑直接向 OpenAI 发出的历史请求。金额包含自身定价和倍率，不能当 OpenAI 实际账单 |
| 上游响应头 | `ParseCodexRateLimitHeaders` 读取 `x-codex-primary/secondary-used-percent`、window minutes、reset-after；`buildCodexUsageExtraUpdates` 存账户 Extra | 账户额度窗口快照，不是逐日 token。通过原有转发请求获得时无需新增模型请求 |
| 主动 GET 查询 | `OpenAIQuotaService.QueryUsage` 调用 `https://chatgpt.com/backend-api/wham/usage` | 返回账户 / plan、primary / secondary windows、additional feature limits、reset credits；typed payload 没有 lifetime tokens、streak、daily token series |

源码证据：

- [SSE usage 合并策略与解析](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/openai_gateway_response_handling.go#L1196-L1235)：终态有 token 的 usage 整体作为权威值；终态全零不会清除早先非零观测。
- [兼容 input_tokens / prompt_tokens 等字段](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/openai_gateway_response_handling.go#L1484-L1545)。
- [RecordUsage 计费入口](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/openai_gateway_usage.go#L154-L194)、[usage log 写入](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/openai_gateway_usage.go#L480-L514)。
- [响应头解析和快照标准化](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/openai_gateway_usage.go#L953-L1113)。
- [wham endpoint 与 typed payload](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/openai_quota_service.go#L25-L92)、[QueryUsage GET 实现](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/openai_quota_service.go#L143-L214)。

## 不应忽略的主动探针

管理员路由也必须区分：`GET /api/v1/admin/openai/accounts/:id/quota` → `QueryQuota` → `QueryUsage` 使用 wham GET；`POST /api/v1/admin/openai/accounts/:id/quota/refresh` → `RefreshQuota` 同样查询 wham，并持久化 reset-credit 快照。通用 `GET /api/v1/admin/accounts/:id/usage` 属于 Account usage 服务，其普通 OpenAI 账户分支才是下述响应头 probe；两类“刷新”不是同一路径。

- [管理员 QueryQuota / RefreshQuota](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/handler/admin/openai_oauth_handler.go#L473-L523)
- [路由注册](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/server/routes/admin.go#L452-L454)

普通账户 `getOpenAIUsage` 先使用账户 Extra 缓存；需要刷新时调用 `probeOpenAICodexSnapshot`。这个函数会 POST `https://chatgpt.com/backend-api/codex/responses`，使用 `codex-auto-review` 模型构建测试 payload，然后提取响应头。它不是纯只读的 usage GET；即使目标只是拿响应头，仍然发送了模型请求，不能无条件照搬到只读统计器。Spark shadow 账户走 wham 的 additional limits 分支。

- [getOpenAIUsage：缓存、探针与自有日志窗口统计并列](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/account_usage_service.go#L711-L775)
- [探针创建与发送请求](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/account_usage_service.go#L831-L945)
- [探针模型常量](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/pkg/openai/constants.go#L50-L51)
- [Codex responses URL](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/openai_gateway_service.go#L31)

## 鉴权和迁移成本

`prepareUpstreamCall` 从已保存的账户记录取 `chatgpt_account_id`，兼容旧 `organization_id`；缺少 ID 时要求重新授权。普通 OAuth 账户通过 `OpenAITokenProvider.GetAccessToken` 获取有效 token，复用刷新与锁机制。请求带 Bearer token 和 `chatgpt-account-id`，还设置 Codex identity headers。服务支持账户代理，并使用 privacy HTTP client；这些都是它自己承担的集成维护成本。

- [账户选择、ID 校验、token provider 和代理](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/openai_quota_service.go#L404-L474)
- [HTTP headers](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/openai_quota_service.go#L563-L581)
- [Token provider 入口](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/backend/internal/service/openai_token_provider.go#L134)

发布配置用 Go 静态构建（`CGO_ENABLED=0`），包含 Windows amd64、Linux 与 macOS；明确排除 Windows arm64，Windows 包使用 ZIP。这支持其打包可迁移性，不能据此断言所有 Windows 架构均已验证。README 仍要求 PostgreSQL 15+ 与 Redis 7+，不属于复制单个程序即无需环境依赖的工具。

- [发布矩阵与 Windows ZIP](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/.goreleaser.yaml#L9-L41)
- [数据库与 Redis 前置条件](https://github.com/Wei-Shaw/sub2api/blob/dbe92a1c241a03c77e2b218761369ff988b8356b/README.md#L225-L230)

## 对本项目的具体借鉴

1. 将 `server/account.ts` 的 quota 与 detailed usage 分离成独立能力和错误状态。额度成功不应被历史接口不支持拖成整体失败。
2. 可评估 HTTP quota adapter 来降低 CLI 安装发现依赖；但必须先设计授权、token 获取/刷新与账户绑定。只复制 URL 并不足以完成迁移。直接 HTTP 也将上游变更维护责任转给本项目。
3. quota 缺失窗口用 null，保存来源和 fetchedAt，显示最后成功快照；当前窗口百分比不换算为“历史 token 总量”。
4. `account/usage/read` 的 lifetime、streak、dailyUsageBuckets 仍需现有支持的数据源；Sub2API 的这条 wham 实现不能作为等价替代。网关日志也不能补齐未经过网关的请求。
5. 不为统计功能新增模型探针、不引入重置额度消费；研究中这两类操作未执行。

本轮仅新增研究文档，未修改产品实现。
