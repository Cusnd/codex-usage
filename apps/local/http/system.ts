import { Type } from "@sinclair/typebox";
import { autostartStatus, setAutostart } from "../../../modules/platform/node/runtime.js";
import { type LocalHttpContext } from './context.js';

export function registerSystemRoutes(context: LocalHttpContext) {
  const {app,store,queries,refresh,cloud,scheduler,importer,options,meta,wrap,schema,normalize} = context;
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

}
