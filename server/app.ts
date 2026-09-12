import Fastify from "fastify";
import { timingSafeEqual } from 'node:crypto';
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import staticFiles from "@fastify/static";
import { Type, type TSchema } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import * as C from "../shared/contracts.js";
import { Store } from "./db.js";
import { Queries } from "./queries.js";
import { StreamingImporter } from './collector/importer.js';
import { V3Uploader } from './sync-v3/uploader.js';
import { AccountReader, type AccountSource } from "./account.js";
import { Refresh } from "./refresh.js";
import { RefreshScheduler } from './refresh-scheduler.js';
import { CloudSync } from './cloud-sync.js';
import { pricingInfo } from "./pricing.js";
import { dataRoot, packageRoot, autostartStatus, setAutostart } from './runtime.js';

export async function createApp(
  options: {
    database?: string;
    codexHome?: string;
    startup?: boolean;
    logger?: boolean;
    accountReader?: AccountSource;
    exampleData?: boolean;
    cloudCredentialFile?: string | null;
    cloudOrigin?: string;
    cloudFetch?: typeof fetch;
    managed?: { token: string; version: string; shutdown: () => Promise<void> };
  } = {},
) {
  // Managed stop must also release speculative TCP connections without a request.
  const app = Fastify({ logger: options.logger ?? false, forceCloseConnections: options.managed ? true : undefined });
  if (options.managed) {
    const managed = options.managed;
    app.post<{ Params: { action: string } }>('/_control/:action', async (req, reply) => {
      const received = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${managed.token}`);
      if (req.headers.origin || received.length !== expected.length || !timingSafeEqual(received, expected)) return reply.code(403).send({ error: 'Forbidden' });
      if (!['identity', 'stop'].includes(req.params.action)) return reply.code(404).send({ error: 'Not found' });
      if (req.params.action === 'stop') setTimeout(() => { void managed.shutdown(); }, 50);
      return { pid: process.pid, version: managed.version };
    });
  }
  const store = new Store(
    options.database || path.join(dataRoot, "usage.sqlite"),
  );
  const queries = new Queries(store);
  const importer = new StreamingImporter(store,
    options.codexHome || process.env.CODEX_HOME || path.join(homedir(), '.codex'),
    {stateRoot:options.database === ':memory:' ? undefined : path.dirname(options.database || path.join(dataRoot, 'usage.sqlite')),
      onCycle:(progress,metrics)=>{if(!refresh)return;Object.assign(refresh.status.local,progress,{updatedAt:new Date().toISOString(),error:metrics.errors.length?'部分来源采集失败；已保存进度，可重新刷新继续。':null});},
      onError:()=>{refresh.status.local.error='本机记录监测失败，将通过目录复核继续采集。';}});
  const refresh = new Refresh(
    store,
    importer,
    options.accountReader || new AccountReader({ root: options.codexHome }),
  );
  const scheduler = new RefreshScheduler(refresh, () => store.settings());
  const uploader = new V3Uploader(store, importer.collector, {fetch:options.cloudFetch});
  const cloud = new CloudSync(store, {
    credentialFile: options.cloudCredentialFile !== undefined ? options.cloudCredentialFile : options.database === ':memory:' ? null : path.join(path.dirname(options.database || path.join(dataRoot, 'usage.sqlite')), 'cloud-credentials.json'),
    observation: () => refresh.cloudObservation(), origin: options.cloudOrigin || process.env.CODEX_USAGE_CLOUD_ORIGIN, fetch: options.cloudFetch,
    refreshLimits: () => refresh.refreshAccountLimits(),
    history: async () => ({data: await refresh.accountSnapshot('usage'),collectedAt:refresh.status.accountHistory.updatedAt,identityKey:refresh.status.accountHistory.identityKey}),
    collection: () => refresh.status.local,
    uploader,
  });
  refresh.onLimits(async () => { await cloud.capture(); void cloud.tick(); });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Codex 个人用量 API",
        version: "0.1.0",
        description: "账户统计与本地记录分别提供；token 使用十进制字符串。",
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api")) return;
    const host = req.headers.host?.split(":")[0];
    if (host && !["127.0.0.1", "localhost"].includes(host))
      return reply
        .code(403)
        .send({ error: { code: "LOCAL_ONLY", message: "仅允许本机访问。" } });
    if (req.headers.origin) {
      let allowed = false;
      try {
        const u = new URL(req.headers.origin);
        allowed =
          ["127.0.0.1", "localhost"].includes(u.hostname) &&
          ["http:", "https:"].includes(u.protocol);
      } catch {}
      if (!allowed)
        return reply.code(403).send({
          error: { code: "LOCAL_ONLY", message: "此请求来源不允许。" },
        });
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number; validation?: unknown };
    reply.code(e.statusCode || 500).send({
      error: {
        code: e.validation
          ? "INVALID_INPUT"
          : e.statusCode === 404
            ? "NOT_FOUND"
            : "REQUEST_FAILED",
        message: e.validation
          ? "请求参数无效，请检查日期、筛选或分页。"
          : e.statusCode
            ? e.message
            : "请求失败，请查看服务日志。",
      },
    });
    if (!e.statusCode) app.log.error({ err: e }, "request failed");
  });
  const meta = (source: "local" | "account" | "settings"): C.Meta => ({
    ...(options.exampleData ? { exampleData: true } : {}),
    source,
    updatedAt: source === "settings" ? null : refresh.status[source].updatedAt,
    timezone: store.settings().timezone,
    warnings:
      source === "local"
        ? [
            "统计范围为本机已保留记录，与账户统计口径不同。",
            ...(refresh.status.local.issues
              ? ["部分历史记录无法完整归属，请结合来源状态阅读。"]
              : []),
            ...(refresh.status.local.running
              ? ["历史正在导入，当前结果尚未完整。"]
              : []),
          ]
        : source === "account"
          ? [
              "账户每日桶保留服务端日期；缺失日期不代表零消耗。",
              ...(refresh.status.account.error
                ? [refresh.status.account.error]
                : []),
            ]
          : [],
  });
  const wrap = (
    data: unknown,
    source: "local" | "account" | "settings" = "local",
  ) => ({ data, meta: meta(source) });
  const schema = (response: TSchema, query?: TSchema, body?: TSchema) => ({
    ...(query ? { querystring: query } : {}),
    ...(body ? { body } : {}),
    response: {
      200: C.ResponseSchema(response),
      400: C.ErrorSchema,
      404: C.ErrorSchema,
      500: C.ErrorSchema,
    },
  });
  const normalize = (q: any): C.Filter => {
    if (q.from && q.to && Date.parse(q.from) >= Date.parse(q.to))
      throw Object.assign(new Error("开始时间必须早于结束时间。"), {
        statusCode: 400,
      });
    if (
      [...(q.unknown ? [q.unknown] : []), ...(q.unknowns || [])].some(
        (key) => q[key] !== undefined,
      )
    )
      throw Object.assign(new Error("同一维度不能同时选择具体值和未知。"), {
        statusCode: 400,
      });
    return {
      from: q.from,
      to: q.to,
      project: q.project,
      model: q.model,
      effort: q.effort,
      threadId: q.threadId,
      unknown: q.unknown,
      unknowns: q.unknowns,
    };
  };
  app.get("/openapi.json", async () => app.swagger());
  app.get('/api/cloud/status', async () => wrap(cloud.status(), 'settings'));
  app.post<{ Body: { deviceName?: string; fullUsage?: boolean } }>('/api/cloud/connect', {
    schema: { body: Type.Object({ deviceName: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),fullUsage:Type.Optional(Type.Boolean()) }, { additionalProperties: false }) },
  }, async req => wrap(await cloud.connect(req.body.deviceName,req.body.fullUsage ?? true), 'settings'));
  app.patch<{ Body: { enabled: boolean; fullUsage?: boolean } }>('/api/cloud/settings', {
    schema: { body: Type.Object({ enabled: Type.Boolean(),fullUsage:Type.Optional(Type.Boolean()) }, { additionalProperties: false }) },
  }, async req => { if(req.body.fullUsage!==undefined)await cloud.setFullUsage(req.body.fullUsage);return wrap(await cloud.setEnabled(req.body.enabled), 'settings'); });
  app.delete('/api/cloud/connection', async () => wrap(await cloud.disconnect(), 'settings'));
  app.get('/api/system/autostart', async () => wrap(autostartStatus(), 'settings'));
  app.post<{ Body: { enabled: boolean } }>('/api/system/autostart', {
    schema: { body: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }) },
  }, async (req, reply) => {
    if (req.headers.origin !== `http://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: '需要同源设置页面操作。' } });
    }
    try { return wrap(setAutostart(req.body.enabled), 'settings'); }
    catch (error) { throw Object.assign(new Error(error instanceof Error ? error.message : '系统启动项操作失败。'), { statusCode: 400 }); }
  });
  app.get(
    "/api/pricing",
    {
      schema: schema(C.PricingInfoSchema),
    },
    async () =>
      wrap(pricingInfo(), "settings"),
  );
  app.get("/api/status", { schema: schema(C.StatusSchema) }, async () =>
    wrap(await refresh.getStatus()),
  );
  app.post<{ Body: { source: C.RefreshSource; force?: boolean } }>(
    "/api/refresh",
    {
      schema: {
        ...schema(
          C.StatusSchema,
          undefined,
          Type.Object(
            {
              source: Type.Union([
                Type.Literal("local"),
                Type.Literal("account"),
                Type.Literal("all"),
                Type.Literal("accountLimits"),
                Type.Literal("accountHistory"),
              ]),
              force: Type.Optional(Type.Boolean()),
            },
            { additionalProperties: false },
          ),
        ),
        response: { 202: C.ResponseSchema(C.StatusSchema) },
      },
    },
    async (req, reply) => {
      refresh.trigger(req.body.source, req.body.force);
      return reply.code(202).send(wrap(await refresh.getStatus()));
    },
  );
  app.get("/api/settings", { schema: schema(C.SettingsSchema) }, async () =>
    wrap(store.settings(), "settings"),
  );
  app.patch<{ Body: Partial<C.Settings> }>(
    "/api/settings",
    {
      schema: schema(
        C.SettingsSchema,
        undefined,
        Type.Partial(C.SettingsSchema),
      ),
    },
    async (req) => {
      const next = { ...store.settings(), ...req.body };
      if (
        next.modelPrices &&
        new Set(next.modelPrices.map((p) => p.model)).size !==
          next.modelPrices.length
      )
        throw Object.assign(new Error("同一模型只能配置一组价格。"), {
          statusCode: 400,
        });
      if (
        (next.localInterval !== 0 && next.localInterval < 10) ||
        (next.accountInterval !== 0 && next.accountInterval < 60) ||
        !DateTime.now().setZone(next.timezone).isValid
      )
        throw Object.assign(
          new Error(
            "本地刷新至少 10 秒，账户至少 60 秒；0 关闭自动刷新。请使用有效的 IANA 时区。",
          ),
          { statusCode: 400 },
        );
      store.saveSettings(next);
      scheduler.reschedule();
      if(options.startup!==false){if(next.localInterval>0)importer.startWatching();else importer.stopWatching();}
      await cloud.capture();
      return wrap(next, "settings");
    },
  );
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
  app.get<{ Querystring: C.Filter }>(
    "/api/local/summary",
    { schema: schema(C.MetricsSchema, C.FilterSchema) },
    async (req) => wrap(queries.summary(normalize(req.query))),
  );
  app.get<{ Querystring: C.Filter }>(
    "/api/local/filters",
    { schema: schema(C.FiltersSchema, C.FilterSchema) },
    async (req) => wrap(queries.filters(normalize(req.query))),
  );
  const trendQuery = Type.Object({
    ...C.FilterSchema.properties,
    bucket: Type.Optional(
      Type.Union([Type.Literal("hour"), Type.Literal("day")]),
    ),
  });
  app.get<{ Querystring: C.Filter & { bucket?: "hour" | "day" } }>(
    "/api/local/trend",
    { schema: schema(Type.Array(C.TrendRowSchema), trendQuery) },
    async (req) =>
      wrap(queries.trend(normalize(req.query), req.query.bucket || "day")),
  );
  const groupQuery = Type.Object({
    ...C.FilterSchema.properties,
    ...C.Pagination,
    groupBy: C.GroupSchema,
  });
  app.get<{
    Querystring: C.Filter & {
      groupBy: "project" | "model" | "effort";
      limit?: number;
      offset?: number;
    };
  }>(
    "/api/local/breakdown",
    { schema: schema(C.PageSchema(C.GroupRowSchema), groupQuery) },
    async (req) =>
      wrap(
        queries.breakdown(
          normalize(req.query),
          req.query.groupBy,
          req.query.limit || 50,
          req.query.offset || 0,
        ),
      ),
  );
  const threadQuery = Type.Object({
    ...C.FilterSchema.properties,
    ...C.Pagination,
    q: Type.Optional(Type.String({ maxLength: 300 })),
    sort: Type.Optional(
      Type.Union([Type.Literal("tokens"), Type.Literal("recent")]),
    ),
    cacheBelow: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 1,
        description:
          "Only threads with a known cache ratio below this threshold",
      }),
    ),
  });
  app.get<{
    Querystring: C.Filter & {
      limit?: number;
      offset?: number;
      sort?: string;
      cacheBelow?: number;
      q?: string;
    };
  }>(
    "/api/local/threads",
    { schema: schema(C.PageSchema(C.ThreadRowSchema), threadQuery) },
    async (req) =>
      wrap(
        queries.threads(
          normalize(req.query),
          req.query.limit || 50,
          req.query.offset || 0,
          req.query.sort,
          req.query.cacheBelow,
          req.query.q,
        ),
      ),
  );
  app.get<{ Params: { id: string }; Querystring: C.Filter }>(
    "/api/local/threads/:id/agents",
    {
      schema: {
        ...schema(C.AgentUsageSchema, C.FilterSchema),
        params: Type.Object({ id: Type.String() }),
      },
    },
    async (req) => {
      const data = queries.agents(req.params.id, normalize(req.query));
      if (!data) throw Object.assign(new Error("没有找到该任务。"), { statusCode: 404 });
      return wrap(data);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/local/threads/:id",
    {
      schema: {
        ...schema(C.ThreadDetailSchema),
        params: Type.Object({ id: Type.String() }),
      },
    },
    async (req) => {
      const data = queries.detail(req.params.id);
      if (!data)
        throw Object.assign(new Error("没有找到该任务的可统计记录。"), {
          statusCode: 404,
        });
      return wrap(data);
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: C.Filter & { limit?: number; offset?: number; sort?: string };
  }>(
    "/api/local/threads/:id/turns",
    {
      schema: {
        ...schema(
          C.PageSchema(C.TurnRowSchema),
          Type.Object({
            ...C.FilterSchema.properties,
            ...C.Pagination,
            sort: Type.Optional(
              Type.Union([
                Type.Literal("tokens"),
                Type.Literal("recent"),
                Type.Literal("oldest"),
              ]),
            ),
          }),
        ),
        params: Type.Object({ id: Type.String() }),
      },
    },
    async (req) =>
      wrap(
        queries.turns(
          req.params.id,
          normalize(req.query),
          req.query.limit || 50,
          req.query.offset || 0,
          req.query.sort,
        ),
      ),
  );
  app.get<{
    Querystring: C.Filter & {
      limit?: number;
      offset?: number;
      sort?: string;
      q?: string;
      turnId?: string;
      missingTurn?: boolean;
    };
  }>(
    "/api/local/turns",
    {
      schema: schema(
        C.PageSchema(C.TurnRowSchema),
        Type.Object({
          ...C.FilterSchema.properties,
          ...C.Pagination,
          q: Type.Optional(Type.String({ maxLength: 300 })),
          sort: Type.Optional(
            Type.Union([
              Type.Literal("tokens"),
              Type.Literal("recent"),
              Type.Literal("oldest"),
            ]),
          ),
          turnId: Type.Optional(Type.String()),
          missingTurn: Type.Optional(Type.Boolean()),
        }),
      ),
    },
    async (req) =>
      wrap(
        queries.allTurns(
          {
            ...normalize(req.query),
            turnId: req.query.missingTurn ? null : req.query.turnId,
          },
          req.query.limit || 50,
          req.query.offset || 0,
          req.query.sort,
          req.query.q,
        ),
      ),
  );
  const compareQuery = Type.Object({
    ...C.FilterSchema.properties,
    groupBy: Type.Optional(Type.Union([C.GroupSchema, Type.Literal("thread")])),
    baselineFrom: Type.Optional(Type.String({ format: "date-time" })),
    baselineTo: Type.Optional(Type.String({ format: "date-time" })),
  });
  app.get<{
    Querystring: C.Filter & {
      groupBy?: "project" | "model" | "effort" | "thread";
      baselineFrom?: string;
      baselineTo?: string;
    };
  }>(
    "/api/local/compare",
    { schema: schema(C.CompareSchema, compareQuery) },
    async (req) => {
      const q = req.query;
      normalize({ from: q.baselineFrom, to: q.baselineTo });
      if (!!q.baselineFrom !== !!q.baselineTo)
        throw Object.assign(new Error("基准开始与结束时间需要同时提供。"), {
          statusCode: 400,
        });
      return wrap(
        queries.compare(
          normalize(q),
          q.groupBy || "project",
          q.baselineFrom,
          q.baselineTo,
        ),
      );
    },
  );
  const web = path.join(packageRoot, "dist/web");
  if (existsSync(path.join(web, "index.html"))) {
    await app.register(staticFiles, { root: web, prefix: "/" });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api")
        ? reply
            .code(404)
            .send({ error: { code: "NOT_FOUND", message: "接口不存在。" } })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => {
    scheduler.close();
    await cloud.close();
    await refresh.close();
    store.close();
  });
  await app.ready();
  if (options.startup !== false) { refresh.trigger("all", true); if(store.settings().localInterval>0)importer.startWatching(); scheduler.start(); cloud.start(); }
  return { app, store, queries, refresh, scheduler, cloud, collector:importer.collector };
}
