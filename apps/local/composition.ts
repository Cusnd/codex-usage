import { homedir } from "node:os";
import path from "node:path";
import { Store } from "../../modules/storage/sqlite.js";
import { Queries } from "../../modules/analytics/sqlite.js";
import { StreamingImporter } from "../../modules/collection/importer.js";
import { V3Uploader } from "../../modules/sync/upload/uploader.js";
import { AccountReader } from "../../modules/accounts/reader.js";
import { Refresh } from "../../modules/accounts/refresh.js";
import { RefreshScheduler } from "../../modules/accounts/scheduler.js";
import { CloudSync } from "../../modules/sync/upload/session.js";
import { dataRoot } from "../../modules/platform/node/runtime.js";
import { type LocalAppOptions } from './options.js';

export function createLocalServices(options: LocalAppOptions) {
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
    uploader,
  });
  refresh.onLimits(async () => { void cloud.tick(); });

  const close = async () => { scheduler.close(); await cloud.close(); await refresh.close(); store.close(); };
  const start = () => { if (options.startup !== false) { refresh.trigger('all', true); if (store.settings().localInterval > 0) importer.startWatching(); scheduler.start(); cloud.start(); } };
  return {store,queries,importer,refresh,scheduler,uploader,cloud,close,start};
}

export type LocalServices = ReturnType<typeof createLocalServices>;
