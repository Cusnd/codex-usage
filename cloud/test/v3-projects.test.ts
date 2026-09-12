import { env } from 'cloudflare:workers';
import { expect,it } from 'vitest';
import { initialContext } from '../../shared/usage-domain/normalize';
import { normalizeRemote } from '../../shared/usage-domain/projects';
import type { UploadBatch } from '../../shared/sync-v3';
import { stableJson } from '../../shared/sync-v3';
import { advanceHead,domain,endGuard,entityStatements,guard } from '../src/v3/store';
import { cloudSourceProjectId,performProjectOperation,prepareProjectDeletion,prepareProjectMetadata,projectView } from '../src/v3/projects';
import { createRead } from '../src/v3/snapshots';
import { queryUsage } from '../src/v3/queries';

type Actor={user:string;device:string;collector:string};
async function actor(user?:string):Promise<Actor>{const id=user||crypto.randomUUID(),device=crypto.randomUUID(),collector=crypto.randomUUID();if(!user)await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(id,id,'projects-test',Date.now()).run();await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at) VALUES(?,?,?,?,?)').bind(device,id,device,device,Date.now()).run();await env.DB.prepare('INSERT INTO v3_collectors(user_id,collector_id,device_id,created_at) VALUES(?,?,?,?)').bind(id,collector,device,Date.now()).run();return {user:id,device,collector};}
const repo=(path:string)=>normalizeRemote('https://github.com/'+path)!.key;
async function metadata(a:Actor,id:string,value:Record<string,unknown>,options:{thread?:string;trusted?:boolean;source?:string;generation?:number;complete?:boolean;record?:boolean}={}){
  const source=options.source||id,generation=options.generation||1,context={...initialContext(options.thread||'thread:'+id+':'+a.collector),source_project_id:id},complete=options.complete!==false;
  const b:UploadBatch={protocol:3,schema_version:1,extractor_version:2,collector_id:a.collector,producer_epoch:'epoch',lane:'live',lane_seq:1,batch_id:crypto.randomUUID(),records_hash:'0'.repeat(64),metadata:[{type:'project',source_project_id:id,value}],sources:[{source_id:source,generation,kind:'session',from_cursor:0,to_cursor:1,snapshot_eof:1,context_hash:'0'.repeat(64),context,replace_start:true,replace_end:complete,generation_complete:complete,available:true,trailing_bytes:0}],records:options.record===false?[]:[{observation_id:crypto.randomUUID(),record_revision:1,source_id:source,generation,locator:0,byte_end:1,prefix_hash:'0'.repeat(64),session_trusted:options.trusted!==false,context,origin:{device_id:a.device,kind:'execution'},record:null}]};
  const h=await domain(env.DB,a.user),prepared=await prepareProjectMetadata(env.DB,h,b,a.device),op=crypto.randomUUID(),active=await env.DB.prepare('SELECT generation FROM v3_sources WHERE user_id=? AND collector_id=? AND source_id=? AND active=1').bind(a.user,a.collector,source).first<{generation:number}>(),visible=!active||active.generation===generation||complete;
  await env.DB.batch([guard(env.DB,h,op),...visible?[env.DB.prepare('UPDATE v3_sources SET active=0 WHERE user_id=? AND collector_id=? AND source_id=?').bind(a.user,a.collector,source)]:[],env.DB.prepare(`INSERT INTO v3_sources(user_id,collector_id,source_id,generation,kind,cursor,snapshot_eof,context_hash,context,active,complete) VALUES(?,?,?,?,'session',1,1,?,?,?,?) ON CONFLICT(user_id,collector_id,source_id,generation) DO UPDATE SET active=excluded.active,complete=excluded.complete`).bind(a.user,a.collector,source,generation,'0'.repeat(64),stableJson(context),Number(visible),Number(complete)),...prepared.statements,...await entityStatements(env.DB,h,prepared.changes),advanceHead(env.DB,h,prepared.changes.length>0),endGuard(env.DB,a.user,op)]);
  return projectView(env.DB,a.user);
}
const operation=(user:string,body:Record<string,unknown>)=>performProjectOperation(env.DB,user,{operation_id:crypto.randomUUID(),...body});

