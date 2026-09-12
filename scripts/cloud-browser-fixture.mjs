// Runs the real local service with a synthetic account and isolated data for CUA acceptance.
import { mkdirSync,readFileSync,writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../dist/apps/local/app.js";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../cloud/.deploy/browser-fixture-"+(process.argv[2]||'A'),
);
mkdirSync(root, { recursive: true });
const identity = {
  key: "synthetic-account-private-id",
  accountId: "synthetic-private-workspace",
};
let count = 0;
const reader = {
  selection: async () => ({ identity, confirmed: true }),
  close() {},
  readLimits: async () => ({
    identity,
    provider: "app-server",
    fallbackReason: null,
    data: {
      accountId: identity.accountId,
      privateToken: "SYNTHETIC-NEVER-UPLOAD",
      buckets: [
        {
          id: "codex",
          name: "Codex",
          primary: {
            usedPercent: 20 + (++count % 5),
            remainingPercent: 80 - (count % 5),
            windowDurationMins: 300,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
          },
          secondary: {
            usedPercent: 61,
            remainingPercent: 39,
            windowDurationMins: 10080,
            resetsAt: "2026-09-09T00:00:00.000Z",
          },
        },
        {
          id: "spark",
          name: "Code generation · Extended",
          primary: {
            usedPercent: null,
            remainingPercent: null,
            windowDurationMins: null,
            resetsAt: null,
          },
          secondary: null,
        },
      ],
    },
  }),
  readUsage: async () => ({
    identity,
    provider: "app-server",
    fallbackReason: null,
    data: {
      accountId: identity.accountId,
      summary: {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsageBuckets: null,
    },
  }),
};
const { app,collector } = await createApp({
  database: path.join(root, "usage.sqlite"),
  codexHome: root,
  cloudOrigin: "http://127.0.0.1:18787",
  accountReader: reader,
});
const data=JSON.parse(readFileSync(new URL('../cloud/.generated/parity.json',import.meta.url),'utf8')).devices[process.argv[2]||'A'];
mkdirSync(path.join(root,'sessions'),{recursive:true});
for(const t of data.threads){
  const rows=[{type:'session_meta',timestamp:new Date().toISOString(),payload:{id:t.id,cwd:t.project,source:t.source}}];
  for(const e of data.events.filter(e=>e.thread_id===t.id&&e.kind==='record'))rows.push({type:'token_usage_record',timestamp:new Date(Date.now()-3600000).toISOString(),payload:{thread_id:e.thread_id,turn_id:e.turn_id,response_id:e.response_id,model:e.model,usage:Object.fromEntries(Object.entries(e).filter(([key])=>key.endsWith('_tokens')))}});
  writeFileSync(path.join(root,'sessions',t.id+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
}
await collector.scan();
const port=Number(process.argv[3]||8767);await app.listen({port,host:'127.0.0.1'});
console.log('Synthetic local collector ready: http://127.0.0.1:'+port+'/settings');
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
