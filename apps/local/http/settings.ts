import { Type } from "@sinclair/typebox";
import { DateTime } from "luxon";
import * as C from "../../../modules/contracts/index.js";
import { pricingInfo } from "../../../modules/settings/catalog.js";
import { type LocalHttpContext } from './context.js';

export function registerSettingsRoutes(context: LocalHttpContext) {
  const {app,store,queries,refresh,cloud,scheduler,importer,options,meta,wrap,schema,normalize} = context;
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
      return wrap(next, "settings");
    },
  );

}
