import { sessionUser } from '../auth';
import { deviceAuth } from '../devices';
import { accountViews } from '../usage-query';
import { fail, HttpError, json, readJson, requireJson, requireSameOrigin } from '../http';
import { type EntityKind } from '../../../shared/sync-v3';
import { acknowledge, assertWritableDevice, currentDevice, cutOf, domain, endGuard, guard, readAcknowledgement, receive, receipt } from './store';
import { readUpload } from './codec';
import { advanceJobs } from './jobs';
import { changes, createRead, entities, getRead, manifest } from './snapshots';
import { queryUsage } from './queries';
import { deviceViews } from './devices';
import { projectRoute } from './projects';
import { usageSyncRoute } from '../usage-sync';
import { updateSettings } from './settings';
import { SyncTiming } from './timing';
import { resolveReadSettings } from './timezone';
import { originRoute } from './origins';
import {prepareLegacySources,validLegacyPreparation} from './legacy-staging';

const ownKeys=(v:unknown,allowed:string[],required:string[]=[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(v,k));
export async function syncStatus(db:D1Database,user:string) {
  const h=await domain(db,user),devices=await deviceViews(db,user);
  const sources=(await db.prepare(`SELECT c.device_id,s.collector_id,s.source_id,s.generation,s.cursor,s.snapshot_eof,s.complete,s.active,s.available,s.trailing_bytes FROM v3_sources s JOIN v3_collectors c USING(user_id,collector_id) WHERE s.user_id=? ORDER BY c.device_id,s.collector_id,s.source_id,s.generation`).bind(user).all()).results;
  const pending=(await db.prepare("SELECT device_id,status,COUNT(*) count FROM v3_receipts WHERE user_id=? AND status<>'applied' GROUP BY device_id,status").bind(user).all()).results;
  const jobs=(await db.prepare("SELECT job_id,kind,state,error_code,attempts,updated_at,json_extract(checkpoint,'$.phase') phase FROM v3_jobs WHERE user_id=? AND state IN('pending','running','failed') ORDER BY created_at LIMIT 100").bind(user).all()).results;
  return {user_id:user,cut:cutOf(h),mode:h.mode,baseline_ready:h.mode==='ready'&&!h.legacy_baseline_pending,devices,coverage:{sources,pending_batches:pending},jobs,updated_at:new Date(h.updated_at).toISOString()};
}
export async function v3Route(request:Request,env:Env,path:string):Promise<Response|null> {
  if(!path.startsWith('/api/v3/'))return null;
  const url=new URL(request.url);
  if(path==='/api/v3/accounts/observations'&&request.method==='PUT')return usageSyncRoute(request,env,'/api/v2/sync/accounts');
  if(path==='/api/v3/legacy/prepare'&&request.method==='POST'){
    const device=assertWritableDevice(await deviceAuth(request,env));requireJson(request);const b=await readJson(request,65536);
    if(!validLegacyPreparation(b))return fail(400,'INVALID_LEGACY_PREPARATION','迁移来源映射无效。');
    const ready=await prepareLegacySources(env.DB,device,b);if(!ready)await advanceJobs(env.DB,{user:device.user_id,maxSteps:2,budgetMs:4000});
    return json({status:ready?'ready':'pending'},ready?200:202);
  }
  if(path==='/api/v3/sync/status'&&request.method==='PUT'){
    const auth=await deviceAuth(request,env),device=await currentDevice(env.DB,auth.user_id,auth.id);requireJson(request);const b=await readJson(request,2048) as Record<string,any>;
    if(!ownKeys(b,['collectedAt','totalThreads','initialComplete','error'],['collectedAt','totalThreads','initialComplete','error'])||!(b.collectedAt===null||typeof b.collectedAt==='string'&&Number.isFinite(Date.parse(b.collectedAt)))||!Number.isSafeInteger(b.totalThreads)||b.totalThreads<0||typeof b.initialComplete!=='boolean'||![null,'COLLECTION_FAILED','SYNC_FAILED'].includes(b.error))fail(400,'INVALID_INPUT','同步状态无效。');
    const h=await domain(env.DB,device.user_id),op=crypto.randomUUID();await env.DB.batch([guard(env.DB,h,op,device),env.DB.prepare('UPDATE devices SET protocol=3,collected_at=?,received_at=?,total_threads=?,initial_complete=?,sync_error=? WHERE user_id=? AND id=?').bind(b.collectedAt,Date.now(),b.totalThreads,Number(b.initialComplete),b.error,device.user_id,device.id),endGuard(env.DB,device.user_id,op)]);return json({ok:true});
  }
  if(path==='/api/v3/ingest'&&request.method==='POST'){
    const timing=new SyncTiming(),device=await timing.measure('auth',async()=>assertWritableDevice(await deviceAuth(request,env))),{batch,wire,wireHash}=await timing.measure('decode',()=>readUpload(request));
    const saved=await timing.measure('receive',()=>receive(env.DB,device,batch,wire,wireHash));
    if(saved.status==='received')await timing.measure('work',()=>advanceJobs(env.DB,{user:device.user_id,job_id:'apply:'+batch.batch_id,maxSteps:1,budgetMs:8000,knownBatch:batch,timing}));
    const ack=await timing.measure('ack',()=>readAcknowledgement(env.DB,device.user_id,batch.batch_id,device.id));return json(ack,ack.status==='applied'?200:202,{'Server-Timing':timing.header()});
  }
  if(path==='/api/v3/receipts'&&request.method==='GET'){
    const auth=await deviceAuth(request,env),ids=url.searchParams.getAll('ids').flatMap(s=>s.split(','));if(!ids.length||ids.length>100||ids.some(s=>!s||s.length>256))fail(400,'INVALID_IDS','确认请求无效。');
    const h=await domain(env.DB,auth.user_id),rows=[];for(const id of ids){const r=await receipt(env.DB,auth.user_id,id);if(!r||r.device_id!==auth.id)return fail(404,'NOT_FOUND','批次不存在。');rows.push(await acknowledge(env.DB,h,r));}return json({receipts:rows});
  }
  const user=await sessionUser(request,env);
  const project=await projectRoute(request,env,path,user.id);if(project)return project;
  const origin=await originRoute(request,env,path,user.id);if(origin)return origin;
  if(path==='/api/v3/sync/status'&&request.method==='GET'){await domain(env.DB,user.id);await advanceJobs(env.DB,{user:user.id,maxSteps:2,budgetMs:4000});return json(await syncStatus(env.DB,user.id));}
  if(path==='/api/v3/sync/read'&&request.method==='POST'){
    requireSameOrigin(request,env);requireJson(request);const b=await readJson(request,16384);if(!ownKeys(b,['scope','device_ids','from_lease_id'],['scope']))fail(400,'INVALID_SCOPE','读取范围无效。');const body=b as {scope:'recent'|'full';device_ids?:string[];from_lease_id?:string};if(!['recent','full'].includes(body.scope)||body.device_ids!==undefined&&!Array.isArray(body.device_ids)||body.from_lease_id!==undefined&&(typeof body.from_lease_id!=='string'||body.from_lease_id.length>256))fail(400,'INVALID_SCOPE','读取范围无效。');
    const read=await createRead(env.DB,user.id,body.scope,body.device_ids,body.from_lease_id);return json(read,201);
  }
  const readMatch=/^\/api\/v3\/sync\/read\/([^/]+)\/(manifest|entities|renew)$/.exec(path);
  if(readMatch){const id=decodeURIComponent(readMatch[1]);if(readMatch[2]==='manifest'&&request.method==='GET')return json(await manifest(env.DB,user.id,id,url.searchParams.get('cursor'),Number(url.searchParams.get('limit')||200)));
    if(request.method==='POST'){requireSameOrigin(request,env);if(readMatch[2]==='renew'){const r=await getRead(env.DB,user.id,id),expires=Math.min(r.max_expires_at,Date.now()+900000);await env.DB.prepare('UPDATE v3_read_leases SET expires_at=? WHERE user_id=? AND lease_id=?').bind(expires,user.id,id).run();return json({lease_id:id,expires_at:new Date(expires).toISOString()});}
      requireJson(request);const b=await readJson(request,65536);if(!ownKeys(b,['entities'],['entities']))fail(400,'INVALID_ENTITIES','实体请求无效。');const result=await entities(env.DB,user.id,id,(b as {entities:{kind:EntityKind;id:string;revision?:number;hash?:string}[]}).entities),r=await getRead(env.DB,user.id,id),expires=Math.min(r.max_expires_at,Date.now()+900000);await env.DB.prepare('UPDATE v3_read_leases SET expires_at=? WHERE user_id=? AND lease_id=?').bind(expires,user.id,id).run();return json({...result,expires_at:new Date(expires).toISOString()});}
  }
  if(path==='/api/v3/sync/changes'&&request.method==='GET')return json(await changes(env.DB,user.id,url.searchParams.get('dataset_epoch')||'',Number(url.searchParams.get('after')||0),Number(url.searchParams.get('limit')||20),url.searchParams.get('lease_id')||undefined));
  if(path.startsWith('/api/v3/usage/')&&request.method==='GET')return json(await queryUsage(env.DB,user.id,url,path.slice('/api/v3/usage/'.length)));
  if(path==='/api/v3/accounts'&&request.method==='GET')return json({accounts:await accountViews(env,user.id,[])});
  if(path==='/api/v3/devices'&&request.method==='GET')return json({devices:(await syncStatus(env.DB,user.id)).devices});
  const deviceMatch=/^\/api\/v3\/devices\/([^/]+)(?:\/(history))?$/.exec(path);
  if(deviceMatch){
    const allowed=deviceMatch[2]?['DELETE']:['PATCH','DELETE'];
    if(!allowed.includes(request.method))throw new HttpError(405,'METHOD_NOT_ALLOWED','此设备操作不支持该请求方法。',{Allow:allowed.join(', ')});
    requireSameOrigin(request,env);const id=decodeURIComponent(deviceMatch[1]),device=await env.DB.prepare('SELECT id FROM devices WHERE user_id=? AND id=?').bind(user.id,id).first();if(!device)fail(404,'NOT_FOUND','设备不存在。');
    if(request.method==='PATCH'&&!deviceMatch[2]){requireJson(request);const b=await readJson(request,1024);if(!ownKeys(b,['paused'],['paused'])||typeof (b as any).paused!=='boolean')fail(400,'INVALID_INPUT','暂停状态无效。');await env.DB.prepare('UPDATE devices SET paused=? WHERE user_id=? AND id=? AND revoked_at IS NULL').bind((b as any).paused?1:0,user.id,id).run();return json({ok:true});}
    if(deviceMatch[2]&&request.method==='DELETE'){await domain(env.DB,user.id);const now=Date.now();await env.DB.prepare('UPDATE devices SET revoked_at=COALESCE(revoked_at,?),history_deleted_at=COALESCE(history_deleted_at,?),initial_complete=0 WHERE user_id=? AND id=?').bind(now,now,user.id,id).run();await advanceJobs(env.DB,{user:user.id,job_id:'delete:'+id,maxSteps:4,budgetMs:8000});const job=await env.DB.prepare('SELECT state FROM v3_jobs WHERE user_id=? AND job_id=?').bind(user.id,'delete:'+id).first<{state:string}>();return json({ok:job?.state==='complete',status:job?.state==='complete'?'deleted':'deleting'},job?.state==='complete'?200:202);}
    await env.DB.prepare('UPDATE devices SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=? AND id=?').bind(Date.now(),user.id,id).run();return json({ok:true});
  }
  if(path==='/api/v3/settings'){
    if(request.method==='GET'){const leaseId=url.searchParams.get('lease_id'),lease=leaseId?await getRead(env.DB,user.id,leaseId):await getRead(env.DB,user.id,(await createRead(env.DB,user.id,'full',[])).lease_id),settings=resolveReadSettings(lease.settings,url),cut={dataset_epoch:lease.epoch,commit_seq:lease.cut,deletion_version:lease.deletion_version,organization_version:lease.organization_version,config_version:lease.config_version};return json({data:settings,meta:{source:'cloud',updatedAt:null,timezone:settings.timezone,warnings:[],cut,lease_id:lease.lease_id},settings,config_version:lease.config_version});}
    if(request.method==='PATCH'){
      requireSameOrigin(request,env);requireJson(request);return json(await updateSettings(env.DB,user.id,await readJson(request,65536)));
    }
  }
  return fail(404,'NOT_FOUND','v3 接口不存在。');
}
