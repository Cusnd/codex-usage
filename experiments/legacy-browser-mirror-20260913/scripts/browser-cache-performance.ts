// Real IndexedDB baseline, loaded by the local browser performance server.
import { IndexedDbCloudCache, emptyState, namespaceOf, type ReadLease } from '../browser/cache.js';
import type { SyncEntity } from '../../../modules/contracts/sync.js';

const output=document.createElement('pre');document.body.append(output);
const result:{browser:string;rows:number;measurements:{operation:string;ms:number}[];checks:string[];error?:string}={browser:navigator.userAgent,rows:10000,measurements:[],checks:[]};
const render=()=>{output.textContent=JSON.stringify(result,null,2);};
const measure=async<T>(operation:string,action:()=>Promise<T>)=>{const start=performance.now();const value=await action();result.measurements.push({operation,ms:performance.now()-start});render();return value;};
const name='codex-usage-performance-'+crypto.randomUUID(), namespace=namespaceOf({origin:location.origin,userId:'synthetic-performance',deviceIds:[]});
const cache=new IndexedDbCloudCache(indexedDB,name);
try {
  const entities:SyncEntity[]=Array.from({length:result.rows},(_,i)=>({kind:'event',id:String(i).padStart(6,'0'),revision:1,hash:'synthetic-'+i,value:{tokens:String(i*1000),padding:'x'.repeat(256)}}));
  const cut={dataset_epoch:'synthetic',commit_seq:1,deletion_version:0,organization_version:0,config_version:0};
  const lease:ReadLease={lease_id:'synthetic',scope:'full',cut,total_entities:entities.length,expected_entities:[{kind:'event',count:entities.length}],expires_at:new Date(Date.now()+60000).toISOString()};
  let state=emptyState(namespace);
  await measure('stage_10000',async()=>{for(let offset=0;offset<entities.length;offset+=1000)state=await cache.write(state,{state,stages:entities.slice(offset,offset+1000).map(entity=>({type:'entity',run:'baseline',entry:entity,entity}))});});
  state=await measure('promote_10000',()=>cache.write(state,{state:{...state,activeLease:lease,phase:'full_ready',appliedCommitSeq:1},finalizeBaseline:'baseline',clearStages:['baseline']}));
  const found=await measure('read_10000',()=>cache.entities(namespace,cut.dataset_epoch,entities));
  if(found.length!==10000||found.some((entity,i)=>entity?.id!==entities[i].id))throw new Error('Entity roundtrip failed');
  if((await cache.stages(namespace,'baseline')).length)throw new Error('Staging was not cleared');
  result.checks.push('10000 exact entities persisted and staging cleared');
  const page={key:'200-row-page',cut,cachedAt:new Date().toISOString(),response:{data:entities.slice(0,200),meta:{source:'cloud',updatedAt:null,timezone:'UTC',warnings:[]}}};
  await cache.putQuery(namespace,page);
  for(let sample=0;sample<7;sample++)await measure('cached_page_200_rows',async()=>{const saved=await cache.query(namespace,page.key);if((saved?.response.data as unknown[])?.length!==200)throw new Error('Query roundtrip failed');});
  result.checks.push('7 cached-page reads preserved all 200 rows');
}catch(error){result.error=String(error);}finally{
  cache.close(); await new Promise<void>((resolve,reject)=>{const req=indexedDB.deleteDatabase(name);req.onsuccess=()=>resolve();req.onerror=()=>reject(req.error);});
  render();navigator.sendBeacon('/__cache-result',JSON.stringify(result));
}