it('namespaces repeated local IDs and merges only confirmed primary repositories across collectors',async()=>{
  const a=await actor(),b=await actor(a.user);await metadata(a,'same',{kind:'git',name:'A',root:'/a',repository:repo('org/repo'),confidence:'confirmed'});let view=await metadata(b,'same',{kind:'git',name:'B',root:'/b',repository:repo('org/other'),confidence:'confirmed'});
  expect(view.sources).toHaveLength(2);expect(new Set(view.sources.map(s=>s.id)).size).toBe(2);expect(view.projects).toHaveLength(2);
  view=await metadata(b,'same',{kind:'git',name:'B',root:'/b',repository:repo('org/repo'),confidence:'ambiguous'});expect(view.projects).toHaveLength(2);
  view=await metadata(b,'same',{kind:'git',name:'B',root:'/b',repository:repo('org/repo'),confidence:'confirmed'});expect(view.projects).toHaveLength(1);expect(view.projects[0].members).toHaveLength(2);expect(Object.values(view.aliases)).toContain(view.projects[0].id);
});
it('persists split anchors, leaves a late bridge independent, and recomputes its entire component',async()=>{
  const a=await actor(),b=await actor(a.user),c=await actor(a.user),d=await actor(a.user),git={kind:'git',repository:repo('team/repo'),confidence:'confirmed'};await metadata(a,'A',git);let v=await metadata(b,'B',git),idA=await cloudSourceProjectId(a.collector,'A'),idB=await cloudSourceProjectId(b.collector,'B');
  await operation(a.user,{action:'split',project_id:v.projects[0].id,groups:[{source_ids:[idA],name:'Manual A'},{source_ids:[idB],name:'Manual B'}]});
  v=await metadata(c,'C',git);const idC=await cloudSourceProjectId(c.collector,'C');expect(v.projects).toHaveLength(3);expect(v.projects.find(p=>p.members.includes(idC))!.manual).toBe(false);
  v=await metadata(d,'D',git);const idD=await cloudSourceProjectId(d.collector,'D'),bridge=v.projects.find(p=>p.members.includes(idC))!;
  expect(v.projects).toHaveLength(3);expect(bridge.members).toEqual([idC,idD].sort());expect(bridge.anchorIds).toHaveLength(2);expect(v.projects.filter(p=>p.manual).map(p=>p.name).sort()).toEqual(['Manual A','Manual B']);
  await metadata(a,'A',{...git,name:'Parser rename'});v=await projectView(env.DB,a.user);expect(v.projects.find(p=>p.members.includes(idA))!.name).toBe('Manual A');
  await operation(a.user,{action:'reset',project_ids:v.projects.filter(p=>p.manual).map(p=>p.id)});expect((await projectView(env.DB,a.user)).projects).toHaveLength(1);
});
it('uses trusted session evidence, ignores metadata thread claims, and withdraws replaced-generation links',async()=>{
  const a=await actor(),b=await actor(a.user);await metadata(a,'A',{kind:'app',name:'A',thread_ids:['shared']},{thread:'shared'});let v=await metadata(b,'B',{kind:'app',name:'B',thread_ids:['shared']},{thread:'shared',trusted:false});expect(v.projects).toHaveLength(2);
  v=await metadata(b,'B',{kind:'app',name:'B'},{thread:'shared'});expect(v.projects).toHaveLength(1);
  v=await metadata(b,'B',{kind:'app',name:'B'},{thread:'other',generation:2,complete:false});expect(v.projects).toHaveLength(1);
  v=await metadata(b,'B',{kind:'app',name:'B'},{thread:'other',generation:2,complete:true,record:false});expect(v.projects).toHaveLength(2);
});
it('pins names, members and aliases to immutable cuts across manual operations',async()=>{
  const a=await actor(),b=await actor(a.user);await metadata(a,'A',{name:'Alpha'});const before=await metadata(b,'B',{name:'Beta'}),lease=await createRead(env.DB,a.user,'full',[]),oldId=before.projects[1].id;
  const merged=await operation(a.user,{action:'merge',project_ids:before.projects.map(p=>p.id),name:'Chosen'});expect(merged.projects).toHaveLength(1);expect(merged.projects[0].name).toBe('Chosen');
  const frozen=await projectView(env.DB,a.user,lease.lease_id);expect(frozen.projects).toEqual(before.projects);expect(frozen.cut.organization_version).toBe(before.cut.organization_version);
  const active=await projectView(env.DB,a.user);expect(active.projects).toHaveLength(1);if(oldId!==active.projects[0].id)expect(active.aliases[oldId]).toBe(active.projects[0].id);
  await operation(a.user,{action:'rename',project_id:oldId,name:'Via alias'});expect((await projectView(env.DB,a.user)).projects[0].name).toBe('Via alias');
  await operation(a.user,{action:'rename',project_id:oldId,name:null});expect(['Alpha','Beta']).toContain((await projectView(env.DB,a.user)).projects[0].name);
});
it('makes operations idempotent, rejects changed replays and stale edits, and preserves unrelated choices',async()=>{
  const a=await actor(),view=await metadata(a,'A',{name:'Original'}),body={operation_id:crypto.randomUUID(),base_organization_version:view.cut.organization_version,action:'rename',project_id:view.projects[0].id,name:'Saved'};
  const result=await performProjectOperation(env.DB,a.user,body),head=await domain(env.DB,a.user);expect(await performProjectOperation(env.DB,a.user,body)).toEqual(result);expect((await domain(env.DB,a.user)).commit_seq).toBe(head.commit_seq);
  await expect(performProjectOperation(env.DB,a.user,{...body,name:'Changed'})).rejects.toMatchObject({code:'OPERATION_CONFLICT'});
  await expect(performProjectOperation(env.DB,a.user,{...body,operation_id:crypto.randomUUID()})).rejects.toMatchObject({code:'PROJECT_VERSION_CONFLICT'});
  expect((await projectView(env.DB,a.user)).projects[0].name).toBe('Saved');
});
it('rejects incomplete splits and makes local repository/App evidence collector scoped',async()=>{
  const a=await actor(),b=await actor(a.user);await metadata(a,'A',{kind:'git',name:'A',common_dir:'/same'});let v=await metadata(b,'B',{kind:'git',name:'B',common_dir:'/same'});expect(v.projects).toHaveLength(2);
  v=await metadata(a,'C',{kind:'git',name:'C',common_dir:'/same'});expect(v.projects).toHaveLength(2);const p=v.projects.find(p=>p.members.length===2)!;
  await expect(operation(a.user,{action:'split',project_id:p.id,groups:[{source_ids:[p.members[0]]},{source_ids:['missing']}]})).rejects.toMatchObject({code:'INVALID_PROJECT_PARTITION'});
  expect((await projectView(env.DB,a.user)).projects).toEqual(v.projects);
});
it('deletes only the selected collector sources while preserving surviving choices and revision history',async()=>{
  const a=await actor(),b=await actor(a.user);await metadata(a,'A',{name:'A'});const view=await metadata(b,'B',{name:'B'});await operation(a.user,{action:'merge',project_ids:view.projects.map(p=>p.id),name:'Keep name'});
  const h=await domain(env.DB,a.user),prepared=await prepareProjectDeletion(env.DB,h,a.device),op=crypto.randomUUID();await env.DB.batch([guard(env.DB,h,op),...prepared.statements,...await entityStatements(env.DB,h,prepared.changes),advanceHead(env.DB,h,prepared.changes.length>0),endGuard(env.DB,a.user,op)]);
  const after=await projectView(env.DB,a.user);expect(after.sources).toHaveLength(1);expect(after.sources[0].device_id).toBe(b.device);expect(after.projects[0].name).toBe('Keep name');expect(after.projects[0].manual).toBe(true);
  expect(await env.DB.prepare("SELECT COUNT(*) FROM v3_entity_versions WHERE user_id=? AND kind='project' AND payload IS NULL").bind(a.user).first<number>('COUNT(*)')).toBeGreaterThan(0);
});
it('serializes racing organization writers so stale CAS cannot publish partial project membership',async()=>{
  const a=await actor(),view=await metadata(a,'A',{name:'A'}),base=view.cut.organization_version,id=view.projects[0].id;
  const results=await Promise.allSettled(['One','Two'].map(name=>operation(a.user,{action:'rename',project_id:id,name,base_organization_version:base})));expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  const after=await projectView(env.DB,a.user);expect(['One','Two']).toContain(after.projects[0].name);expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_apply_guards WHERE user_id=?').bind(a.user).first<number>('n')).toBe(0);
});

