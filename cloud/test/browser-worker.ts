// Local-only browser acceptance entry. Production always deploys apps/cloud/index.ts.
import worker from "../../apps/cloud/index.js";
import { SESSION_COOKIE, setCookie, sha256, token } from "../../modules/platform/worker/http.js";
import { sessionUser } from '../../apps/cloud/auth.js';
import {initialContext,normalizeTokens,projectRecord} from '../../modules/usage/normalize.js';
import { stableJson, EXTRACTOR_VERSION, V3_CONTENT_TYPE } from '../../modules/contracts/sync.js';
import { SYNC_HEADER, SYNC_VERSION } from '../../modules/contracts/cloud-version.js';

async function versionFixture(request:Request,env:Env):Promise<Response|null> {
  const url=new URL(request.url),base='/api/test/version';
  if(!url.pathname.startsWith(base))return null;
  if(url.pathname===base&&request.method==='GET')return new Response(`<!doctype html><meta charset="utf-8"><title>V3 version test</title>
    <h1>当前 v3 版本验收</h1><p>使用空数据库和合成日志，通过真实 v3 接口同步 72,000 Tokens。</p>
    <button id="start">创建未上报设备</button><button id="match">匹配版本并同步</button><button id="old">上报旧版本</button><a href="/" target="_blank">打开统计页面</a>
    <pre id="result"></pre><script>for(const action of ['start','match','old'])document.getElementById(action).onclick=async()=>{try{const response=await fetch('/api/test/version/'+action,{method:'POST'});document.getElementById('result').textContent=JSON.stringify(await response.json(),null,2);}catch(e){document.getElementById('result').textContent=String(e);}};</script>`,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
  if(request.method!=='POST'||request.headers.get('Origin')!==url.origin)return new Response('Same-origin POST required',{status:403});
  if(url.pathname===base+'/start'){
    const id='v3-browser-'+crypto.randomUUID(),session=token();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(id,id,'v3-fixture',Date.now()),
      env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at) VALUES(?,?,?,?,?)').bind(id,id,'合成 v3 采集设备',await sha256(token()),Date.now()),
      env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session),id,Date.now()+86400000),
    ]);
    return Response.json({created:true},{headers:{'Set-Cookie':setCookie(SESSION_COOKIE,session,86400)}});
  }
  const user=await sessionUser(request,env);if(!user.id.startsWith('v3-browser-'))return new Response('Synthetic user required',{status:403});
  const credential=token();await env.DB.prepare('UPDATE devices SET token_hash=? WHERE id=?').bind(await sha256(credential),user.id).run();
  const headers={Authorization:'Bearer '+credential,[SYNC_HEADER]:url.pathname===base+'/old'?'3.1.1':SYNC_VERSION};
  const handshake=await worker.fetch(new Request(url.origin+'/api/v3/collector/handshake',{method:'POST',headers}),env);
  if(url.pathname===base+'/old'||!handshake.ok)return handshake;
  const context={...initialContext('test-thread'),turn_id:'test-turn',model:'gpt-6-astra',cwd:'/synthetic/refactor'},record={type:'token_usage_record',timestamp:new Date().toISOString(),payload:{thread_id:'test-thread',turn_id:'test-turn',response_id:'test-response',usage:normalizeTokens({input_tokens:'70000',output_tokens:'2000',total_tokens:'72000'})}};
  if(!await env.DB.prepare('SELECT 1 FROM v3_receipts WHERE user_id=? LIMIT 1').bind(user.id).first()){
    // Include a real projected session record so task metadata and Agent queries can be accepted too.
    const sessionRecord=projectRecord({type:'session_meta',timestamp:record.timestamp,payload:{id:'test-thread',cwd:context.cwd,source:'cli'}}).record;
    const records=await Promise.all([sessionRecord,record].map(async(record,index)=>({observation_id:await sha256(stableJson([user.id,'source',1,index*100])),record_revision:1,source_id:'source',generation:1,locator:index*100,byte_end:(index+1)*100,prefix_hash:await sha256(stableJson(record)),session_trusted:true,origin:{kind:'execution' as const,device_id:user.id},context,record})));
    const batch={protocol:3,schema_version:1,extractor_version:EXTRACTOR_VERSION,collector_id:user.id,producer_epoch:'test-epoch',lane:'live',lane_seq:1,batch_id:crypto.randomUUID(),records_hash:await sha256(stableJson(records)),records,metadata:[],sources:[{source_id:'source',generation:1,kind:'session',from_cursor:0,to_cursor:200,snapshot_eof:200,context_hash:await sha256(stableJson(context)),context,replace_start:true,replace_end:true,generation_complete:true,available:true,trailing_bytes:0}]};
    const wire=await new Response(new Blob([stableJson(batch)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    return worker.fetch(new Request(url.origin+'/api/v3/ingest',{method:'POST',headers:{...headers,'Content-Type':V3_CONTENT_TYPE},body:wire}),env);
  }
  return handshake;
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      return new Response("Local fixture only", { status: 403 });
    const fixture = await versionFixture(request,env); if (fixture) return fixture;
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
