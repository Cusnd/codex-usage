import {env} from 'cloudflare:workers';
import {it,expect} from 'vitest';
import worker from '../../apps/cloud/index.js';
import {MatchingRequest} from './matching-build.js';
import {fixture} from './read-api-fixture.js';
import {call,origin,actor} from './performance-fixture.js';
import {instrumentD1} from './d1-performance.js';
import {createPageRead} from '../../modules/sync/reads/snapshots.js';
import {queryUsage} from '../../modules/analytics/worker/queries.js';
import {cloudProjectKinds} from '../../modules/analytics/worker/project-kinds.js';
import {getRead} from '../../modules/sync/reads/snapshots.js';
import {projectView} from '../../modules/organization/worker/projects.js';
import {SESSION_COOKIE} from '../../modules/platform/worker/http.js';

const queryUrl=(lease:string,params:Record<string,string>={})=>new URL(origin+'/?'+new URLSearchParams({lease_id:lease,...params}));

it('POST query preserves GET results and returns only current response identities',async()=>{
  const {a}=await fixture(1000),lease=await createPageRead(env.DB,a.user),params={lease_id:lease.lease_id,groupBy:'project',limit:5};
  const post=await call(a,'/api/v3/usage/query?route=local/breakdown','POST',params),get=await call(a,'/api/v3/usage/local/breakdown?'+new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)])));
  expect(post.status).toBe(200);const value=await post.json<any>();expect(value).toEqual(await get.json());
  expect(value.data.items).toHaveLength(5);expect(value.meta.projectLabels).toHaveLength(5);
  expect(value.meta.projectLabels.map((label:any)=>label.id).sort()).toEqual(value.data.items.map((row:any)=>row.key).sort());
  expect(value.meta.projectLabels.every((label:any)=>label.name&&label.kind==='app')).toBe(true);
  const threads=await queryUsage(env.DB,a.user,queryUrl(lease.lease_id,{limit:'3'}),'local/threads');
  expect(threads.meta.projectLabels.map(label=>label.id).sort()).toEqual([...new Set((threads.data as any).items.map((row:any)=>row.project))].sort());
  const view=await projectView(env.DB,a.user,lease.lease_id);expect(view.projects.length).toBeGreaterThan(value.meta.projectLabels.length);
  const sourceFilter=await queryUsage(env.DB,a.user,queryUrl(lease.lease_id,{project:'s0'}),'local/summary');
  expect((sourceFilter.data as any).totalTokens).toBe('10000');expect(sourceFilter.meta.projectLabels).toEqual([{id:'l:s0',name:'Session title 0',kind:'session'},{id:'s0',name:'Session title 0',kind:'session'}]);
});

it('overview shares compact scope and trend while filters can omit the project directory',async()=>{
  const {a}=await fixture(1000),lease=await createPageRead(env.DB,a.user),m=instrumentD1(env.DB);
  const overview=await queryUsage(m.db,a.user,queryUrl(lease.lease_id,{bucket:'auto'}),'local/overview');
  expect(overview.meta.projectLabels).toEqual([]);expect((overview.data as any).metrics.totalTokens).toBe('1000000');
  expect((overview.data as any).scope).toMatchObject({projectCount:32,projectlessChatCount:20,unresolvedChatCount:0});
  expect((overview.data as any).bucket).toBe('month');expect((overview.data as any).trend.reduce((n:bigint,row:any)=>n+BigInt(row.totalTokens),0n)).toBe(1000000n);
  expect(m.trace.filter(row=>row.sql.includes('_digits')).length).toBe(1);
  const scope=await queryUsage(env.DB,a.user,queryUrl(lease.lease_id),'local/scope-summary');expect(scope.data).toEqual((overview.data as any).scope);
  const empty=await queryUsage(env.DB,a.user,queryUrl(lease.lease_id,{model:'missing'}),'local/overview');expect((empty.data as any).scope).toEqual({firstAt:null,lastAt:null,projectCount:0,projectlessChatCount:0,unresolvedChatCount:0});
  const filters=await call(a,'/api/v3/usage/query?route=local/filters','POST',{lease_id:lease.lease_id,projects:false});expect(filters.status).toBe(200);const data=await filters.json<any>();expect(data.data.projects).toEqual([]);expect(data.data.models).toHaveLength(3);expect(data.meta.projectLabels).toEqual([]);
});

it('project options search session titles, paginate on the backend and ignore the selected project',async()=>{
  const {a}=await fixture(1000),lease=await createPageRead(env.DB,a.user);
  const first=await queryUsage(env.DB,a.user,queryUrl(lease.lease_id,{limit:'5',project:'l:s0'}),'local/project-options');
  expect((first.data as any).total).toBe(52);expect((first.data as any).items).toHaveLength(5);expect(first.meta.projectLabels).toHaveLength(6);
  const second=await queryUsage(env.DB,a.user,queryUrl(lease.lease_id,{limit:'5',offset:'5'}),'local/project-options');
  expect((second.data as any).items.some((item:any)=>(first.data as any).items.some((before:any)=>before.id===item.id))).toBe(false);
  const search=await queryUsage(env.DB,a.user,queryUrl(lease.lease_id,{q:'Session title 0'}),'local/project-options');
  expect(search.data).toEqual({items:[{id:'l:s0',name:'Session title 0',kind:'session'}],limit:50,offset:0,total:1});
  const outside=await queryUsage(env.DB,a.user,queryUrl(lease.lease_id,{offset:'1000'}),'local/project-options');expect((outside.data as any).total).toBe(52);expect((outside.data as any).items).toEqual([]);
});

