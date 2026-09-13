// Local-only acceptance wrapper. Production never imports this entry.
import browserWorker from '../../cloud/test/browser-worker.js';
import worker from '../../apps/cloud/index.js';
import { sessionUser } from '../../apps/cloud/auth.js';
import { sha256, token } from '../../modules/platform/worker/http.js';
import { initialContext, normalizeTokens, projectRecord } from '../../modules/usage/normalize.js';
import { stableJson, EXTRACTOR_VERSION, V3_CONTENT_TYPE } from '../../modules/contracts/sync.js';
import { SYNC_HEADER, SYNC_VERSION } from '../../modules/contracts/cloud-version.js';
import { advanceJobs } from '../../modules/sync/jobs/jobs.js';
import { telemetry } from './telemetry.js';
import { baselineHTML } from './baseline-html.js';

// Synthetic internal requests do not have edge cf metadata; this fixture does not read it.
const fixtureFetch = (request: Request, env: Env, ctx: ExecutionContext) =>
  browserWorker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);

type Failure = 'none' | 'view' | 'trend' | 'api';
let failure: Failure = 'none', delayMs = 120;
let variant: 'baseline' | 'candidate' = 'candidate';
let requests: Record<string, unknown>[] = [], reports: unknown[] = [];
const controls = `<!doctype html><meta charset="utf-8"><title>Cloud online acceptance</title>
<style>body{font:16px system-ui;max-width:1000px;margin:32px auto;padding:0 20px}button,a{margin:5px;padding:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>完全在线云端 · 本地真实验收</h1>
<p>真实 Worker / D1 / 完整云端 UI。所有用户与账户均为合成数据。API 默认额外延迟 120 ms；不拦截登出。</p>
<p>双设备统计预期：设备 A 72,000，设备 B 18,000，全部 90,000 Tokens。快速种子共 2 个事件；规模种子共 1,001 个事件。不是九万实体。</p>
<button data-action="variant-baseline">选择旧版完整镜像 UI</button><button data-action="variant-candidate">选择候选在线 UI</button>
<p>切换后请重新打开或刷新首页；现有标签不会自动更换脚本。保持单个面板标签进行各阶段观测。</p>
<button data-action="seed">新用户 · 快速双设备种子</button><button data-action="seed-1000">新用户 · 1,001 事件种子</button>
<button data-action="advance">真实上传 +9,000 Tokens</button><button data-action="fail-view">view / usage 返回 503</button>
<button data-action="fail-trend">仅 trend 返回 503</button>
<button data-action="fail-api">全部 v3 API 返回 503</button><button data-action="recover">恢复 API</button>
<button data-action="delay-0">API 额外延迟 0 ms</button><button data-action="delay-120">API 额外延迟 120 ms</button>
<button data-action="old">上报旧协议</button><button data-action="match">恢复匹配协议</button>
<button data-action="expire">撤销当前登录会话</button><button data-action="delete-b">真实删除设备 B 历史</button>
<button data-action="scheduler-step">推进一次后台任务（本地定时器）</button>
<p>本地定时器按钮仅推进当前合成用户的生产后台任务，模拟本地未自动触发的定时调度；保留当前 API 故障设置。</p>
<button data-action="reset-observation">清空服务端观测</button><button data-action="observation">读取服务端与浏览器观测</button>
<a href="/" target="_blank">打开首页</a><a href="/devices" target="_blank">打开设备页</a>
<pre id="result">先创建种子；候选 UI 的统计请求应无 manifest/entities/changes/sync-read，无 IDB 统计写入。</pre>
<script>for(const b of document.querySelectorAll('button'))b.onclick=async()=>{const action=b.dataset.action;b.disabled=true;try{const response=await fetch('/api/test/online/'+action,{method:action==='observation'?'GET':'POST'});document.getElementById('result').textContent=JSON.stringify({status:response.status,data:await response.json()},null,2);}catch(e){document.getElementById('result').textContent=String(e);}finally{b.disabled=false;}};</script>`;

async function successful(response: Response, operation: string) {
  const body = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(operation + ': ' + stableJson(body));
  return body;
}
const internal = (origin: string, path: string, cookie: string, method = 'POST') => new Request(origin + path, {
  method, headers: { Origin: origin, Cookie: cookie, [SYNC_HEADER]: SYNC_VERSION },
});