it('skips unchanged increment organization writes but incorporates changed metadata and new trusted session links',async()=>{
  const a=await actor(),b=await actor(a.user),value={kind:'app',name:'A'};
  await metadata(a,'A',value,{thread:'session-A'});const before=await metadata(b,'B',{kind:'app',name:'B'},{thread:'session-B'});
  const packet=(name:string,thread:string):UploadBatch=>{const context={...initialContext(thread),source_project_id:'A'};return {protocol:3,schema_version:1,extractor_version:2,collector_id:a.collector,producer_epoch:'epoch',lane:'live',lane_seq:2,batch_id:crypto.randomUUID(),records_hash:'0'.repeat(64),metadata:[{type:'project',source_project_id:'A',value:{...value,name}}],sources:[{source_id:'A',generation:1,kind:'session',from_cursor:1,to_cursor:2,snapshot_eof:2,context_hash:'0'.repeat(64),context,replace_start:false,replace_end:false,generation_complete:true,available:true,trailing_bytes:0}],records:[{observation_id:crypto.randomUUID(),record_revision:1,source_id:'A',generation:1,locator:1,byte_end:2,prefix_hash:'0'.repeat(64),session_trusted:true,context,origin:{device_id:a.device,kind:'execution'},record:null}]};};
  const head=await domain(env.DB,a.user),unchanged=await prepareProjectMetadata(env.DB,head,packet('A','session-A'),a.device);
  expect(unchanged).toEqual({statements:[],changes:[],organizationChanged:false});
  expect((await projectView(env.DB,a.user)).projects).toEqual(before.projects);
  const changed=await prepareProjectMetadata(env.DB,head,packet('Renamed','session-B'),a.device),op=crypto.randomUUID();
  expect(changed.organizationChanged).toBe(true);
  await env.DB.batch([guard(env.DB,head,op),...changed.statements,...await entityStatements(env.DB,head,changed.changes),advanceHead(env.DB,head,true),endGuard(env.DB,a.user,op)]);
  const after=await projectView(env.DB,a.user);expect(after.projects).toHaveLength(1);expect(after.sources.find(s=>s.local_source_id==='A').name).toBe('Renamed');
  const repeat=await prepareProjectMetadata(env.DB,await domain(env.DB,a.user),packet('Renamed','session-B'),a.device);expect(repeat.statements).toHaveLength(0);expect(repeat.changes).toHaveLength(0);
});

