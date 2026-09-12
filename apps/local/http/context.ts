import { type TSchema } from "@sinclair/typebox";
import * as C from "../../../modules/contracts/index.js";
import type { FastifyInstance } from "fastify";
import { type LocalServices } from '../composition.js';
import { type LocalAppOptions } from '../options.js';

export function createResponseHelpers(services: LocalServices, options: LocalAppOptions) {
  const {store,refresh} = services;
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

  return {meta,wrap,schema,normalize};
}

export type LocalHttpContext = LocalServices & ReturnType<typeof createResponseHelpers> & {app:FastifyInstance;options:LocalAppOptions};
