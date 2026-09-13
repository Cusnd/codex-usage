import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {cleanupVersions,createPageRead} from '../../modules/sync/reads/snapshots.js';

const tables=['v3_entity_versions','v3_events','v3_aggregates','v3_aggregate_members','v3_commits'];
async function owner(user:string){
  await env.DB.prepare("INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,'cleanup-test',0)").bind(user,user).run();
  await env.DB.prepare("INSERT INTO v3_sync_domains(user_id,active_epoch,updated_at) VALUES(?,'m-current',0)").bind(user).run();
}
async function seed(user:string,epoch:string,now:number,count=1){
  const prefix=`WITH RECURSIVE n(v) AS(SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<?) `;
  await env.DB.batch([
    env.DB.prepare(prefix+`INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,payload)
      SELECT ?,?,'event','row-'||v,1,1,'hash','{}' FROM n`).bind(count,user,epoch),
    env.DB.prepare(prefix+`INSERT INTO v3_events(user_id,epoch,event_id,revision,at,thread_id,payload)
      SELECT ?,?,'row-'||v,1,'2026-09-13T00:00:00.000Z','thread','{}' FROM n`).bind(count,user,epoch),
    env.DB.prepare(prefix+`INSERT INTO v3_aggregates(user_id,epoch,aggregate_key,payload)
      SELECT ?,?,'row-'||v,'{}' FROM n`).bind(count,user,epoch),
    env.DB.prepare(prefix+`INSERT INTO v3_aggregate_members(user_id,epoch,aggregate_key,kind,member_id,refs)
      SELECT ?,?,'all','thread','row-'||v,1 FROM n`).bind(count,user,epoch),
    env.DB.prepare(prefix+`INSERT INTO v3_commits(user_id,epoch,commit_seq,created_at,entity_count)
      SELECT ?,?,v,?,1 FROM n`).bind(count,user,epoch,now),
  ]);
  await env.DB.prepare(`INSERT INTO v3_changes(user_id,epoch,commit_seq,kind,entity_id,revision,hash,payload)
    SELECT user_id,epoch,commit_seq,'event','row-'||commit_seq,1,'hash','{}' FROM v3_commits WHERE user_id=? AND epoch=?`).bind(user,epoch).run();
}
async function pin(user:string,epoch:string,expiry:number){
  const lease=await createPageRead(env.DB,user);
  await env.DB.prepare('UPDATE v3_read_leases SET epoch=?,expires_at=? WHERE user_id=? AND lease_id=?').bind(epoch,expiry,user,lease.lease_id).run();return lease.lease_id;
}
async function epochs(table:string,user:string){return (await env.DB.prepare(`SELECT epoch FROM ${table} WHERE user_id=? ORDER BY epoch`).bind(user).all<{epoch:string}>()).results.map(r=>r.epoch);}

it('collects both old-epoch ranges in all five tables while preserving per-user lease and build pins',async()=>{
  const now=Date.now(),a='cleanup-owner-a',b='cleanup-owner-b';await owner(a);await owner(b);
  const seeded=['a-deletable','z-deletable','m-current','a-pinned','z-pending','a-running','z-expired'];
  for(const user of [a,b])for(const epoch of seeded)await seed(user,epoch,now);
  await pin(a,'a-pinned',now+60000);const expired=await pin(a,'z-expired',now-1);
  for(const [state,epoch] of [['pending','z-pending'],['running','a-running']])await env.DB.prepare(`INSERT INTO v3_jobs(user_id,job_id,kind,state,payload,checkpoint,created_at,updated_at)
    VALUES(?,?,'rebuild',?,'{}',?,0,0)`).bind(a,epoch,state,JSON.stringify({epoch})).run();
  await cleanupVersions(env.DB,now);
  for(const table of [...tables,'v3_changes']){
    expect(await epochs(table,a),table+' owner A').toEqual(['a-pinned','a-running','m-current','z-pending']);
    // Matching epoch names owned by B are not protected by A's leases/jobs.
    expect(await epochs(table,b),table+' owner B').toEqual(['m-current']);
  }
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_read_leases WHERE user_id=? AND lease_id=?').bind(a,expired).first('n')).toBe(0);
});

it('keeps the 1000-row deletion limit global across both ranges and all users for each table',async()=>{
  const now=Date.now(),a='limit-owner-a',b='limit-owner-b';await owner(a);await owner(b);
  await seed(a,'a-old',now,600);await seed(b,'z-old',now,600);
  await cleanupVersions(env.DB,now);
  for(const table of tables){
    expect(await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first('n'),table).toBe(200);
    expect(await env.DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).bind(a).first('n'),table+' lower range').toBe(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).bind(b).first('n'),table+' upper range').toBe(200);
  }
  // Deleting an old commit still cascades its matching changes, without
  // collecting commits outside this invocation's global 1000-row selection.
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_changes').first('n')).toBe(200);
});
