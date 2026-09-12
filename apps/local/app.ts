import Fastify from "fastify";
import { type LocalAppOptions } from './options.js';
import { registerControl, configureHttp } from './http/security.js';
import { createLocalServices } from './composition.js';
import { createResponseHelpers } from './http/context.js';
import { registerCloudRoutes } from './http/cloud.js';
import { registerSystemRoutes } from './http/system.js';
import { registerSettingsRoutes } from './http/settings.js';
import { registerAccountsRoutes } from './http/accounts.js';
import { registerAnalyticsRoutes } from './http/analytics.js';
import { registerAssets } from './http/assets.js';

export async function createApp(options:LocalAppOptions = {}) {
  const app = Fastify({logger:options.logger ?? false,forceCloseConnections:options.managed ? true : undefined});
  registerControl(app,options);
  const services=createLocalServices(options);
  await configureHttp(app);
  const context={app,options,...services,...createResponseHelpers(services,options)};
  registerCloudRoutes(context);registerSystemRoutes(context);registerSettingsRoutes(context);registerAccountsRoutes(context);registerAnalyticsRoutes(context);
  await registerAssets(app);
  app.addHook('onClose',services.close);
  await app.ready();services.start();
  const {store,queries,refresh,scheduler,cloud,importer}=services;
  return {app,store,queries,refresh,scheduler,cloud,collector:importer.collector};
}
