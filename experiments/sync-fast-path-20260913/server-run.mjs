import http from 'node:http';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.join(root,'artifacts/sync-fast-path-20260913/server'),origin='http://127.0.0.1:18913',agent=new http.Agent({keepAlive:true,maxSockets:8});
const launch=JSON.parse(fs.readFileSync(path.join(output,'launch.json'),'utf8'));
const syncVersion=fs.readFileSync('modules/contracts/sync-version.ts','utf8');
const version=['SYNC_PROTOCOL','SYNC_SCHEMA','EXTRACTOR_VERSION'].map(name=>String(Number(syncVersion.split('const '+name+' = ')[1].split(';')[0]))).join('.');
const requests=[];
function request(route,{cookie,method='GET',body}={}){return new Promise((resolve,reject)=>{
  const started=performance.now(),payload=body===undefined?undefined:Buffer.from(JSON.stringify(body));
  const req=http.request(origin+route,{method,agent,headers:{Origin:origin,'X-Codex-Usage-Sync':version,'Accept-Encoding':'gzip',...(cookie?{Cookie:cookie}:{}),...(payload?{'Content-Type':'application/json','Content-Length':payload.length}:{})}},res=>{
    const header_ms=performance.now()-started,chunks=[];let first_ms=null;
    res.on('data',chunk=>{first_ms??=performance.now()-started;chunks.push(chunk);});res.on('error',reject);
    res.on('end',()=>{try{
      const wire=Buffer.concat(chunks),raw=res.headers['content-encoding']==='gzip'?gunzipSync(wire):wire,text=raw.toString('utf8');
      const stat={route:route.split('?')[0],status:res.statusCode,elapsed_ms:performance.now()-started,header_ms,first_ms,gzip_bytes:wire.length,json_bytes:raw.length,stats:res.headers['x-exp-stats']?JSON.parse(res.headers['x-exp-stats']):null};requests.push(stat);
      const data=res.headers['content-type']?.includes('ndjson')?text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):JSON.parse(text);
      resolve({data,stat});
    }catch(error){reject(error);}});
  });req.on('error',reject);req.setTimeout(120000,()=>req.destroy(Error('request timeout')));if(payload)req.write(payload);req.end();
});}
const ps=code=>{const r=spawnSync('powershell.exe',['-NoProfile','-Command',code],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error(r.stderr);return JSON.parse(r.stdout||'[]');};
const descendants=ps(`$items=Get-CimInstance Win32_Process; $ids=New-Object 'System.Collections.Generic.HashSet[int]'; [void]$ids.Add(${launch.pid}); do {$added=$false; foreach($item in $items){if($ids.Contains([int]$item.ParentProcessId)-and $ids.Add([int]$item.ProcessId)){$added=$true}}}while($added); @($items | Where-Object {$_.Name -eq 'workerd.exe' -and $ids.Contains([int]$_.ProcessId)} | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`);
const pids=Array.isArray(descendants)?descendants:[descendants];if(!pids.length)throw Error('No owned Workerd process');
function cpu(){const values=ps(`@(Get-Process -Id ${pids.join(',')} | Select-Object Id,CPU,WorkingSet64,PrivateMemorySize64) | ConvertTo-Json -Compress`);return (Array.isArray(values)?values:[values]).reduce((s,p)=>({cpu_ms:s.cpu_ms+p.CPU*1000,working_set_bytes:s.working_set_bytes+p.WorkingSet64,private_bytes:s.private_bytes+p.PrivateMemorySize64}),{cpu_ms:0,working_set_bytes:0,private_bytes:0});}
async function get(route,cookie){const r=await request(route,{cookie});assert.equal(r.stat.status,200,JSON.stringify(r.data));return r.data;}
function fingerprint(entities){
  const sorted=[...entities].sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
  const keys=new Set();for(const entity of sorted){assert(!keys.has(entity.kind+'\0'+entity.id));keys.add(entity.kind+'\0'+entity.id);assert.equal(createHash('sha256').update(JSON.stringify(entity.value)).digest('hex'),entity.hash);}
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
async function baseline(cookie,lease){
  const manifest=cursor=>get(`/api/v3/sync/read/${lease.lease_id}/manifest?limit=500${cursor?'&cursor='+encodeURIComponent(cursor):''}`,cookie);
  let current=await manifest(null);const entities=[];
  for(;;){
    const ahead=current.next_cursor?manifest(current.next_cursor):null;
    for(let at=0;at<current.entities.length;at+=200){const batches=[current.entities.slice(at,at+100),current.entities.slice(at+100,at+200)].filter(rows=>rows.length);
      const loaded=await Promise.all(batches.map(async wanted=>{const r=await request(`/api/v3/sync/read/${lease.lease_id}/entities`,{cookie,method:'POST',body:{entities:wanted}});assert.equal(r.stat.status,200,JSON.stringify(r.data));assert.deepEqual(r.data.cut,lease.cut);return r.data.entities;}));
      for(const rows of loaded)entities.push(...rows);
    }
    if(!ahead)break;current=await ahead;
  }return entities;
}
async function direct(cookie,lease,limit,bytes){let cursor=null;const entities=[];do{const data=await get(`/experiment/page?lease=${lease.lease_id}&limit=${limit}&bytes=${bytes}${cursor?'&cursor='+encodeURIComponent(cursor):''}`,cookie);assert.deepEqual(data.cut,lease.cut);entities.push(...data.entities);cursor=data.next_cursor;}while(cursor);return entities;}
async function stream(cookie,lease){let cursor=null;const entities=[];do{const packets=await get(`/experiment/stream?lease=${lease.lease_id}${cursor?'&cursor='+encodeURIComponent(cursor):''}`,cookie),last=packets.at(-1);assert(['complete','continuation'].includes(last.type),JSON.stringify(last));
  for(const packet of packets.filter(p=>p.type==='page')){assert.deepEqual(packet.cut,lease.cut);entities.push(...packet.entities);}
  requests.at(-1).stats=last.stats;cursor=last.next_cursor;
}while(cursor);return entities;}
const sizes=(process.env.SERVER_COUNTS||'10000,25000').split(',').map(Number),rounds=Number(process.env.SERVER_ROUNDS||3),samples=[],fixtures=[],label=process.env.SERVER_LABEL||'results';
if(!/^[a-z0-9-]+$/i.test(label))throw Error('Invalid label');
for(const count of sizes){
  const seeded=await request('/experiment/seed?count='+count,{method:'POST'});assert.equal(seeded.stat.status,200,JSON.stringify(seeded.data));const fixture=seeded.data;fixtures.push({...fixture,cookie:undefined});
  const scopes=[['full',''],['device','&device='+encodeURIComponent(fixture.devices[0])],['recent','']].filter(([name])=>(process.env.SERVER_SCOPES||'full,device,recent').split(',').includes(name));
  for(const [scope,filter] of scopes){
    const lease=await get('/experiment/read?scope='+(scope==='recent'?'recent':'full')+filter,fixture.cookie);
    await request('/experiment/advance',{cookie:fixture.cookie,method:'POST'}); // Lease remains cut 1 even after current head advances.
    let expected;
    for(let round=0;round<rounds;round++)for(const mode of (round%2?['stream1000-gzip','page5000-4MiB','page1000-1MiB','manifest500-entities100x2']:['manifest500-entities100x2','page1000-1MiB','page5000-4MiB','stream1000-gzip'])){
      const before=cpu(),startIndex=requests.length,clientBefore=process.cpuUsage(),started=performance.now();
      const entities=mode==='manifest500-entities100x2'?await baseline(fixture.cookie,lease):mode==='page1000-1MiB'?await direct(fixture.cookie,lease,1000,1048576):mode==='page5000-4MiB'?await direct(fixture.cookie,lease,5000,4194304):await stream(fixture.cookie,lease);
      const elapsed_ms=performance.now()-started,clientCpu=process.cpuUsage(clientBefore),after=cpu(),digest=fingerprint(entities);expected??=digest;assert.equal(digest,expected);assert.equal(entities.length,lease.total_entities);
      const used=requests.slice(startIndex),sum=field=>used.reduce((n,r)=>n+(r.stats?.[field]||0),0);
      const eventRows=entities.filter(entity=>entity.kind==='event');assert(eventRows.every(row=>row.value.total_tokens==='9007199254741001'));
      const total_tokens_exact=eventRows.reduce((sum,row)=>sum+BigInt(row.value.total_tokens),0n).toString();
      const sample={count,scope,round,mode,entities:entities.length,event_count:eventRows.length,total_tokens_exact,elapsed_ms,requests:used.length,d1_statements:sum('statements'),d1_rows_read:sum('rows_read'),d1_response_bytes:sum('response_bytes'),json_bytes:used.reduce((n,r)=>n+r.json_bytes,0),gzip_bytes:used.reduce((n,r)=>n+r.gzip_bytes,0),max_response_json_bytes:Math.max(...used.map(r=>r.json_bytes)),first_response_ms:used[0].first_ms,workerd_process_cpu_ms:after.cpu_ms-before.cpu_ms,workerd_private_before_bytes:before.private_bytes,workerd_private_after_bytes:after.private_bytes,client_cpu_ms:(clientCpu.user+clientCpu.system)/1000,fingerprint:digest};samples.push(sample);
      console.log(JSON.stringify(sample));fs.writeFileSync(path.join(output,label+'.json'),JSON.stringify({at:new Date().toISOString(),version,local_http:true,fixtures,samples},null,2));
    }
    const expired=await get('/experiment/read?scope=full',fixture.cookie);await request('/experiment/revoke?lease='+expired.lease_id,{cookie:fixture.cookie,method:'POST'});
    assert.equal((await request('/experiment/page?lease='+expired.lease_id,{cookie:fixture.cookie})).stat.status,409);
    assert.equal((await request('/experiment/page?lease='+lease.lease_id)).stat.status,401);
  }
  const doomed=await get('/experiment/read?scope=full',fixture.cookie),failed=await get('/experiment/stream?lease='+doomed.lease_id+'&fault=delete',fixture.cookie);
  assert.equal(failed.at(-1).type,'failed');assert(!failed.some(p=>p.type==='complete'));
}
agent.destroy();console.log('All local HTTP equality, exact entity hashes, expiry/auth and interrupted stream checks passed.');
