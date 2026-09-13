// Exploration only. This entry is never imported by modules/apps or production Wrangler.
import application from '../../apps/cloud/index.js';
import {sessionUser} from '../../apps/cloud/auth.js';
import {versionGate} from '../../apps/cloud/version-gate.js';
import {HttpError,SESSION_COOKIE,sha256,token} from '../../modules/platform/worker/http.js';
import {stableJson} from '../../modules/contracts/sync.js';
import {SYNC_VERSION} from '../../modules/contracts/sync-version.js';
import {domain} from '../../modules/sync/publication/store.js';
import {getRead,createRead,readScope,versionAtCut,entityWithinScope,decodeCursor,leaseCut} from '../../modules/sync/reads/snapshots.js';
import {instrumentD1} from '../../cloud/test/d1-performance.js';

const encoder=new TextEncoder(),origin='http://127.0.0.1:18913';
type Row={kind:string;entity_id:string;revision:number;hash:string;payload:string;bytes:number};
const encode=(data:unknown)=>encoder.encode(JSON.stringify(data));
const failure=(status:number,code:string):never=>{throw new HttpError(status,code,code);};

async function seed(db:D1Database,count:number){
  if(![10000,25000].includes(count))failure(400,'INVALID_FIXTURE_COUNT');
  const user='fast-path-'+count,deviceA=user+'-a',deviceB=user+'-b',session=token();
  await db.prepare('DELETE FROM users WHERE id=?').bind(user).run();
  await db.batch([
    db.prepare("INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,'fast-path-synthetic',0)").bind(user,user),
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session),user,Date.now()+86400000),
    ...[deviceA,deviceB].map(id=>db.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at) VALUES(?,?,?,?,0)').bind(id,user,id,id)),
    ...[deviceA,deviceB].map(id=>db.prepare('INSERT INTO device_sync_versions(device_id,sync_version,checked_at) VALUES(?,?,0)').bind(id,SYNC_VERSION)),
  ]);
  const h=await domain(db,user);await db.prepare('UPDATE v3_sync_domains SET commit_seq=1 WHERE user_id=?').bind(user).run();
  let payloadBytes=0;
  const insert=async(rows:unknown[])=>db.prepare(`INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,thread_id,at,origin_device_id,payload)
    SELECT ?,?,value->>'$.kind',value->>'$.id',1,1,value->>'$.hash',value->>'$.thread',value->>'$.at',value->>'$.device',value->>'$.payload' FROM json_each(?)`).bind(user,h.active_epoch,JSON.stringify(rows)).run();
  for(let start=0;start<count;start+=500){
    const rows=[];
    for(let i=start;i<Math.min(count,start+500);i++){
      const thread='thread-'+String(i%250).padStart(3,'0'),at=i%250<125&&i%3===0?'2026-09-12T12:00:00.000Z':'2020-01-01T12:00:00.000Z',entropy=await sha256('deterministic-observation-'+i);
      const value={event_id:'event-'+String(i).padStart(6,'0'),thread_id:thread,turn_id:'turn-'+i,response_id:entropy.slice(0,32),selected_observation_id:entropy,
        at,source_project_id:'project-'+(i%40),model:i%3?'gpt-6-astra':'gpt-5',effort:i%2?'high':'medium',kind:'record',origin_device_id:i%2?deviceB:deviceA,
        input_tokens:'9007199254740994',cached_input_tokens:'20',cache_write_input_tokens:'0',output_tokens:'7',reasoning_output_tokens:'0',total_tokens:'9007199254741001',incomplete:0};
      const payload=stableJson(value);payloadBytes+=encoder.encode(payload).byteLength;
      rows.push({kind:'event',id:value.event_id,thread,at,device:value.origin_device_id,payload,hash:await sha256(payload)});
    }await insert(rows);
  }
  const threads=[];for(let i=0;i<250;i++){
    const id='thread-'+String(i).padStart(3,'0'),payload=stableJson({id,title:'Synthetic task '+i+' / 中文',source:'cli',source_project_id:'project-'+(i%40),parent_id:i===249?null:'thread-249'});
    payloadBytes+=encoder.encode(payload).byteLength;threads.push({kind:'thread',id,thread:id,at:null,device:null,payload,hash:await sha256(payload)});
  }await insert(threads);
  await db.batch([
    db.prepare("INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,valid_to,revision,hash,payload) VALUES(?,?,'event','event-000000',0,1,0,'old','{}')").bind(user,h.active_epoch),
    db.prepare("INSERT INTO v3_entity_versions(user_id,epoch,kind,entity_id,valid_from,revision,hash,payload) VALUES(?,?,'event','tombstone',1,1,'deleted',NULL),(?,?,'event','future',2,1,?,'{}')").bind(user,h.active_epoch,user,h.active_epoch,await sha256('{}')),
  ]);
  return {user,cookie:SESSION_COOKIE+'='+session,devices:[deviceA,deviceB],events:count,threads:250,payload_bytes:payloadBytes,padding_bytes:0,entropy:'Each event has distinct deterministic SHA-256 observation id and 128-bit response id'};
}

