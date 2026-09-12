import {matchingDevice} from './matching-build';
import {MatchingRequest} from './matching-build';
import {env} from 'cloudflare:workers';
import worker from '../../apps/cloud/index.js';
import {SESSION_COOKIE,sha256,token} from '../../modules/platform/worker/http.js';
import { stableJson, type UploadBatch } from '../../modules/contracts/sync.js';
import {initialContext,normalizeTokens} from '../../modules/usage/normalize.js';
import {advanceJobs} from '../../modules/sync/jobs/jobs.js';
const origin='https://quota.esoren.com';type Actor={user:string;session:string;device:string;credential:string;collector:string};
async function actor(user?:string):Promise<Actor>{const id=user||crypto.randomUUID(),session=token(),device=crypto.randomUUID(),credential=token();if(!user)await env.DB.prepare('INSERT INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)').bind(id,id,'v3-test',Date.now()).run();await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session),id,Date.now()+86400000).run();await env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,bound_at) VALUES(?,?,?,?,?)').bind(device,id,device,await sha256(credential),Date.now()).run();await matchingDevice(env.DB,device);return {user:id,session,device,credential,collector:crypto.randomUUID()};}
async function batch(a:Actor,options:{seq?:number;generation?:number;from?:number;complete?:boolean;response?:string;tokens?:string;originDevice?:string;originKind?:'preserved'|'execution';source?:string;record?:any;timestamp?:string}={}):Promise<UploadBatch>{
  const seq=options.seq||1,generation=options.generation||1,from=options.from||0,context={...initialContext('thread'),turn_id:'turn',model:'gpt-5',cwd:'/project',source_project_id:'project'},source=options.source||'source';
  const record=options.record||{type:'token_usage_record',timestamp:options.timestamp||new Date().toISOString(),payload:{thread_id:'thread',turn_id:'turn',response_id:options.response||'response-a',usage:normalizeTokens({input_tokens:options.tokens||'100',output_tokens:'0',total_tokens:options.tokens||'100'})}};
  const records=[{observation_id:await sha256(stableJson([a.collector,source,generation,from])),record_revision:1,source_id:source,generation,locator:from,byte_end:from+100,prefix_hash:await sha256(stableJson(record)),session_trusted:true,origin:{device_id:options.originDevice||a.device,kind:options.originKind||'execution' as const},context,record}];
  return {protocol:3,schema_version:1,extractor_version:2,collector_id:a.collector,producer_epoch:'epoch',lane:'live',lane_seq:seq,batch_id:crypto.randomUUID(),records_hash:await sha256(stableJson(records)),sources:[{source_id:source,generation,kind:'session',from_cursor:from,to_cursor:from+100,snapshot_eof:from+100,context_hash:await sha256(stableJson(context)),context,replace_start:from===0,replace_end:options.complete!==false,generation_complete:options.complete!==false,available:true,trailing_bytes:0}],records,metadata:[]};
}
async function call(a:Actor,path:string,method='GET',body?:unknown){return worker.fetch(new MatchingRequest(origin+path,{method,headers:{Origin:origin,Cookie:SESSION_COOKIE+'='+a.session,...body===undefined?{}:{'Content-Type':'application/json'}},body:body===undefined?undefined:JSON.stringify(body)}),env);}
async function events(a:Actor){return (await env.DB.prepare('SELECT payload FROM v3_events WHERE user_id=? AND epoch=(SELECT active_epoch FROM v3_sync_domains WHERE user_id=?) ORDER BY event_id').bind(a.user,a.user).all<{payload:string}>()).results.map(r=>JSON.parse(r.payload));}
async function drain(a:Actor,steps=80){for(let i=0;i<steps;i++){await env.DB.prepare("UPDATE v3_jobs SET next_attempt_at=0 WHERE user_id=? AND state='pending'").bind(a.user).run();const result=await advanceJobs(env.DB,{user:a.user,maxSteps:1,budgetMs:10000});if(!result.steps)return; }throw Error('jobs did not finish');}

export {origin,actor,batch,call,events,drain};
