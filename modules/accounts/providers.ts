import { randomUUID } from "node:crypto";
import { parseJson } from '../foundation/values.js';
import type { AccountLimits } from "../contracts/accounts.js";
import { AccountError, digest, observeAuth, type AccountIdentity, type AuthObservation } from "./credentials.js";
import { type CodexCommand } from "./command.js";
import { openAccountRpc } from "./rpc.js";
import { type ReaderOptions, type AccountResult } from "./ports.js";
import { fail, parseLimits, parseUsage } from "./parse.js";

export class AccountProviders {
constructor(private root:string,private options:ReaderOptions) {}
confirmed: { identity: AccountIdentity; guard: string } | null = null;
session = randomUUID();
rpcOwner: string | null = null;
async unchanged(before: AuthObservation, signal: AbortSignal) {
    signal.throwIfAborted();
    if (before.guard !== (await observeAuth(this.root)).guard) {
      this.confirmed = null;
      fail("IDENTITY_CHANGED", "读取期间登录发生变化，已丢弃结果，请重新刷新。");
    }
  }
async appServer(kind: "limits" | "usage", signal: AbortSignal, command: CodexCommand): Promise<AccountResult<any>> {
    const before = await observeAuth(this.root);
    const rpc = this.options.openRpc ? await this.options.openRpc(signal)
      : openAccountRpc(command, this.root, signal);
    try {
      signal.throwIfAborted();
      await rpc.request("initialize", { clientInfo: { name: "codex_detailed_usage", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      rpc.notify("initialized");
      const login = await rpc.request("account/read", { refreshToken: false });
      if (login?.account?.type !== "chatgpt") return fail("UNSUPPORTED_LOGIN", "账户功能需要有效的 ChatGPT 登录。");
      const raw = await rpc.request(kind === "limits" ? "account/rateLimits/read" : "account/usage/read", kind === "usage" ? {} : undefined);
      let identity: AccountIdentity;
      if (before.credentials) {
        identity = { key: before.credentials.key, accountId: before.credentials.accountId };
        if (raw?.accountId && raw.accountId !== identity.accountId) return fail("IDENTITY_CHANGED", "App Server 与登录文件的账户不一致，已丢弃结果。");
      } else {
        // Codex-managed storage requires a backend workspace ID. Never persist an email-based identity.
        const limits = kind === "limits" ? raw : await rpc.request("account/rateLimits/read");
        if (typeof limits?.accountId !== "string" || !limits.accountId) return fail("IDENTITY_UNKNOWN", "App Server 未提供可确认的账户标识。");
        // Use account/read only to detect a change, not as a durable user ID or email-based merge key.
        const owner = digest(JSON.stringify(login.account));
        if (this.rpcOwner !== owner) { this.session = randomUUID(); this.rpcOwner = owner; }
        identity = { key: digest(JSON.stringify([this.session, limits.accountId])), accountId: limits.accountId };
      }
      if (kind === "limits") {
        const afterLimits = await rpc.request("account/rateLimits/read");
        if (raw?.accountId !== afterLimits?.accountId) return fail("IDENTITY_CHANGED", "账户在额度读取期间发生变化，已丢弃结果。");
      }
      const afterLogin = await rpc.request("account/read", { refreshToken: false });
      if (JSON.stringify(login?.account) !== JSON.stringify(afterLogin?.account)) return fail("IDENTITY_CHANGED", "账户在读取期间发生变化，已丢弃结果。");
      if (!before.credentials && identity.key !== digest(JSON.stringify([this.session, identity.accountId])))
        return fail("IDENTITY_CHANGED", "并行读取期间账户发生变化，已丢弃结果。");
      await this.unchanged(before, signal);
      const data = kind === "limits" ? parseLimits(raw, identity.accountId) : parseUsage(raw, identity.accountId);
      this.confirmed = { identity, guard: before.guard };
      return { data, identity, provider: "app-server", fallbackReason: null };
    } finally { await rpc.close(); }
  }
async http(signal: AbortSignal): Promise<AccountResult<AccountLimits>> {
    const before = await observeAuth(this.root);
    if (!before.credentials) throw before.error!;
    const { token, key, accountId } = before.credentials;
    const timeout = AbortSignal.timeout(this.options.httpTimeoutMs ?? 15000);
    const combined = AbortSignal.any([signal, timeout]);
    let raw: any;
    try {
      const response = await (this.options.fetch || fetch)("https://chatgpt.com/backend-api/wham/usage", {
        method: "GET", redirect: "error", signal: combined,
        headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId, Accept: "application/json", "User-Agent": "codex-cli" },
      });
      if ([401, 403].includes(response.status)) return fail("LOGIN_EXPIRED", "HTTP 登录已失效或被拒绝，请在 Codex 中重新登录。");
      if (!response.ok) return fail("HTTP_STATUS", `额度 HTTP 查询失败（${response.status}）。`);
      const text = await response.text();
      try { raw = parseJson(text); } catch { return fail("RESPONSE_INVALID", "额度 HTTP 响应不是有效 JSON。"); }
    } catch (e) {
      if (signal.aborted) return fail("CANCELLED", "账户读取已取消。");
      if (timeout.aborted) return fail("HTTP_TIMEOUT", "额度 HTTP 查询超时。");
      if (e instanceof AccountError) throw e;
      return fail("HTTP_NETWORK", "额度 HTTP 网络请求失败或重定向被拒绝。");
    }
    await this.unchanged(before, signal);
    if (typeof raw?.account_id === "string" && raw.account_id !== accountId) return fail("IDENTITY_CHANGED", "HTTP 返回的账户不一致，已丢弃结果。");
    const data = parseLimits(raw, accountId, true);
    const identity = { key, accountId };
    this.confirmed = { identity, guard: before.guard };
    return { data, identity, provider: "http", fallbackReason: null };
  }
}
