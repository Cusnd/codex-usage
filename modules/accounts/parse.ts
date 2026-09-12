import { integer } from '../foundation/values.js';
import type { AccountUsage, AccountLimits } from "../contracts/accounts.js";
import { AccountError } from "./credentials.js";

export const fail = (code: string, message: string): never => { throw new AccountError(code, message); };

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

export function parseUsage(raw: any, accountId: string): AccountUsage {
    if (!object(raw) || !("summary" in raw || "dailyUsageBuckets" in raw))
        return fail("RESPONSE_INVALID", "账户每日历史响应格式不支持。");
    const summary = {} as AccountUsage["summary"];
    for (const key of ["lifetimeTokens", "peakDailyTokens", "longestRunningTurnSec", "currentStreakDays", "longestStreakDays"] as const)
        summary[key] = integer(raw.summary?.[key])?.toString() ?? null;
    if (raw.dailyUsageBuckets != null && !Array.isArray(raw.dailyUsageBuckets))
        return fail("RESPONSE_INVALID", "账户每日历史响应格式不支持。");
    return { accountId, summary, dailyUsageBuckets: raw.dailyUsageBuckets == null ? null : raw.dailyUsageBuckets
            .filter((b: any) => typeof b?.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.startDate) && integer(b.tokens) !== null)
            .map((b: any) => ({ startDate: b.startDate, tokens: integer(b.tokens)!.toString() })) };
}