/** Two SQL queries in one HTTP page: bounded metadata, then only the selected payloads. */
async function page(db:D1Database,user:string,id:string,cursor:string|null,limit:number,maxBytes:number){
  if(!Number.isInteger(limit)||limit<1||limit>5000||!Number.isInteger(maxBytes)||maxBytes<1024||maxBytes>4*1024*1024)failure(400,'INVALID_PAGE_LIMIT');
  const lease=await getRead(db,user,id,'metadata'),after=decodeCursor(cursor);
  const meta=(await db.prepare(readScope()+` SELECT v.kind,v.entity_id,v.revision,v.hash,length(CAST(v.payload AS BLOB)) bytes FROM lease l CROSS JOIN v3_entity_versions v WHERE ${versionAtCut()} AND ${entityWithinScope()} ${after?'AND (v.kind,v.entity_id)>(?,?)':''} ORDER BY v.kind,v.entity_id LIMIT ?`).bind(user,id,Date.now(),...after??[],limit+1).all<Row>()).results;
  const selected:Row[]=[];let estimated=1024;
  for(const row of meta.slice(0,limit)){
    const size=encode({kind:row.kind,id:row.entity_id,revision:row.revision,hash:row.hash}).byteLength+row.bytes+12;
    if(estimated+size>maxBytes){if(!selected.length)failure(413,'ENTITY_EXCEEDS_PAGE_BYTES');break;}
    selected.push(row);estimated+=size;
  }
  const keys=JSON.stringify(selected.map(row=>({kind:row.kind,id:row.entity_id})));
  const rows=selected.length?(await db.prepare(readScope()+` SELECT v.kind,v.entity_id,v.revision,v.hash,v.payload FROM json_each(?) k CROSS JOIN lease l CROSS JOIN v3_entity_versions v WHERE ${versionAtCut()} AND v.kind=k.value->>'$.kind' AND v.entity_id=k.value->>'$.id' AND ${entityWithinScope()} ORDER BY v.kind,v.entity_id`).bind(user,id,Date.now(),keys).all<Row>()).results:[];
  await getRead(db,user,id,'metadata');
  if(rows.length!==selected.length||rows.some((r,i)=>r.hash!==selected[i].hash||r.revision!==selected[i].revision))failure(409,'BASELINE_REQUIRED');
  await db.prepare('UPDATE v3_read_leases SET expires_at=MIN(max_expires_at,?) WHERE user_id=? AND lease_id=? AND expires_at>?').bind(Date.now()+900000,user,id,Date.now()).run();
  const more=meta.length>rows.length,last=rows.at(-1),result={lease_id:id,cut:leaseCut(lease),scope:lease.scope,entities:rows.map(r=>({kind:r.kind,id:r.entity_id,revision:r.revision,hash:r.hash,value:JSON.parse(r.payload)})),next_cursor:more&&last?btoa(JSON.stringify([last.kind,last.entity_id])):null};
  if(encode(result).byteLength>maxBytes)failure(500,'BYTE_BOUND_FAILED');
  return result;
}

function statsHeaders(stats:ReturnType<typeof instrumentD1>['stats'],started:number){return {'x-exp-stats':JSON.stringify({...stats,worker_wall_ms:performance.now()-started}),'Cache-Control':'no-store'};}
function compressed(body:ReadableStream<Uint8Array>,headers:Record<string,string>){return new Response(body.pipeThrough(new CompressionStream('gzip')),{headers:{...headers,'Content-Encoding':'gzip'},encodeBody:'manual'});}

