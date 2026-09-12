import { env } from 'cloudflare:workers';
import { expect,it } from 'vitest';
import { domain } from '../../modules/sync/publication/store.js';
import { createRead } from '../../modules/sync/reads/snapshots.js';
import { queryUsage } from '../../modules/analytics/worker/queries.js';

function traceReads(db:D1Database){
  let rows=0,maximum=0;
  const statement=(s:D1PreparedStatement):D1PreparedStatement=>new Proxy(s,{get(target,key){
    if(key==='bind')return(...args:unknown[])=>statement(target.bind(...args));
    if(key==='all')return async()=>{const result=await target.all();rows+=result.meta.rows_read;maximum=Math.max(maximum,result.results.length);return result;};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  return {db:new Proxy(db,{get(target,key){if(key==='prepare')return(sql:string)=>statement(target.prepare(sql));const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}),take(){const n=rows;rows=0;return n;},takeMaximum(){const n=maximum;maximum=0;return n;}};
}

it('queries 100k fixed-cut events through every shared usage view with bounded joins and indexed thread filters',async({annotate})=>{
  const user=crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(user,user,'query-scale',Date.now()).run();
  await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at) VALUES(?,?,?,?,?)').bind('device-a',user,'Fixture device','fixture-token',Date.now()).run();
  await env.DB.prepare('INSERT INTO v3_settings(user_id,revision,payload) VALUES(?,1,?)').bind(user,JSON.stringify({costEnabled:true,officialApiPricing:true,modelPrices:[{model:'gpt-5',input:'1',cachedInput:'0.5',cacheWrite:'2',output:'3',longContextThreshold:null,longInput:null,longCachedInput:null,longCacheWrite:null,longOutput:null}]})).run();
  const h=await domain(env.DB,user);
  await env.DB.prepare('UPDATE v3_sync_domains SET commit_seq=1 WHERE user_id=?').bind(user).run();
  // Keep many turns and projects: a single-project fixture can conceal a quadratic JSON join.
  await env.DB.batch([
    env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<39)
      INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,payload)
      SELECT ?,?,'project','source:source-'||v,1,1,'fixture',json_object('subtype','source','id','source-'||v,'logical_project_id','logical-'||v,'name','Source '||v,'root','/project/'||v) FROM n`).bind(user,h.active_epoch),
    env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<39)
      INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,payload)
      SELECT ?,?,'project','logical:'||v,1,1,'fixture',json_object('subtype','logical','id','logical-'||v,'project',json_object('name','Project '||v)) FROM n`).bind(user,h.active_epoch),
    env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<199)
      INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,thread_id,payload)
      SELECT ?,?,'thread','thread-'||v,1,1,'fixture','thread-'||v,json_object('title','Thread '||v,'source_project_id','source-'||(v%40),'source','cli') FROM n`).bind(user,h.active_epoch),
    env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<99999)
      INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,thread_id,at,origin_device_id,payload)
      SELECT ?,?,'event','event-'||printf('%06d',v),1,1,'fixture','thread-'||(v%200),'2026-09-10T12:00:00.000Z',CASE WHEN v%2=0 THEN 'device-a' ELSE 'device-b' END,
        json_object('thread_id','thread-'||(v%200),'turn_id','turn-'||(v/200),'at','2026-09-10T12:00:00.000Z','source_project_id','source-'||(v%40),'model','gpt-5','effort','high','kind','record','service_tier','standard','service_tier_source','record','input_tokens','80','cached_input_tokens','20','cache_write_input_tokens','0','output_tokens','20','reasoning_output_tokens','0','total_tokens','100','incomplete',0) FROM n`).bind(user,h.active_epoch),
  ]);
  const lease=await createRead(env.DB,user,'full',[]),traced=traceReads(env.DB);
  const samples:unknown[]=[];const run=async(route:string,params='')=>{const started=performance.now();
    const result=await queryUsage(traced.db,user,new URL('https://quota.esoren.com/api/v3/usage/'+route+'?lease_id='+lease.lease_id+params),route);
    samples.push({route,params,elapsed_ms:performance.now()-started});expect(result.meta.cut).toEqual(lease.cut);return result.data as any;
  };
  const summary=await run('local/summary');
  expect(summary).toMatchObject({eventCount:100000,threadCount:200,turnCount:100000,totalTokens:'10000000',inputTokens:'8000000',cachedInputTokens:'2000000',outputTokens:'2000000'});
  expect(summary.cost).toMatchObject({amount:'13.000000000000',complete:true});
  expect(traced.take(),'full summary must stay linear in event count').toBeLessThan(4_000_000);
  expect(await run('local/summary','&threadId=thread-0')).toMatchObject({eventCount:500,totalTokens:'50000'});
  expect(traced.take(),'thread summary must use the thread index').toBeLessThan(20000);
  expect(await run('local/trend','&bucket=day')).toMatchObject([{time:'2026-09-10',eventCount:100000,totalTokens:'10000000'}]);
  expect(traced.take()).toBeLessThan(6_000_000);
  const groups=await run('local/breakdown','&groupBy=project');
  expect(groups.total).toBe(40);expect(groups.items.every((p:any)=>p.eventCount===2500&&p.totalTokens==='250000'&&p.label.startsWith('Project '))).toBe(true);
  expect(traced.take()).toBeLessThan(4_000_000);
  traced.takeMaximum();
  const threads=await run('local/threads','&limit=5');expect(threads.total).toBe(200);expect(threads.items).toHaveLength(5);expect(threads.items.every((t:any)=>t.eventCount===500&&t.title.startsWith('Thread ')&&t.cost.amount==='0.065000000000')).toBe(true);
  expect(traced.takeMaximum(),'only the five selected thread costs may cross the D1 boundary').toBeLessThanOrEqual(5);
  expect(traced.take()).toBeLessThan(6_000_000);
  const turns=await run('local/turns','&limit=5');expect(turns.total).toBe(100000);expect(turns.items).toHaveLength(5);expect(turns.items.every((t:any)=>t.eventCount===1&&t.totalTokens==='100'&&t.composition[0].totalTokens==='100'&&t.cost.amount==='0.000130000000')).toBe(true);
  expect(traced.takeMaximum(),'100k unselected turn costs must stay out of the D1 result').toBeLessThanOrEqual(5);
  expect(traced.take()).toBeLessThan(8_000_000);
  const filters=await run('local/filters');expect(filters.projects).toHaveLength(40);expect(filters.models).toEqual(['gpt-5']);expect(filters.efforts).toEqual(['high']);expect(traced.take()).toBeLessThan(6_000_000);
  const scoped=await createRead(env.DB,user,'full',['device-a']),deviceSummary=await queryUsage(env.DB,user,new URL('https://quota.esoren.com/?lease_id='+scoped.lease_id),'local/summary');
  expect(deviceSummary.data).toMatchObject({eventCount:50000,threadCount:100,totalTokens:'5000000',cost:{amount:'6.500000000000',complete:true}});
  // A later project reorganization must never change the joins of this fixed view.
  await env.DB.batch([
    env.DB.prepare("UPDATE v3_entity_versions SET valid_to=2 WHERE user_id=? AND kind='project' AND entity_id='source:source-0'").bind(user),
    env.DB.prepare(`INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,payload) VALUES(?,?,'project','source:source-0',2,2,'next',?)`).bind(user,h.active_epoch,JSON.stringify({subtype:'source',id:'source-0',logical_project_id:'logical-1',name:'Moved source',root:'/project/0'})),
    env.DB.prepare('UPDATE v3_sync_domains SET commit_seq=2 WHERE user_id=?').bind(user),
  ]);
  expect(await run('local/summary','&project=logical-0')).toMatchObject({eventCount:2500,totalTokens:'250000'});
  const next=await createRead(env.DB,user,'full',[]),after=await queryUsage(env.DB,user,new URL('https://quota.esoren.com/?lease_id='+next.lease_id+'&project=logical-0'),'local/summary');
  expect(after.data).toMatchObject({eventCount:0,totalTokens:'0'});
await annotate(JSON.stringify({rows:100000,samples}),'performance');},60000);
