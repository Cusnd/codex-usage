// Local-only browser acceptance entry. Production always deploys src/index.ts.
import worker from "../src/index";
import { SESSION_COOKIE, setCookie, sha256, token } from "../src/http";
import { sessionUser } from '../src/auth';
import { domain } from '../src/v3/store';
import { advanceJobs } from '../src/v3/jobs';
import { stableJson } from '../../shared/sync-v3';

async function legacyFixture(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/test/legacy')) return null;
  if (url.pathname === '/api/test/legacy' && request.method === 'GET') return new Response(`<!doctype html><meta charset="utf-8"><title>Local legacy migration fixture</title>
    <h1>本地完整历史迁移验收</h1><p>每次准备创建新的隔离合成用户：3 个会话、60 条记录、72,000 Tokens；迁移任务暂时暂停。</p>
    <button id="start">准备完整旧版历史</button> <button id="finish">完成后台迁移</button> <a href="/" target="_blank">打开统计页面</a>
    <pre id="result"></pre><script>for(const action of ['start','finish'])document.getElementById(action).onclick=async()=>{const result=document.getElementById('result');result.textContent='处理中…';try{const response=await fetch('/api/test/legacy/'+action,{method:'POST'});result.textContent=JSON.stringify(await response.json(),null,2);}catch(e){result.textContent=String(e);}};</script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) return new Response('Local same-origin POST required', { status: 403 });
  if (url.pathname === '/api/test/legacy/start') {
    const user = 'legacy-browser-fixture-' + crypto.randomUUID(), device = crypto.randomUUID(), at = new Date(Date.now() - 3600_000).toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users(id,github_id,login,created_at,settings) VALUES(?,?,?,?,?)').bind(user,user,'legacy-browser-fixture',Date.now(),stableJson({ localInterval: 0, accountInterval: 0, timezoneMode: 'manual', timezone: 'UTC' })),
      env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at,protocol,collected_at,received_at,total_threads,initial_complete) VALUES(?,?,?,?,?,2,?,?,3,1)').bind(device,user,'Synthetic legacy device',await sha256(token()),Date.now(),at,Date.now()),
    ]);
    for (let i = 0; i < 3; i++) {
      const thread = { id: 'legacy-session-' + i, title: '完整历史演示 ' + (i + 1), titleUpdatedAt: null, project: '/fixture/legacy-project', source: 'cli', parentId: null, subagentParentId: null, forkedFromId: null };
      const manifest = { schemaVersion: 2, datasetId: 'fixture-dataset', thread, revision: 1, parserVersion: 1, collectedAt: at, eventCount: 20, chunkCount: 1, contentHash: '0'.repeat(64) };
      await env.DB.batch([
        env.DB.prepare("INSERT INTO usage_revisions(user_id,device_id,dataset_id,thread_id,revision,parser_version,collected_at,manifest,received_at,committed) VALUES(?,?,'fixture-dataset',?,1,1,?,?,?,1)").bind(user,device,thread.id,at,stableJson(manifest),Date.now()),
        env.DB.prepare("INSERT INTO usage_records(user_id,device_id,dataset_id,thread_id,revision,event_key,turn_id,response_id,at,project,model,kind,incomplete,input_tokens,output_tokens,total_tokens) SELECT ?,?,'fixture-dataset',?,1,value,'turn-'||value,?||'-'||value,?,?,'gpt-5','record',0,1000,200,1200 FROM json_each(?)").bind(user,device,thread.id,thread.id,at,thread.project,stableJson(Array.from({ length: 20 }, (_, j) => thread.id + '-event-' + j))),
        env.DB.prepare("INSERT INTO usage_heads(user_id,device_id,dataset_id,thread_id,revision) VALUES(?,?,'fixture-dataset',?,1)").bind(user,device,thread.id),
      ]);
    }
    await domain(env.DB,user);
    await env.DB.prepare("UPDATE v3_jobs SET next_attempt_at=? WHERE user_id=? AND job_id='legacy-migrate'").bind(Date.now()+86400000,user).run();
    const session = token(); await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session),user,Date.now()+86400000).run();
    return Response.json({ fixture: true, user, expected: { threads: 3, events: 60, totalTokens: '72000' }, migration: 'paused', stats: '/' }, { headers: { 'Set-Cookie': setCookie(SESSION_COOKIE,session,86400) } });
  }
  if (url.pathname === '/api/test/legacy/finish') {
    const user = await sessionUser(request,env); if (!user.id.startsWith('legacy-browser-fixture-')) return new Response('Start this fixture first', { status: 409 });
    await env.DB.prepare("UPDATE v3_jobs SET next_attempt_at=0 WHERE user_id=? AND job_id='legacy-migrate'").bind(user.id).run();
    await advanceJobs(env.DB,{ user: user.id, maxSteps: 40, budgetMs: 8000 });
    const state = await domain(env.DB,user.id);
    const events = await env.DB.prepare("SELECT COUNT(*) count,CAST(SUM(json_extract(payload,'$.total_tokens')) AS TEXT) total FROM v3_events WHERE user_id=? AND epoch=?").bind(user.id,state.active_epoch).first();
    return Response.json({ fixture: true, complete: state.mode==='ready'&&!state.legacy_baseline_pending, state, events });
  }
  return new Response('Not found', { status: 404 });
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      return new Response("Local fixture only", { status: 403 });
    const fixture = await legacyFixture(request,env); if (fixture) return fixture;
    if (url.pathname === "/auth/github") {
      const id = "browser-fixture-user";
      await env.DB.prepare(
        "INSERT OR IGNORE INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)",
      )
        .bind(id, "synthetic-browser-user", "browser-fixture", Date.now())
        .run();
      const session = token();
      await env.DB.prepare(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      )
        .bind(await sha256(session), id, Date.now() + 86400000)
        .run();
      const returnTo = url.searchParams.get("returnTo");
      return new Response(null, {
        status: 302,
        headers: {
          "Set-Cookie": setCookie(SESSION_COOKIE, session, 86400),
          Location:
            url.origin +
            (returnTo && /^\/bind\?code=[A-Z2-9-]+$/.test(returnTo)
              ? returnTo
              : "/"),
        },
      });
    }
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