export default {
  async fetch(request:Request,env:Env){
    const url=new URL(request.url);if(url.origin!==origin)return new Response('Local experiment only',{status:403});
    const started=performance.now(),measured=instrumentD1(env.DB),db=measured.db;
    try{
      if(url.pathname==='/experiment/ping')return Response.json({ok:true});
      if(url.pathname==='/experiment/seed'&&request.method==='POST')return Response.json(await seed(env.DB,Number(url.searchParams.get('count'))));
      if(url.pathname.startsWith('/api/')){
        const response=await application.fetch(request,{...env,DB:db});
        return new Response(response.body!.pipeThrough(new CompressionStream('gzip')),{status:response.status,headers:{...Object.fromEntries(response.headers),'Content-Encoding':'gzip','x-exp-stats':JSON.stringify({...measured.stats,worker_wall_ms:performance.now()-started})},encodeBody:'manual'});
      }
      if(url.pathname==='/experiment/page'||url.pathname==='/experiment/stream'){
        // Same production panel gate, including its session lookup and all-device
        // compatibility query, before the route's own session lookup below.
        const gate=await versionGate(request,{...env,DB:db},'/api/v3/sync/read/experiment/candidate');
        if(gate)return gate;
      }
      const authenticated=await sessionUser(request,{...env,DB:db});
      if(!authenticated.id.startsWith('fast-path-'))failure(403,'SYNTHETIC_ONLY');
      if(url.pathname==='/experiment/read')return Response.json(await createRead(db,authenticated.id,url.searchParams.get('scope')==='recent'?'recent':'full',url.searchParams.getAll('device')));
      if(url.pathname==='/experiment/revoke'&&request.method==='POST'){
        await env.DB.prepare('UPDATE v3_read_leases SET expires_at=0 WHERE user_id=? AND lease_id=?').bind(authenticated.id,url.searchParams.get('lease')).run();return Response.json({ok:true});
      }
      if(url.pathname==='/experiment/advance'&&request.method==='POST'){
        await env.DB.prepare('UPDATE v3_sync_domains SET commit_seq=2 WHERE user_id=?').bind(authenticated.id).run();return Response.json({ok:true});
      }
      if(url.pathname==='/experiment/page'){
        const data=await page(db,authenticated.id,url.searchParams.get('lease')||'',url.searchParams.get('cursor'),Number(url.searchParams.get('limit')||1000),Number(url.searchParams.get('bytes')||1048576));
        return compressed(new Blob([encode(data)]).stream(),{'Content-Type':'application/json',...statsHeaders(measured.stats,started)});
      }
      if(url.pathname==='/experiment/stream'){
        const id=url.searchParams.get('lease')||'';const lease=await getRead(db,authenticated.id,id,'metadata');let cursor=url.searchParams.get('cursor'),sent=0,batches=0,done=false;
        const body=new ReadableStream<Uint8Array>({async pull(controller){
          try{
            if(done){controller.close();return;}
            const data=await page(db,authenticated.id,id,cursor,1000,1048576);sent+=data.entities.length;batches++;
            controller.enqueue(encode({...data,type:'page'}));controller.enqueue(encoder.encode('\n'));cursor=data.next_cursor;
            // Test-only deterministic fault after data has started: never issue a completion record.
            if(url.searchParams.get('fault')==='delete'&&batches===1){await env.DB.prepare('UPDATE v3_sync_domains SET deletion_version=deletion_version+1 WHERE user_id=?').bind(authenticated.id).run();}
            if(!cursor||batches>=30){await getRead(db,authenticated.id,id,'metadata');controller.enqueue(encoder.encode(JSON.stringify({type:cursor?'continuation':'complete',lease_id:id,cut:leaseCut(lease),entities:sent,next_cursor:cursor,stats:{...measured.stats,worker_wall_ms:performance.now()-started}})+'\n'));done=true;controller.close();}
          }catch(error){done=true;controller.enqueue(encoder.encode(JSON.stringify({type:'failed',code:error instanceof HttpError?error.code:'STREAM_FAILED'})+'\n'));controller.close();}
        }});
        return compressed(body,{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'});
      }
      failure(404,'NOT_FOUND');
    }catch(error){return Response.json({error:{code:error instanceof HttpError?error.code:'EXPERIMENT_FAILURE',message:error instanceof Error?error.message:String(error)}},{status:error instanceof HttpError?error.status:500});}
  }
};
