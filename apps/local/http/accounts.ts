import { Type } from "@sinclair/typebox";
import * as C from "../../../modules/contracts/index.js";
import { type LocalHttpContext } from './context.js';

export function registerAccountsRoutes(context: LocalHttpContext) {
  const {app,store,queries,refresh,cloud,scheduler,importer,options,meta,wrap,schema,normalize} = context;
  const accountWrap = <T,>(data: T, kind: "limits" | "usage") => {
    const state = refresh.status[kind === "limits" ? "accountLimits" : "accountHistory"];
    const warnings = [
      kind === "usage" ? "账户每日桶保留服务端日期；缺失日期不代表零消耗。" : "账户额度是窗口快照，不能换算为 Token 历史。",
      ...(state.error ? [state.error] : []),
      ...(state.stale ? ["正在显示历史快照，请核对账户标识和更新时间。"] : []),
      ...(!state.identityConfirmed ? ["当前账户身份尚未确认；旧记录不代表当前账户状态。"] : []),
      ...(state.provider === "http" ? ["未检测到 Codex CLI，额度使用现有 OAuth 登录通过 HTTP 读取。"] : []),
    ];
    return { data, meta: { ...meta("account"), updatedAt: state.updatedAt, warnings,
      provider: state.provider, accountId: state.accountId, identityConfirmed: state.identityConfirmed, stale: state.stale } };
  };
  const emptyUsage: C.AccountUsage = {
    accountId: null,
    summary: {
      lifetimeTokens: null,
      peakDailyTokens: null,
      longestRunningTurnSec: null,
      currentStreakDays: null,
      longestStreakDays: null,
    },
    dailyUsageBuckets: null,
  };
  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/api/account/usage",
    {
      schema: schema(
        C.AccountUsageSchema,
        Type.Object({
          from: Type.Optional(Type.String({ format: "date" })),
          to: Type.Optional(Type.String({ format: "date" })),
        }),
      ),
    },
    async (req) => {
      const data: C.AccountUsage = await refresh.accountSnapshot("usage") || emptyUsage;
      if (req.query.from && req.query.to && req.query.from >= req.query.to)
        throw Object.assign(new Error("开始日期必须早于结束日期。"), {
          statusCode: 400,
        });
      if (data.dailyUsageBuckets)
        data.dailyUsageBuckets = data.dailyUsageBuckets.filter(
          (x) =>
            (!req.query.from || x.startDate >= req.query.from) &&
            (!req.query.to || x.startDate < req.query.to),
        );
      return accountWrap(data, "usage");
    },
  );
  app.get(
    "/api/account/limits",
    { schema: schema(C.AccountLimitsSchema) },
    async () =>
      accountWrap(await refresh.accountSnapshot("limits") || { accountId: null, buckets: [] }, "limits"),
  );

}