it('read query requires authenticated same-origin JSON and rejects oversize, unknown routes and ID arrays',async()=>{
  const a=await actor();
  const unauth=await worker.fetch(new MatchingRequest(origin+'/api/v3/usage/query?route=local/summary',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}),env);expect(unauth.status).toBe(401);
  const wrongOrigin=await worker.fetch(new MatchingRequest(origin+'/api/v3/usage/query?route=local/summary',{method:'POST',headers:{Origin:'https://other.invalid',Cookie:SESSION_COOKIE+'='+a.session,'Content-Type':'application/json'},body:'{}'}),env);expect(wrongOrigin.status).toBe(403);
  expect((await call(a,'/api/v3/usage/query?route=local/summary','POST',{q:'x'.repeat(65536)})).status).toBe(413);
  expect((await call(a,'/api/v3/usage/query?route=local/summary','POST',{ids:['a','b']})).status).toBe(400);
  expect((await call(a,'/api/v3/usage/query?route=local/summary','POST',{project:['a','b']})).status).toBe(400);
  expect((await call(a,'/api/v3/usage/query?route=local/summary','POST',{deviceIds:Array(101).fill('d')})).status).toBe(400);
  expect((await call(a,'/api/v3/usage/query?route=admin/delete','POST',{})).status).toBe(400);
  expect((await call(a,'/api/v3/usage/query?route=local/summary&route=local/trend','POST',{})).status).toBe(400);
});

it('classification retains full logical membership at the cut and bounds matched-range planning',async()=>{
  const {a,h}=await fixture(1000);
  // The selected session's logical project is manually merged with an App source lacking events.
  await env.DB.batch([
    env.DB.prepare("UPDATE v3_entity_versions SET payload=json_set(payload,'$.project.members',json('[\"s0\",\"unused-app\"]')) WHERE user_id=? AND kind='project' AND entity_id='logical:l:s0'").bind(a.user),
    env.DB.prepare("INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,payload) VALUES(?,?,'project','source:unused-app',1,1,'fixture',?)").bind(a.user,h.active_epoch,JSON.stringify({subtype:'source',id:'unused-app',logical_project_id:'l:s0',kind:'app',name:'No events'})),
  ]);
  const lease=await createPageRead(env.DB,a.user),read=await getRead(env.DB,a.user,lease.lease_id,'metadata');
  const selected=await queryUsage(env.DB,a.user,queryUrl(lease.lease_id,{project:'l:s0'}),'local/scope-summary');expect(selected.data).toMatchObject({projectCount:1,projectlessChatCount:0,unresolvedChatCount:0});
  expect(cloudProjectKinds(read,{from:'2000-01-01T00:00:00Z',to:'2026-09-13T00:00:00Z'}).sql).not.toContain('selected AS');
  expect(cloudProjectKinds(read,{from:'2026-09-01T00:00:00Z',to:'2026-09-13T00:00:00Z'}).sql).toContain('selected AS');
});

it('frozen identity and final deletion guard remain intact after combining page queries',async()=>{
  const {a}=await fixture(1000),lease=await createPageRead(env.DB,a.user);
  await env.DB.batch([
    env.DB.prepare("UPDATE v3_entity_versions SET valid_to=2 WHERE user_id=? AND kind='thread' AND entity_id='t0'").bind(a.user),
    env.DB.prepare("INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,payload) SELECT user_id,epoch,kind,entity_id,2,2,'new',json_set(payload,'$.title','New title') FROM v3_entity_versions WHERE user_id=? AND kind='thread' AND entity_id='t0'").bind(a.user),
    env.DB.prepare('UPDATE v3_sync_domains SET commit_seq=2 WHERE user_id=?').bind(a.user),
  ]);
  const frozen=await queryUsage(env.DB,a.user,queryUrl(lease.lease_id,{project:'l:s0'}),'local/summary');expect(frozen.meta.projectLabels).toEqual([{id:'l:s0',name:'Session title 0',kind:'session'}]);
  let injected=false;
  const db=new Proxy(env.DB,{get(target,key){if(key==='prepare')return(sql:string)=>{const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(s,k){if(k==='bind')return(...args:unknown[])=>wrap(s.bind(...args));if(k==='all')return async()=>{const result=await s.all();if(sql.includes("SELECT payload FROM versions WHERE kind='project' AND entity_id IN(SELECT 'source:'")&&!injected){injected=true;await env.DB.prepare('UPDATE v3_sync_domains SET deletion_version=deletion_version+1 WHERE user_id=?').bind(a.user).run();}return result;};const value=Reflect.get(s,k);return typeof value==='function'?value.bind(s):value;}});return wrap(target.prepare(sql));};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  await expect(queryUsage(db,a.user,queryUrl(lease.lease_id,{groupBy:'project',limit:'1'}),'local/breakdown')).rejects.toMatchObject({code:'BASELINE_REQUIRED'});expect(injected).toBe(true);
});