it('maps the original usage API through the same project cut, resolves old aliases, and keeps device subsets additive',async()=>{
  const a=await actor(),b=await actor(a.user);await metadata(a,'A',{name:'A'});const before=await metadata(b,'B',{name:'B'}),sourceA=await cloudSourceProjectId(a.collector,'A'),sourceB=await cloudSourceProjectId(b.collector,'B');
  const h=await domain(env.DB,a.user),op=crypto.randomUUID(),changes=[{actor:a,source:sourceA,n:'100'},{actor:b,source:sourceB,n:'200'}].map((r,i)=>({kind:'event' as const,id:'test-event:'+i,revision:1,at:'2026-09-10T12:00:00Z',thread_id:'usage-thread:'+i,origin_device_id:r.actor.device,value:{event_id:'test-event:'+i,thread_id:'usage-thread:'+i,turn_id:'turn',response_id:'response:'+i,at:'2026-09-10T12:00:00Z',project:'/original/'+i,source_project_id:r.source,model:'gpt-5',effort:null,kind:'record',input_tokens:r.n,cached_input_tokens:'0',cache_write_input_tokens:'0',output_tokens:'0',reasoning_output_tokens:'0',total_tokens:r.n,incomplete:false,origin_device_id:r.actor.device}}));
  await env.DB.batch([guard(env.DB,h,op),...await entityStatements(env.DB,h,changes),advanceHead(env.DB,h,true),endGuard(env.DB,a.user,op)]);
  const frozen=await createRead(env.DB,a.user,'full',[]),originalA=before.projects.find(p=>p.members.includes(sourceA))!.id;
  const summary=async(project?:string,lease?:string,device?:string)=>{const url=new URL('https://quota.esoren.com/api/v3/usage/local/summary');if(project)url.searchParams.set('project',project);if(lease)url.searchParams.set('lease_id',lease);if(device)url.searchParams.append('deviceIds',device);return (await queryUsage(env.DB,a.user,url,'local/summary')).data as any;};
  expect((await summary(originalA,frozen.lease_id)).totalTokens).toBe('100');
  const merged=await operation(a.user,{action:'merge',project_ids:before.projects.map(p=>p.id),name:'Together'}),logical=merged.projects[0].id;
  expect((await summary(logical)).totalTokens).toBe('300');expect((await summary(originalA)).totalTokens).toBe('300');expect((await summary(originalA,frozen.lease_id)).totalTokens).toBe('100');
  expect((await summary(logical,undefined,a.device)).totalTokens).toBe('100');expect((await summary(logical,undefined,b.device)).totalTokens).toBe('200');expect((await summary()).totalTokens).toBe('300');
  const searchUrl=new URL('https://quota.esoren.com/api/v3/usage/local/threads?q=Together');expect(((await queryUsage(env.DB,a.user,searchUrl,'local/threads')).data as any).total).toBe(2);
  searchUrl.searchParams.set('lease_id',frozen.lease_id);expect(((await queryUsage(env.DB,a.user,searchUrl,'local/threads')).data as any).total).toBe(0);
});
