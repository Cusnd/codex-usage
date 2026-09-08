# New API 数据获取与迁移性源码调查

检查日期：2026-09-08。仓库：QuantumNous/new-api。固定提交：`71c1fd7caad738db4d13aabbf28eeadb293d0cfe`。仅检查公开源码，未读取本机凭据、请求账户接口或运行该项目。以下是源码证据，不能当作本次对接口可用性或另一台 Windows 的实测。

## 两条独立数据链路

1. **网关请求账本**：Codex 适配器将响应交给 OpenAI Responses 处理器；非流式响应提取 `response.usage`，流式读取响应事件的 usage 并合并。缺少上游 token 数时，存在输出 token 计算与输入 token 估计的回退。随后结算服务调用 `RecordConsumeLog`，把 prompt/completion tokens、模型、渠道、用时等写入自己的数据库。它统计的是经过此网关的请求，不会自动获得该 ChatGPT 账户在其他客户端的完整历史。
   - [Codex Adaptor.DoResponse](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/relay/channel/codex/adaptor.go#L116-L130)
   - [OaiResponsesHandler / OaiResponsesStreamHandler](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/relay/channel/openai/relay_responses.go#L21-L161)
   - [消费日志写入调用](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/service/text_quota.go#L526-L540)，[RecordConsumeLog](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/model/log.go#L339-L390)

2. **Codex 订阅账户当前额度**：`FetchCodexWhamUsage` 直接 GET `${baseURL}/backend-api/wham/usage`，默认 Codex baseURL 为 `https://chatgpt.com`。请求使用 `Authorization: Bearer <access_token>`、`chatgpt-account-id`、`Accept: application/json`、`originator: codex_cli_rs`。不启动 Codex CLI，不依赖 npm 安装路径。前端读取主/次窗口百分比、重置时刻、窗口长度、附加限额等。
   - [FetchCodexWhamUsage](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/service/codex_wham_usage.go#L15-L54)，[请求头](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/service/codex_wham_usage.go#L150-L157)
   - [默认地址](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/constant/channel.go#L124)
   - [前端 payload 类型](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/web/src/features/channels/components/dialogs/codex-usage-dialog.tsx#L87-L147)

## 凭据、刷新、失败处理

`fetchCodexChannelWhamData` 从渠道数据库的 `Key` 字段解析 OAuth JSON，明确要求 access_token 与 account_id；它没有因为额度响应缺少 accountId 就失去身份依据，因为身份本来来自渠道凭据。请求支持渠道级代理和 15 秒超时。遇到 401/403 且有 refresh_token 时，调用 OAuth 刷新，保存新 token 到渠道数据库，并重试一次；响应保留 `upstream_status`。

- [渠道凭据、超时、刷新与重试](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/controller/codex_usage.go#L53-L189)
- [OAuthKey 格式](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/relay/channel/codex/oauth_key.go#L9-L30)
- [OAuth 刷新 HTTP 实现](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/service/codex_oauth.go#L16-L93)

在已检索的 Codex 相关 controller/service/relay 路径中，没有找到 `account/usage/read`、`dailyUsageBuckets` 或 `lifetimeTokens` 的实现。因此此路径证明的是“当前额度可直接 HTTP 获取”，没有证明本项目账户级每日 token 历史可以由同一接口替代。缺失功能的结论限定于本次源码检索范围。

## 可迁移性从哪里来

- 账户读取只依赖配置凭据和 HTTP，摆脱本项目当前 `codexCommand()` 的 Windows 安装路径发现与子进程入口问题，但同时让应用自己承担凭据保存、刷新、账户绑定与后端接口变化。
- Windows release workflow 在 windows-latest 构建前端和 Go 后端并输出 `.exe`；Go 使用 embed 包含前端静态资源，因此终端用户无需自己安装前端构建工具。
- 这份源码存在 Windows 构建流水线，不表示本次核验过最新 Windows 安装包或其 CI 成功状态。
- [Windows 构建流程](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/.github/workflows/release.yml#L119-L166)，[前端嵌入](https://github.com/QuantumNous/new-api/blob/71c1fd7caad738db4d13aabbf28eeadb293d0cfe/main.go#L43-L47)

## 对 codex_detailed_usage 的建议

最值得借鉴的是把数据源拆开：本机 JSONL token 统计、账户额度、账户历史，各自报告可用性和最后成功时间。当前 `server/account.ts` 把额度和历史耦合在一次 read 中，历史接口失败会令本来成功的额度一起不可用。

可以设计独立 `AccountLimitsProvider` 接口，先保留 app-server 实现，再评估可选的直接 HTTP 实现。HTTP 路径能消除 CLI 安装依赖，但不能在不改变现有“应用不接触凭据”边界的情况下直接替换；需要明确凭据来源和刷新归属。不要把网关消费日志误标成全账户历史，也不要把额度百分比换算成 token 总量。

该仓库为 AGPL-3.0；借鉴接口分层与错误处理思路可独立实现，若复制具体代码，应另外核对许可证义务。
