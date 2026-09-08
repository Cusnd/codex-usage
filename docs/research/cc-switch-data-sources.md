# CC Switch 数据采集与 Windows 迁移参考

核对日期：2026-09-08。只读检查 GitHub 源码；没有运行上游代码、读取用户凭据或请求用户账户。

仓库：https://github.com/farion1231/cc-switch

固定提交：`f3b18df12007d0fd79fd8ad8d310880664015197`。以下结论仅对应该快照。

## 结论

CC Switch 同时提供本地会话导入、代理请求记账、订阅额度查询和第三方供应商用量脚本。这些数据源不同，不能把其中任何一种视为账户全部历史。对本项目最直接的参考是：本地 JSONL 统计保持独立，额度可以通过 HTTP 适配器查询，从而避免依赖 Codex CLI 的 Windows 启动入口。HTTP 适配器仍需要支持相应的凭据存储、失效处理和后端格式变化。

## 1. 本地历史

`sync_codex_usage` 取得 Codex 配置目录，收集 `sessions` 和 `archived_sessions` 中的 JSONL，再逐文件解析。该路径处理 `event_msg/token_count`、`total_token_usage`、`last_token_usage`、继承历史和去重，分批写入工具自己的 `proxy_request_logs`。游标推进与最后一批写入在同一事务内完成。

- [扫描与导入入口](https://github.com/farion1231/cc-switch/blob/f3b18df12007d0fd79fd8ad8d310880664015197/src-tauri/src/services/session_usage_codex.rs#L675-L745)
- [事务写入及游标推进](https://github.com/farion1231/cc-switch/blob/f3b18df12007d0fd79fd8ad8d310880664015197/src-tauri/src/services/session_usage_codex.rs#L1310-L1390)

配置目录由设置中的覆盖值优先决定，否则使用当前用户 home 下 `.codex`。不要只根据文件中的 CODEX_HOME 注释推断此函数直接读取环境变量；该函数本身没有读取它。本项目已有 CODEX_HOME 支持，应保留。

- [路径解析](https://github.com/farion1231/cc-switch/blob/f3b18df12007d0fd79fd8ad8d310880664015197/src-tauri/src/codex_config.rs#L448-L459)

## 2. ChatGPT/Codex 订阅额度

原生登录路径：`read_codex_credentials` 在 macOS 尝试 Keychain，其他情况下走配置目录的 `auth.json`。解析器要求 `auth_mode == chatgpt`，读取 OAuth access token 和可选 account ID。该具体分支未实现 Windows Credential Manager 读取，因此不能声称它覆盖 Windows 所有凭据存储模式。

`query_codex_quota` 直接发出 `GET https://chatgpt.com/backend-api/wham/usage`，携带 Bearer access token、可选 `ChatGPT-Account-Id`，设置 15 秒超时。401/403 被映射为登录失效；网络失败与格式错误分开处理。返回内容读取 `rate_limit.primary_window/secondary_window` 的百分比、窗口秒数和重置时间。

- [凭据解析](https://github.com/farion1231/cc-switch/blob/f3b18df12007d0fd79fd8ad8d310880664015197/src-tauri/src/services/subscription.rs#L483-L610)
- [响应模型及 HTTP 查询](https://github.com/farion1231/cc-switch/blob/f3b18df12007d0fd79fd8ad8d310880664015197/src-tauri/src/services/subscription.rs#L630-L766)

这条实现没有读取本项目 `account/usage/read` 对应的 lifetimeTokens 或 dailyUsageBuckets，也只解析上述两个额度窗口。因此直接照搬会丢失本项目已有的数据能力；应作为独立额度来源，而不是整体替换 AccountReader。

CC Switch 还提供自己的 OAuth 管理路径：取得默认或指定账户，必要时刷新 token，再复用同一个 `query_codex_quota`。它与只读复用 Codex 登录是两个不同复杂度的方案。

- [托管 OAuth 额度入口](https://github.com/farion1231/cc-switch/blob/f3b18df12007d0fd79fd8ad8d310880664015197/src-tauri/src/commands/codex_oauth.rs#L21-L67)

## 3. 代理记账与供应商查询

代理使用独立 usage parser 和 logger，从响应提取 token 后写入请求日志。第三方供应商查询则使用配置的 base URL、凭据及脚本，把 HTTP 响应映射为统一用量结果。这两类都不能自动补齐未经过代理或未保留的历史。

- [代理解析器](https://github.com/farion1231/cc-switch/blob/f3b18df12007d0fd79fd8ad8d310880664015197/src-tauri/src/proxy/usage/parser.rs)
- [代理日志](https://github.com/farion1231/cc-switch/blob/f3b18df12007d0fd79fd8ad8d310880664015197/src-tauri/src/proxy/usage/logger.rs#L101)
- [供应商查询入口](https://github.com/farion1231/cc-switch/blob/f3b18df12007d0fd79fd8ad8d310880664015197/src-tauri/src/services/provider/usage.rs#L12)
- [脚本 HTTP 查询实现](https://github.com/farion1231/cc-switch/blob/f3b18df12007d0fd79fd8ad8d310880664015197/src-tauri/src/usage_script.rs)

## 4. 为什么更容易迁移

除数据源设计外，发布工作流实际配置了 Windows x64、Windows ARM64、Linux 和 macOS 构建，Windows 产物包含 MSI 和 Portable ZIP。普通使用者不需要在目标机器安装 Node 后从源码构建；这是分发层的能力，不由数据接口单独带来。本次未下载或安装这些产物。

- [构建矩阵](https://github.com/farion1231/cc-switch/blob/f3b18df12007d0fd79fd8ad8d310880664015197/.github/workflows/release.yml#L15-L31)
- [Windows 产物说明](https://github.com/farion1231/cc-switch/blob/f3b18df12007d0fd79fd8ad8d310880664015197/.github/workflows/release.yml#L615-L616)

## 对本项目的建议

1. 保留本地导入器及现有精度、去重和新事件格式支持。
2. 将账户额度与账户每日历史分成独立能力和刷新状态。
3. 考虑受控的 HTTP 额度适配器，避免把 CLI 路径作为全部账户功能的前提；保留 App Server 以兼容由 Codex 管理的登录和其独有历史接口。
4. 明确缺失、过期、网络失败、格式不支持；每个数据源保留独立更新时间及账户归属。
5. 后续另行补充 Windows CI 和可携带运行时的发布包。研究上游的发行方案不等于本项目已完成打包验证。
