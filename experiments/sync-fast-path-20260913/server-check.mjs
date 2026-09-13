import http from 'node:http';
import {createGunzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const origin='http://127.0.0.1:18913',checks=[];
const syncVersion=fs.readFileSync('modules/contracts/sync-version.ts','utf8');
const version=['SYNC_PROTOCOL','SYNC_SCHEMA','EXTRACTOR_VERSION'].map(name=>String(Number(syncVersion.split('const '+name+' = ')[1].split(';')[0]))).join('.');
async function json(route,cookie,method='GET',reportedVersion=version){
  const response=await fetch(origin+route,{method,headers:{Origin:origin,'X-Codex-Usage-Sync':reportedVersion,...(cookie?{Cookie:cookie}:{})}});
  return {status:response.status,data:await response.json()};
}
async function ok(route,cookie,method){const result=await json(route,cookie,method);assert.equal(result.status,200,JSON.stringify(result));return result.data;}
function digest(entities){
  const sorted=[...entities].sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
  assert.equal(new Set(sorted.map(e=>e.kind+'\0'+e.id)).size,sorted.length);
  for(const e of sorted)assert.equal(createHash('sha256').update(JSON.stringify(e.value)).digest('hex'),e.hash);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
// Actual gzip stream reader used only for cancellation/resume correctness, not timing.
function stream(route,cookie,stopAfterFirst=false){return new Promise((resolve,reject)=>{
  const request=http.get(origin+route,{headers:{Origin:origin,Cookie:cookie,'Accept-Encoding':'gzip','X-Codex-Usage-Sync':version}},response=>{
    if(response.statusCode!==200){response.resume();reject(Error('HTTP '+response.statusCode));return;}
    const source=response.pipe(createGunzip());source.setEncoding('utf8');let pending='',packets=[],stopped=false;
    source.on('data',chunk=>{
      if(stopped)return;pending+=chunk;
      for(;;){const newline=pending.indexOf('\n');if(newline<0)break;
        const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line)continue;
        try{const packet=JSON.parse(line);packets.push(packet);
          if(stopAfterFirst&&packet.type==='page'){stopped=true;source.destroy();response.destroy();request.destroy();resolve(packets);return;}
        }catch(error){reject(error);return;}
      }
    });source.on('error',error=>{if(!stopped)reject(error);});
    source.on('end',()=>{if(!stopped){assert.equal(pending.trim(),'');resolve(packets);}});
  });request.on('error',error=>reject(error));request.setTimeout(120000,()=>request.destroy(Error('timeout')));
});}
const first=await ok('/experiment/seed?count=10000',undefined,'POST'),second=await ok('/experiment/seed?count=25000',undefined,'POST');
const lease=await ok('/experiment/read?scope=full',first.cookie);await ok('/experiment/advance',first.cookie,'POST');
assert.equal((await json('/experiment/page?lease='+lease.lease_id)).status,401);checks.push({check:'anonymous page',status:401});
for(const kind of ['page','stream']){
  const mismatch=await json('/experiment/'+kind+'?lease='+lease.lease_id,first.cookie,'GET','0.0.0');
  assert.equal(mismatch.status,426);checks.push({check:'production version mismatch '+kind,status:mismatch.status,code:mismatch.data.error.code});
  const result=await json('/experiment/'+kind+'?lease='+lease.lease_id,second.cookie);
  assert.equal(result.status,409);checks.push({check:'cross user '+kind,status:result.status,code:result.data.error.code});
}
const entities=[];let cursor=null,maxBytes=0;
do{const data=await ok('/experiment/page?lease='+lease.lease_id+'&limit=5000&bytes=4194304'+(cursor?'&cursor='+encodeURIComponent(cursor):''),first.cookie);
  assert.deepEqual(data.cut,lease.cut);entities.push(...data.entities);maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(data)));cursor=data.next_cursor;
}while(cursor);
assert.equal(entities.length,10250);assert(!entities.some(e=>e.id==='future'||e.id==='tombstone'));const expected=digest(entities);
checks.push({check:'fixed cut survives newer head; no old version or tombstone',entities:entities.length,fingerprint:expected,max_page_json_bytes:maxBytes});
const bounded=await ok('/experiment/page?lease='+lease.lease_id+'&limit=5000&bytes=65536',first.cookie),boundedBytes=Buffer.byteLength(JSON.stringify(bounded));
assert(bounded.entities.length>0&&bounded.entities.length<1000);assert(bounded.next_cursor);assert(boundedBytes<=65536);
assert.deepEqual(bounded.entities,entities.slice(0,bounded.entities.length));
checks.push({check:'byte cap forces early page boundary',entity_limit:5000,byte_limit:65536,actual_entities:bounded.entities.length,actual_json_bytes:boundedBytes});
const tooSmall=await json('/experiment/page?lease='+lease.lease_id+'&limit=1000&bytes=1024',first.cookie);assert.equal(tooSmall.status,413);
checks.push({check:'entity exceeding reserved page budget fails explicitly',status:tooSmall.status,code:tooSmall.data.error.code});
const firstPackets=await stream('/experiment/stream?lease='+lease.lease_id,first.cookie,true),page=firstPackets[0];
assert.equal(page.type,'page');assert(page.next_cursor);assert.equal(page.entities.length,1000);
const continued=await stream('/experiment/stream?lease='+lease.lease_id+'&cursor='+encodeURIComponent(page.next_cursor),first.cookie),terminal=continued.at(-1);
assert.equal(terminal.type,'complete');assert.equal(terminal.next_cursor,null);
const combined=[...page.entities,...continued.filter(p=>p.type==='page').flatMap(p=>p.entities)];assert.equal(combined.length,entities.length);assert.equal(digest(combined),expected);
checks.push({check:'cancel client gzip reader after first page; resume cursor and concatenate',first_page_entities:page.entities.length,resumed_entities:terminal.entities,entities:combined.length,fingerprint:digest(combined),terminal:terminal.type});
const expired=await ok('/experiment/read?scope=full',first.cookie);await ok('/experiment/revoke?lease='+expired.lease_id,first.cookie,'POST');
assert.equal((await json('/experiment/page?lease='+expired.lease_id,first.cookie)).status,409);checks.push({check:'expired lease',status:409});
const failure=await stream('/experiment/stream?lease='+lease.lease_id+'&fault=delete',first.cookie);
assert.equal(failure.at(-1).type,'failed');assert(!failure.some(p=>p.type==='complete'));
assert.equal((await json('/experiment/page?lease='+lease.lease_id,first.cookie)).status,409);
checks.push({check:'deletion version changes after streamed page; no completion and later page rejects',delivered_entities:failure.filter(p=>p.type==='page').reduce((n,p)=>n+p.entities.length,0),terminal:failure.at(-1),later_status:409});
const artifact={at:new Date().toISOString(),local_http:true,checks};
fs.writeFileSync('artifacts/sync-fast-path-20260913/server/checks.json',JSON.stringify(artifact,null,2));console.log(JSON.stringify(artifact,null,2));
