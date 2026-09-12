import { Type } from "@sinclair/typebox";
import * as C from "../../../modules/contracts/index.js";
import { type LocalHttpContext } from './context.js';

export function registerAnalyticsRoutes(context: LocalHttpContext) {
  const {app,store,queries,refresh,cloud,scheduler,importer,options,meta,wrap,schema,normalize} = context;
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

}