async function seedDevice(env: Env, origin: string, user: string, count: number, additional = false) {
  const device = user + '-b', credential = token(), now = new Date().toISOString();
  await env.DB.prepare('INSERT OR IGNORE INTO devices(id,user_id,name,token_hash,bound_at) VALUES(?,?,?,?,?)')
    .bind(device, user, '合成设备 B · 18K Tokens', await sha256(credential), Date.now()).run();
  await env.DB.prepare('UPDATE devices SET token_hash=? WHERE id=? AND user_id=?').bind(await sha256(credential), device, user).run();
  const headers = { Authorization: 'Bearer ' + credential, [SYNC_HEADER]: SYNC_VERSION };
  await successful(await worker.fetch(new Request(origin + '/api/v3/collector/handshake', { method: 'POST', headers }), env), 'handshake');
  const suffix = additional ? 'advance-' + crypto.randomUUID() : 'initial', source = 'online-' + suffix;
  const context = { ...initialContext('online-thread-' + suffix), turn_id: 'online-turn-' + suffix, model: 'gpt-6-astra', cwd: '/synthetic/online-b' };
  const each = additional ? 9000 : 18000 / count;
  const raw = [projectRecord({ type: 'session_meta', timestamp: now, payload: { id: context.thread_id, cwd: context.cwd, source: 'cli' } }).record,
    ...Array.from({ length: count }, (_, index) => ({ type: 'token_usage_record', timestamp: now,
      payload: { thread_id: context.thread_id, turn_id: context.turn_id, response_id: source + '-' + index,
        usage: normalizeTokens({ input_tokens: String(each - 2), output_tokens: '2', total_tokens: String(each) }) } }))];
  const records = await Promise.all(raw.map(async (record, index) => ({ observation_id: await sha256(stableJson([device, source, 1, index * 100])),
    record_revision: 1, source_id: source, generation: 1, locator: index * 100, byte_end: (index + 1) * 100,
    prefix_hash: await sha256(stableJson(record)), session_trusted: true,
    origin: { kind: 'execution' as const, device_id: device }, context, record })));
  const current = await env.DB.prepare('SELECT COALESCE(MAX(lane_seq),0) seq FROM v3_receipts WHERE user_id=? AND collector_id=? AND lane=\'live\'').bind(user, device).first<{ seq: number }>();
  let sequence = current?.seq ?? 0;
  for (let from = 0; from < records.length; from += 250) {
    const batchRecords = records.slice(from, from + 250), end = from + batchRecords.length, batchId = crypto.randomUUID();
    const batch = { protocol: 3, schema_version: 1, extractor_version: EXTRACTOR_VERSION, collector_id: device,
      producer_epoch: 'online-fixture', lane: 'live', lane_seq: ++sequence, batch_id: batchId,
      records_hash: await sha256(stableJson(batchRecords)), records: batchRecords, metadata: [],
      sources: [{ source_id: source, generation: 1, kind: 'session', from_cursor: from * 100, to_cursor: end * 100,
        snapshot_eof: records.length * 100, context_hash: await sha256(stableJson(context)), context,
        replace_start: from === 0, replace_end: end === records.length, generation_complete: end === records.length,
        available: true, trailing_bytes: 0 }] };
    const wire = await new Response(new Blob([stableJson(batch)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    await successful(await worker.fetch(new Request(origin + '/api/v3/ingest', { method: 'POST', headers: { ...headers, 'Content-Type': V3_CONTENT_TYPE }, body: wire }), env), 'ingest');
    await advanceJobs(env.DB, { user, job_id: 'apply:' + batchId, maxSteps: 100, maxQueries: 700, budgetMs: 10000 });
    const receipt = await env.DB.prepare('SELECT status FROM v3_receipts WHERE user_id=? AND batch_id=?').bind(user, batchId).first<{ status: string }>();
    if (receipt?.status !== 'applied') throw new Error('Synthetic batch did not reach applied');
  }
  await successful(await worker.fetch(new Request(origin + '/api/v3/sync/status', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ collectedAt: now, totalThreads: additional ? 2 : 1, initialComplete: true, error: null }) }), env), 'status');
  if (!additional) {
    // Exercise real account endpoints with a strictly synthetic quota, no credentials/history.
    await successful(await worker.fetch(new Request(origin + '/api/v3/accounts/observations', { method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 3, history: null, historyCollectedAt: null,
        quota: { schemaVersion: 3, deviceId: device, sequence: 1, accountRef: await sha256('synthetic-online-account'), collectedAt: now, attemptedAt: now,
          provider: 'app-server', refreshInterval: 60, status: 'ok', errorCode: null, buckets: [{ id: 'codex', name: 'Synthetic Codex',
            primary: { usedPercent: 25, remainingPercent: 75, windowDurationMins: 300, resetsAt: new Date(Date.now() + 3600000).toISOString() }, secondary: null }] } }) }), env), 'account');
  }
  return { deviceName: 'B', events: count, tokensAdded: each * count };
}

