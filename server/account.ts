import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { integer, parseJson } from "./util.js";
import type { AccountUsage, AccountLimits } from "../shared/contracts.js";
import { AccountError, digest, observeAuth, type AccountIdentity, type AuthObservation } from "./account-credentials.js";
import { resolveCodexCommand, type CodexCommand } from "./codex-command.js";
import { openAccountRpc, type AccountRpc } from "./account-rpc.js";

export { AccountError } from "./account-credentials.js";
export type AccountProvider = "app-server" | "http";
export type AccountResult<T> = { data: T; identity: AccountIdentity; provider: AccountProvider; fallbackReason: string | null };
export type AccountSelection = { identity: AccountIdentity | null; confirmed: boolean };
export interface AccountSource {
  readLimits(): Promise<AccountResult<AccountLimits>>;
  readUsage(): Promise<AccountResult<AccountUsage>>;
  selection(): Promise<AccountSelection>;
  close(): void;
}
type ReaderOptions = {
  root?: string;
  fetch?: typeof fetch;
  openRpc?: (signal: AbortSignal) => Promise<AccountRpc>;
  resolveCommand?: () => Promise<CodexCommand>;
  httpTimeoutMs?: number;
};
const fail = (code: string, message: string): never => { throw new AccountError(code, message); };
const object = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const timestamp = (value: unknown) => {
  if (!finite(value)) return null;
  const d = new Date(value * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
function window(raw: any, http: boolean): AccountLimits["buckets"][number]["primary"] {
  if (raw == null) return null;
  if (!object(raw)) return fail("RESPONSE_INVALID", "额度响应窗口格式不支持。");
  const used = http ? raw.used_percent : raw.usedPercent;
  const duration = http ? raw.limit_window_seconds : raw.windowDurationMins;
  return {
    usedPercent: finite(used) ? used : null,
    remainingPercent: finite(used) ? Math.max(0, Math.min(100, 100 - used)) : null,
    windowDurationMins: finite(duration) && duration > 0 ? duration / (http ? 60 : 1) : null,
    resetsAt: timestamp(http ? raw.reset_at : raw.resetsAt),
  };
}
export function parseLimits(raw: any, accountId: string, http = false): AccountLimits {
  if (!object(raw) || !(http
    ? ("rate_limit" in raw || "additional_rate_limits" in raw)
    : ("rateLimits" in raw || "rateLimitsByLimitId" in raw)))
    return fail("RESPONSE_INVALID", "额度响应格式不支持。");
  const buckets: AccountLimits["buckets"] = [];
  const add = (id: string, name: string, rate: any) => {
    if (rate != null && !object(rate)) return fail("RESPONSE_INVALID", "额度响应格式不支持。");
    buckets.push({ id, name,
      primary: window(http ? rate?.primary_window : rate?.primary, http),
      secondary: window(http ? rate?.secondary_window : rate?.secondary, http),
    });
  };
  if (http) {
    if ("rate_limit" in raw) add("codex", "codex", raw.rate_limit);
    if (raw.additional_rate_limits != null && !Array.isArray(raw.additional_rate_limits))
      return fail("RESPONSE_INVALID", "附加额度响应格式不支持。");
    for (const [i, b] of (raw.additional_rate_limits || []).entries()) {
      if (!object(b)) return fail("RESPONSE_INVALID", "附加额度响应格式不支持。");
      const label = typeof b.limit_name === "string" ? b.limit_name : `附加额度 ${i + 1}`;
      const feature = typeof b.metered_feature === "string" ? b.metered_feature : String(i);
      add(`additional:${feature}:${i}`, label, b.rate_limit);
    }
  } else {
    if (raw.rateLimitsByLimitId != null && !object(raw.rateLimitsByLimitId))
      return fail("RESPONSE_INVALID", "额度响应格式不支持。");
    const entries = Object.entries(raw.rateLimitsByLimitId || {});
    if (entries.length) for (const [id, b] of entries) add(id, typeof (b as any)?.limitName === "string" ? (b as any).limitName : id, b);
    else if ("rateLimits" in raw) add("codex", "codex", raw.rateLimits);
  }
  return { accountId, buckets };
}
function parseUsage(raw: any, accountId: string): AccountUsage {
  if (!object(raw) || !("summary" in raw || "dailyUsageBuckets" in raw)) return fail("RESPONSE_INVALID", "账户每日历史响应格式不支持。");
  const summary = {} as AccountUsage["summary"];
  for (const key of ["lifetimeTokens", "peakDailyTokens", "longestRunningTurnSec", "currentStreakDays", "longestStreakDays"] as const)
    summary[key] = integer(raw.summary?.[key])?.toString() ?? null;
  if (raw.dailyUsageBuckets != null && !Array.isArray(raw.dailyUsageBuckets)) return fail("RESPONSE_INVALID", "账户每日历史响应格式不支持。");
  return { accountId, summary, dailyUsageBuckets: raw.dailyUsageBuckets == null ? null : raw.dailyUsageBuckets
    .filter((b: any) => typeof b?.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.startDate) && integer(b.tokens) !== null)
    .map((b: any) => ({ startDate: b.startDate, tokens: integer(b.tokens)!.toString() })) };
}
export class AccountReader implements AccountSource {
  private root: string;
  private controllers = new Set<AbortController>();
  private closed = false;
  private confirmed: { identity: AccountIdentity; guard: string } | null = null;
  private session = randomUUID();
  private rpcOwner: string | null = null;
  constructor(private options: ReaderOptions = {}) {
    this.root = options.root || process.env.CODEX_HOME || path.join(homedir(), ".codex");
  }
  async selection(): Promise<AccountSelection> {
    const observed = await observeAuth(this.root);
    if (observed.credentials) {
      const { key, accountId } = observed.credentials;
      return { identity: { key, accountId }, confirmed: this.confirmed?.guard === observed.guard && this.confirmed.identity.key === key };
    }
    // Keyring identities cannot be revalidated without another RPC. Cached data is explicitly historical.
    return { identity: this.confirmed?.guard === observed.guard ? this.confirmed.identity : null, confirmed: false };
  }
  private async unchanged(before: AuthObservation, signal: AbortSignal) {
    signal.throwIfAborted();
    if (before.guard !== (await observeAuth(this.root)).guard) {
      this.confirmed = null;
      fail("IDENTITY_CHANGED", "读取期间登录发生变化，已丢弃结果，请重新刷新。");
    }
  }
  private async operation<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return fail("CANCELLED", "账户读取已取消。");
    const controller = new AbortController(); this.controllers.add(controller);
    try { return await fn(controller.signal); }
    catch (e) {
      if (controller.signal.aborted) return fail("CANCELLED", "账户读取已取消。");
      if (e instanceof AccountError) throw e;
      return fail("ACCOUNT_FAILED", "账户读取失败，请检查 Codex 安装与登录。");
    } finally { this.controllers.delete(controller); }
  }
  private command(): Promise<CodexCommand> {
    return this.options.resolveCommand ? this.options.resolveCommand()
      : this.options.openRpc ? Promise.resolve({ bin: process.execPath, args: [] }) : resolveCodexCommand();
  }
  private async appServer(kind: "limits" | "usage", signal: AbortSignal, command: CodexCommand): Promise<AccountResult<any>> {
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
  private async http(signal: AbortSignal): Promise<AccountResult<AccountLimits>> {
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
  readUsage(): Promise<AccountResult<AccountUsage>> {
    return this.operation(async (signal) => {
      let command: CodexCommand;
      try { command = await this.command(); }
      catch (e) {
        if (e instanceof AccountError && e.code === "CLI_NOT_FOUND")
          return fail("CLI_NOT_FOUND", "账户每日历史需要 Codex CLI；本地统计与 OAuth 额度查询可独立使用。");
        throw e;
      }
      return this.appServer("usage", signal, command);
    });
  }
  readLimits(): Promise<AccountResult<AccountLimits>> {
    return this.operation(async (signal) => {
      let command: CodexCommand;
      try { command = await this.command(); }
      catch (e) {
        if (signal.aborted || !(e instanceof AccountError) || e.code !== "CLI_NOT_FOUND") throw e;
        return { ...await this.http(signal), fallbackReason: "未检测到 Codex CLI，使用现有 OAuth 登录。" };
      }
      // A detected CLI owns this read. Runtime/interface failures do not change authentication routes.
      return this.appServer("limits", signal, command);
    });
  }
  close() { this.closed = true; for (const c of this.controllers) c.abort(); }
}
