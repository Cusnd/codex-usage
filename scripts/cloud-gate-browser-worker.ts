// Local CUA fixture only. Production deploys apps/cloud/index.ts.
import browserWorker from '../cloud/test/browser-worker.js';
import { sessionUser } from '../apps/cloud/auth.js';
import { SYNC_HEADER, SYNC_VERSION } from '../modules/contracts/cloud-version.js';

let temporaryFailure = false;
let legacyBootstrap = false;
let entityDelayMs = 0;
const controls = `<!doctype html><meta charset="utf-8"><title>Cloud gate acceptance fixture</title>
<h1>云端门控本地验收</h1><p>真实 Workerd/D1 与合成 72K Tokens；me 和 compatibility 每次固定增加 120 ms。</p>
<button data-action="start">创建新合成用户</button><button data-action="match">同步匹配版本</button>
<button data-action="old">上报旧协议</button><button data-action="expire">撤销当前登录会话</button>
<button data-action="fail">兼容查询返回 503</button><button data-action="recover">恢复兼容查询</button>
<button data-action="legacy">模拟旧服务器不含 bootstrap</button><button data-action="modern">恢复 bootstrap</button>
<button data-action="slow-entities">实体下载延迟 2 秒</button><button data-action="normal-entities">恢复实体下载速度</button>
<a href="/" target="_blank">打开云端面板</a><pre id="result"></pre>
<script>for(const b of document.querySelectorAll('button'))b.onclick=async()=>{const a=b.dataset.action;const path=['start','match','old'].includes(a)?'/api/test/version/':'/api/test/gate/';try{const r=await fetch(path+a,{method:'POST'});document.getElementById('result').textContent=JSON.stringify({status:r.status,body:await r.json()},null,2);}catch(e){document.getElementById('result').textContent=String(e);}};</script>`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return new Response('Local fixture only', { status: 403 });
    if (url.pathname === '/api/test/cache-checks' && request.method === 'GET') return new Response(
      '<!doctype html><meta charset="utf-8"><title>Cloud IndexedDB regression checks</title><script type="module" src="/assets/cache-checks.js"></script>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (url.pathname === '/api/test/gate' && request.method === 'GET') return new Response(controls, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
    if (url.pathname.startsWith('/api/test/gate/')) {
      if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) return new Response('Same-origin POST required', { status: 403 });
      const user = await sessionUser(request, env);
      if (!user.id.startsWith('v3-browser-')) return new Response('Synthetic user required', { status: 403 });
      if (url.pathname.endsWith('/expire')) await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id).run();
      else if (url.pathname.endsWith('/fail')) temporaryFailure = true;
      else if (url.pathname.endsWith('/recover')) temporaryFailure = false;
      else if (url.pathname.endsWith('/legacy')) legacyBootstrap = true;
      else if (url.pathname.endsWith('/modern')) legacyBootstrap = false;
      else if (url.pathname.endsWith('/slow-entities')) entityDelayMs = 2000;
      else if (url.pathname.endsWith('/normal-entities')) entityDelayMs = 0;
      else return new Response('Unknown action', { status: 404 });
      return Response.json({ temporaryFailure, legacyBootstrap, entityDelayMs, expired: url.pathname.endsWith('/expire') });
    }
    if (['/api/v3/me', '/api/v3/compatibility'].includes(url.pathname)) await new Promise(resolve => setTimeout(resolve, 120));
    if (entityDelayMs && /^\/api\/v3\/sync\/read\/[^/]+\/entities$/.test(url.pathname)) {
      const user = await sessionUser(request, env);
      if (user.id.startsWith('v3-browser-')) await new Promise(resolve => setTimeout(resolve, entityDelayMs));
    }
    if (url.pathname === '/api/v3/compatibility' && temporaryFailure) return Response.json({ error: { message: 'Synthetic transient outage' } }, {
      status: 503, headers: { [SYNC_HEADER]: SYNC_VERSION },
    });
    if (url.pathname === '/api/v3/me' && legacyBootstrap) {
      url.searchParams.delete('bootstrap'); request = new Request(url, request);
    }
    return browserWorker.fetch(request, env, ctx);
  },
};