async function control(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url), action = url.pathname.split('/').at(-1)!;
  if (action === 'observation' && request.method === 'GET') return Response.json({ variant, failure, delayMs, requests, reports });
  if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) return new Response('Same-origin POST required', { status: 403 });
  if (action === 'report') { reports.push(await request.json()); reports = reports.slice(-30); return Response.json({ saved: true }); }
  if (action === 'seed' || action === 'seed-1000') {
    failure = 'none';
    const created = await fixtureFetch(internal(url.origin, '/api/test/version/start', ''), env, ctx);
    const setCookie = created.headers.get('Set-Cookie')!, cookie = setCookie.split(';')[0];
    await successful(created, 'create user');
    await successful(await fixtureFetch(internal(url.origin, '/api/test/version/match', cookie), env, ctx), 'seed A');
    const user = await sessionUser(internal(url.origin, '/', cookie), env);
    const seeded = await seedDevice(env, url.origin, user.id, action === 'seed-1000' ? 1000 : 1);
    requests = []; reports = [];
    return Response.json({ seeded: true, deviceATokens: 72000, deviceBTokens: 18000, totalTokens: 90000,
      tokenEventCount: 1 + seeded.events, notice: 'New synthetic user; old user is untouched.' }, { headers: { 'Set-Cookie': setCookie } });
  }
  if (action === 'variant-baseline') variant = 'baseline';
  else if (action === 'variant-candidate') variant = 'candidate';
  else if (action === 'recover') failure = 'none';
  else if (action === 'fail-view') failure = 'view';
  else if (action === 'fail-trend') failure = 'trend';
  else if (action === 'fail-api') failure = 'api';
  else if (action === 'delay-0') delayMs = 0;
  else if (action === 'delay-120') delayMs = 120;
  else if (action === 'reset-observation') { requests = []; reports = []; }
  else {
    const user = await sessionUser(request, env);
    if (!user.id.startsWith('v3-browser-')) return new Response('Synthetic user required', { status: 403 });
    if (action === 'expire') await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id).run();
    else if (action === 'scheduler-step') {
      const result = await advanceJobs(env.DB, { user: user.id, maxSteps: 200, maxQueries: 600, budgetMs: 20000 });
      return Response.json({ action, simulation: 'local scheduler; current synthetic user only', ...result, variant, failure, delayMs });
    }
    else if (action === 'advance') return Response.json(await seedDevice(env, url.origin, user.id, 1, true));
    else if (action === 'old' || action === 'match') return fixtureFetch(internal(url.origin, '/api/test/version/' + action, request.headers.get('Cookie') || ''), env, ctx);
    else if (action === 'delete-b') return worker.fetch(internal(url.origin, '/api/v3/devices/' + encodeURIComponent(user.id + '-b') + '/history', request.headers.get('Cookie') || '', 'DELETE'), env, ctx);
    else return new Response('Unknown action', { status: 404 });
  }
  return Response.json({ variant, failure, delayMs, action });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.origin !== env.APP_ORIGIN) return new Response('Local fixture only', { status: 403 });
    try {
      if (url.pathname === '/__online') return new Response(controls, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      if (url.pathname === '/__online-telemetry.js') {
        const documentVariant = url.searchParams.get('variant') === 'baseline' ? 'baseline' : 'candidate';
        return new Response('window.__cloudOnlineVariant=' + JSON.stringify(documentVariant) + ';\n' + telemetry,
          { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      if (url.pathname.startsWith('/api/test/online/')) return await control(request, env, ctx);
      const started = Date.now();
      if (url.pathname.startsWith('/api/v3/')) {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        const rejected = failure === 'api' || failure === 'view' && /^\/api\/v3\/(view(?:\/|$)|usage\/)/.test(url.pathname)
          || failure === 'trend' && url.pathname === '/api/v3/usage/local/trend';
        if (rejected) {
          requests.push({ path: url.pathname.replace(/\/view\/[^/]+\/renew/, '/view/:lease/renew'), method: request.method, started, ms: Date.now() - started, status: 503 });
          return Response.json({ error: { code: 'SYNTHETIC_OUTAGE', message: '合成云端临时不可用' } }, { status: 503, headers: { [SYNC_HEADER]: SYNC_VERSION } });
        }
      }
      const response = await fixtureFetch(request, env, ctx);
      if (url.pathname.startsWith('/api/')) {
        const path = url.pathname.replace(/\/sync\/read\/[^/]+\//, '/sync/read/:lease/').replace(/\/view\/[^/]+\/renew/, '/view/:lease/renew').replace(/\/devices\/[^/]+/, '/devices/:device');
        requests.push({ path, method: request.method, started, ms: Date.now() - started, status: response.status }); requests = requests.slice(-3000);
      }
      if (response.headers.get('Content-Type')?.includes('text/html') && !url.pathname.startsWith('/api/')) {
        const candidateHTML = await response.text();
        const html = (variant === 'baseline' ? baselineHTML : candidateHTML).replace('<head>',
          '<head><script src="/__online-telemetry.js?variant=' + variant + '"></script>');
        const headers = new Headers(response.headers); headers.delete('Content-Length'); headers.delete('Content-Encoding'); headers.set('Cache-Control', 'no-store');
        return new Response(html, { status: response.status, headers });
      }
      return response;
    } catch (error) { return Response.json({ error: { message: String(error) } }, { status: 500, headers: { [SYNC_HEADER]: SYNC_VERSION } }); }
  },
} satisfies ExportedHandler<Env>;
