import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {domain} from '../../modules/sync/publication/store.js';
import {createPageRead} from '../../modules/sync/reads/snapshots.js';

const tables=['v3_entity_versions','v3_events','v3_aggregates','v3_aggregate_members','v3_commits'];
const guard=`NOT EXISTS(SELECT 1 FROM v3_read_leases l WHERE l.user_id=v.user_id AND l.epoch=v.epoch AND l.expires_at>?) AND NOT EXISTS(SELECT 1 FROM v3_jobs j WHERE j.user_id=v.user_id AND j.state IN('pending','running') AND json_extract(j.checkpoint,'$.epoch')=v.epoch)`;
const original=(table:string)=>`SELECT v.rowid FROM ${table} v JOIN v3_sync_domains h ON h.user_id=v.user_id WHERE v.epoch<>h.active_epoch AND ${guard} LIMIT 1000`;
// Exploration only: make each old-epoch range an explicit indexed seek from
// its domain. The lease/job guards are identical and ranges are disjoint.
const candidate=(table:string)=>`SELECT v.rowid FROM v3_sync_domains h CROSS JOIN ${table} v WHERE v.user_id=h.user_id AND v.epoch<h.active_epoch AND ${guard}
  UNION ALL SELECT v.rowid FROM v3_sync_domains h CROSS JOIN ${table} v WHERE v.user_id=h.user_id AND v.epoch>h.active_epoch AND ${guard} LIMIT 1000`;

it('checks the old-epoch cleanup scan on 100k current events and a few guarded old rows',async({task})=>{
  const user='cleanup-local-100k',count=100000,now=Date.now();
  await env.DB.prepare("INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,'synthetic cleanup probe',0)").bind(user,user).run();
  await domain(env.DB,user);await env.DB.prepare("UPDATE v3_sync_domains SET active_epoch='m-current' WHERE user_id=?").bind(user).run();
  await env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<?)
    INSERT INTO v3_events(user_id,epoch,event_id,revision,at,thread_id,payload)
    SELECT ?,'m-current','event-'||printf('%06d',v),1,'2026-09-13T00:00:00.000Z','thread-'||(v%250),json_object('total_tokens','7') FROM n`).bind(count-1,user).run();
  const plans=[];
  for(const table of tables)for(const [name,select,params] of [['original',original(table),[now]],['range-candidate',candidate(table),[now,now]]] as const){
    plans.push({table,name,sql:select,plan:(await env.DB.prepare('EXPLAIN QUERY PLAN DELETE FROM '+table+' WHERE rowid IN('+select+')').bind(...params).all()).results});
  }
  const samples=[];
  for(let round=0;round<3;round++)for(const name of (round%2?['range-candidate','original']:['original','range-candidate'])){
    const select=name==='original'?original('v3_events'):candidate('v3_events'),params=name==='original'?[now]:[now,now];
    const started=performance.now(),result=await env.DB.prepare('DELETE FROM v3_events WHERE rowid IN('+select+')').bind(...params).run(),elapsed_ms=performance.now()-started;
    expect(result.meta.changes).toBe(0);expect(result.meta.rows_written).toBe(0);
    samples.push({name,round,elapsed_ms,...result.meta});
    if(name==='original')expect(result.meta.rows_read).toBeGreaterThanOrEqual(count);
    else expect(result.meta.rows_read).toBeLessThan(100);
  }
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_events WHERE user_id=?').bind(user).first('n')).toBe(count);
  // Small correctness fixture, not another scale benchmark: both sides of the
  // active epoch, a live pinned epoch, and a private pending rebuild epoch.
  for(const epoch of ['a-deletable','a-pinned','z-deletable','z-private'])await env.DB.prepare(`INSERT INTO v3_events(user_id,epoch,event_id,revision,at,thread_id,payload) VALUES(?,?,'old-event',1,'2020-01-01T00:00:00.000Z','thread','{}')`).bind(user,epoch).run();
  const page=await createPageRead(env.DB,user);await env.DB.prepare("UPDATE v3_read_leases SET epoch='a-pinned' WHERE user_id=? AND lease_id=?").bind(user,page.lease_id).run();
  await env.DB.prepare(`INSERT INTO v3_jobs(user_id,job_id,kind,state,payload,checkpoint,created_at,updated_at)
    VALUES(?,'private-rebuild','rebuild','pending','{}','{"epoch":"z-private"}',0,0)`).bind(user).run();
  const expected=(await env.DB.prepare(original('v3_events')).bind(now).all<{rowid:number}>()).results.map(r=>r.rowid).sort((a,b)=>a-b);
  const actual=(await env.DB.prepare(candidate('v3_events')).bind(now,now).all<{rowid:number}>()).results.map(r=>r.rowid).sort((a,b)=>a-b);
  expect(actual).toEqual(expected);expect(actual).toHaveLength(2);
  const removed=await env.DB.prepare('DELETE FROM v3_events WHERE rowid IN('+candidate('v3_events')+')').bind(now,now).run();expect(removed.meta.changes).toBe(2);
  const remainingOld=(await env.DB.prepare("SELECT epoch FROM v3_events WHERE user_id=? AND epoch<>'m-current' ORDER BY epoch").bind(user).all<{epoch:string}>()).results.map(r=>r.epoch);
  expect(remainingOld).toEqual(['a-pinned','z-private']);
  Object.assign(task.meta,{cleanupEvidence:{count,table:'v3_events',current_epoch:'m-current',scale_scope:'Only v3_events has 100k rows; other four tables have EXPLAIN only',plans,samples,correctness:{current_events_preserved:count,matched_deletable:actual.length,deleted:removed.meta.changes,retained_old_epochs:remainingOld}}});
},30000);
