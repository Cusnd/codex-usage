import { Type } from "@sinclair/typebox";
import { type LocalHttpContext } from './context.js';

export function registerCloudRoutes(context: LocalHttpContext) {
  const {app,store,queries,refresh,cloud,scheduler,importer,options,meta,wrap,schema,normalize} = context;
  app.get('/api/cloud/status', async () => wrap(cloud.status(), 'settings'));
  app.post<{ Body: { deviceName?: string } }>('/api/cloud/connect', {
    schema: { body: Type.Object({ deviceName: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) }, { additionalProperties: false }) },
  }, async req => wrap(await cloud.connect(req.body.deviceName), 'settings'));
  app.patch<{ Body: { enabled: boolean } }>('/api/cloud/settings', {
    schema: { body: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }) },
  }, async req => { return wrap(await cloud.setEnabled(req.body.enabled), 'settings'); });
  app.delete('/api/cloud/connection', async () => wrap(await cloud.disconnect(), 'settings'));

}
