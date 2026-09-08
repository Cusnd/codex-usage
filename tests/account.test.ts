import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { AccountReader, AccountError, parseLimits, type AccountSource } from "../server/account.js";
import { observeAuth } from "../server/account-credentials.js";
import { resolveCodexCommand } from "../server/codex-command.js";
import { openAccountRpc, type AccountRpc } from "../server/account-rpc.js";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";

const jwt = (data: object) => `e30.${Buffer.from(JSON.stringify(data)).toString('base64url')}.synthetic`;
const auth = (user = 'user-a', workspace = 'workspace-a') => ({auth_mode:'chatgpt',tokens:{
  access_token: jwt({sub:user,'https://api.openai.com/auth':{chatgpt_account_id:workspace}}),
  id_token:jwt({sub:user}),account_id:workspace,
}});
async function fixture(fn: (root: string) => Promise<void>) {
 const root=await mkdtemp(path.join(os.tmpdir(),'codex-test-中文 空格-'));
 try { await fn(root); } finally { await rm(root,{recursive:true,force:true}); }
}
const writeAuth = (root:string,user?:string,workspace?:string) => writeFile(path.join(root,'auth.json'),JSON.stringify(auth(user,workspace)));
const quota = {rate_limit:{primary_window:{used_percent:23,limit_window_seconds:18000,reset_at:2000000000},secondary_window:null}};
const noCli = async (): Promise<never> => {throw new AccountError('CLI_NOT_FOUND','模拟未安装 CLI');};
const responseFetch = (body:unknown,status=200): typeof fetch => async () => new Response(JSON.stringify(body),{status});
function rpc(options: {fail?:string; rates?:any; beforeReturn?:(method:string,n:number)=>Promise<void>} = {}): AccountRpc {
 let n=0;
 return {notify(){},close(){},async request(method) {
   n++; await options.beforeReturn?.(method,n);
   if (method===options.fail) throw new AccountError('UNSUPPORTED_METHOD','模拟接口不支持');
   if (method==='initialize') return {};
   if (method==='account/read') return {account:{type:'chatgpt',email:'synthetic@example.invalid'}};
   if (method==='account/rateLimits/read') return options.rates ?? {accountId:'workspace-a',rateLimits:{primary:{usedPercent:20}}};
   return {summary:{lifetimeTokens:9007199254740993n},dailyUsageBuckets:[{startDate:'2026-09-08',tokens:'9007199254740993'}]};
 }};
}

test('quota parser preserves null metrics, multiple buckets and large usage is not estimated',()=>{
 const p=parseLimits({...quota,additional_rate_limits:[{limit_name:'Other',metered_feature:'model-x',rate_limit:{primary_window:{reset_at:2000000000}}}]},'workspace-a',true);
 assert.equal(p.buckets[0].primary!.windowDurationMins,300);
 assert.equal(p.buckets[0].primary!.remainingPercent,77);
 assert.equal(p.buckets[0].secondary,null);
 assert.equal(p.buckets[1].primary!.usedPercent,null);
 assert.equal(p.buckets[1].primary!.remainingPercent,null);
 assert.throws(()=>parseLimits({},'x',true),/格式/);
 assert.throws(()=>parseLimits({rate_limit:'bad'},'x',true),/格式/);
 assert.equal(parseLimits({rateLimitsByLimitId:{a:{primary:{usedPercent:101}},b:null}},'x').buckets[0].primary!.remainingPercent,0);
 assert.equal(parseLimits({rate_limit:null},'x',true).buckets[0].primary,null);
});

test('credential modes are explicit; user and workspace both participate in identity',()=>fixture(async root=>{
 assert.equal((await observeAuth(root)).error?.code,'CREDENTIALS_MISSING');
 await writeFile(path.join(root,'auth.json'),'{broken');
 assert.equal((await observeAuth(root)).error?.code,'CREDENTIALS_INVALID');
 await writeFile(path.join(root,'auth.json'),JSON.stringify({auth_mode:'apikey'}));
 assert.equal((await observeAuth(root)).error?.code,'UNSUPPORTED_LOGIN');
 await writeAuth(root); const a=(await observeAuth(root)).credentials!;
 await writeAuth(root,'user-b'); const b=(await observeAuth(root)).credentials!;
 assert.notEqual(a.key,b.key); assert.equal(a.accountId,b.accountId);
 await writeAuth(root,'user-a','workspace-b'); assert.notEqual((await observeAuth(root)).credentials!.key,a.key);
 await writeFile(path.join(root,'config.toml'),'cli_auth_credentials_store = "keyring"\n');
 assert.equal((await observeAuth(root)).error?.code,'UNSUPPORTED_STORE');
 await writeFile(path.join(root,'config.toml'),'cli_auth_credentials_store = "auto"\n');
 assert.equal((await observeAuth(root)).error?.code,'UNSUPPORTED_STORE');
}));

test('Windows resolver supports explicit exe, JS, standard npm shim and PATH; invalid override never falls through',()=>fixture(async root=>{
 const exe=path.join(root,'codex.exe');await writeFile(exe,'synthetic');
 assert.equal((await resolveCodexCommand({CODEX_BIN:exe},'win32')).bin,exe);
 const script=path.join(root,'node_modules/@openai/codex/bin/codex.js'); await mkdir(path.dirname(script),{recursive:true});await writeFile(script,'');
 const shim=path.join(root,'codex.cmd');await writeFile(shim,'@"%dp0%node.exe" "%dp0%node_modules\\@openai\\codex\\bin\\codex.js" %*');
 assert.deepEqual(await resolveCodexCommand({CODEX_BIN:shim},'win32'),{bin:process.execPath,args:[script]});
 assert.equal((await resolveCodexCommand({CODEX_BIN:script},'win32')).args[0],script);
 assert.equal((await resolveCodexCommand({PATH:root},'win32')).bin,exe);
 await assert.rejects(resolveCodexCommand({CODEX_BIN:path.join(root,'missing.exe'),PATH:root},'win32'),/CODEX_BIN/);
 await writeFile(shim,'@echo injected');
 await assert.rejects(resolveCodexCommand({CODEX_BIN:shim},'win32'),/CODEX_BIN/);
 await rm(exe);await rm(shim);
 const roaming=path.join(root,'roaming');const defaultJs=path.join(roaming,'npm/node_modules/@openai/codex/bin/codex.js');
 await mkdir(path.dirname(defaultJs),{recursive:true});await writeFile(defaultJs,'');
 assert.equal((await resolveCodexCommand({APPDATA:roaming},'win32')).args[0],defaultJs);
}));

test('CLI presence chooses provider; runtime errors never trigger OAuth; installing CLI restores primary',()=>fixture(async root=>{
 await writeAuth(root);let installed=true,broken=false,opens=0,fetches=0;
 const reader=new AccountReader({root,resolveCommand:async()=>{if(!installed)return noCli();return {bin:process.execPath,args:[]};},
 openRpc:async()=>{opens++;return broken?rpc({fail:'account/rateLimits/read'}):rpc();},fetch:async(input,init)=>{
   fetches++;assert.equal(input,'https://chatgpt.com/backend-api/wham/usage');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');
   assert.equal(new Headers(init?.headers).get('ChatGPT-Account-Id'),'workspace-a');return new Response(JSON.stringify(quota));
 }});
 try {
   assert.equal((await reader.readLimits()).provider,'app-server');assert.equal(fetches,0);
   broken=true;await assert.rejects(reader.readLimits());assert.equal(fetches,0);
   installed=false;const fallback=await reader.readLimits();assert.equal(fallback.provider,'http');assert.ok(fallback.fallbackReason);assert.equal(fetches,1);
   await assert.rejects(reader.readUsage(),(e:any)=>e.code==='CLI_NOT_FOUND');
   installed=true;broken=false;assert.equal((await reader.readLimits()).provider,'app-server');assert.equal(fetches,1);assert.equal(opens,3);
 } finally {reader.close();}
}));

test('history and limits do not depend on each other when file identity is available',()=>fixture(async root=>{
 await writeAuth(root);
 const first=new AccountReader({root,openRpc:async()=>rpc({fail:'account/usage/read'})});
 const results=await Promise.allSettled([first.readLimits(),first.readUsage()]);
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');first.close();
 const second=new AccountReader({root,openRpc:async()=>rpc({fail:'account/rateLimits/read'}),fetch:responseFetch({},503)});
 const history=await second.readUsage();assert.equal(history.data.summary.lifetimeTokens,'9007199254740993');
 await assert.rejects(second.readLimits());second.close();
}));

test('HTTP works without CLI and errors never include token or upstream body',()=>fixture(async root=>{
 await writeAuth(root);
 for (const [status,code] of [[401,'LOGIN_EXPIRED'],[403,'LOGIN_EXPIRED'],[503,'HTTP_STATUS']] as const) {
   const reader=new AccountReader({root,resolveCommand:noCli,fetch:responseFetch({secret:'SECRET_UPSTREAM_SENTINEL'},status)});
   await assert.rejects(reader.readLimits(),(e:any)=>{assert.equal(e.code,code);assert.doesNotMatch(e.message,/SECRET_UPSTREAM_SENTINEL|Bearer|e30\./);return true;});reader.close();
 }
 const reader=new AccountReader({root,resolveCommand:noCli,fetch:responseFetch(quota)});
 assert.equal((await reader.readLimits()).data.buckets[0].primary?.remainingPercent,77);reader.close();
 const malformed=new AccountReader({root,resolveCommand:noCli,fetch:async()=>new Response('SECRET_UPSTREAM_SENTINEL')});
 await assert.rejects(malformed.readLimits(),(e:any)=>e.code==='RESPONSE_INVALID'&&!e.message.includes('SECRET'));malformed.close();
}));

test('HTTP timeout and shutdown abort in-flight requests',()=>fixture(async root=>{
 await writeAuth(root);
 const hang:typeof fetch=async(_input,init)=>new Promise((_resolve,reject)=>{
   const signal=init!.signal!; if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 });
 // Keep a referenced timer: AbortSignal.timeout alone does not keep Node's event loop alive.
 const keep=setInterval(()=>{},1000);
 try {
 const timed=new AccountReader({root,resolveCommand:noCli,fetch:hang,httpTimeoutMs:20});
 await assert.rejects(timed.readLimits(),(e:any)=>e.code==='HTTP_TIMEOUT');timed.close();
 let started!:()=>void;const began=new Promise<void>(r=>started=r);
 const stopped=new AccountReader({root,resolveCommand:noCli,fetch:async(...args)=>{started();return hang(...args);}});
 const pending=stopped.readLimits();await began;stopped.close();await assert.rejects(pending,(e:any)=>e.code==='CANCELLED');
 await assert.rejects(stopped.readUsage(),(e:any)=>e.code==='CANCELLED');
 } finally {clearInterval(keep);}
}));

test('real HTTP transport rejects redirects without contacting redirect target',()=>fixture(async root=>{
 await writeAuth(root);let targetHits=0;
 const server=createServer((req,res)=>{if(req.url==='/target'){targetHits++;res.end('{}');}else {res.writeHead(302,{Location:'/target'});res.end();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address() as {port:number};
 const reader=new AccountReader({root,resolveCommand:noCli,fetch:async(_input,init)=>fetch(`http://127.0.0.1:${address.port}/redirect`,init)});
 try {await assert.rejects(reader.readLimits(),(e:any)=>e.code==='HTTP_NETWORK');assert.equal(targetHits,0);}
 finally {reader.close();await new Promise<void>(r=>server.close(()=>r()));}
}));

test('switching users within same workspace during HTTP or RPC discards results',()=>fixture(async root=>{
 await writeAuth(root);
 const reader=new AccountReader({root,resolveCommand:noCli,fetch:async()=>{await writeAuth(root,'user-b');return new Response(JSON.stringify(quota));}});
 await assert.rejects(reader.readLimits(),(e:any)=>e.code==='IDENTITY_CHANGED');assert.equal((await reader.selection()).confirmed,false);reader.close();
 await writeAuth(root);let fetches=0;
 const r=new AccountReader({root,openRpc:async()=>rpc({beforeReturn:async(method)=>{if(method==='account/usage/read')await writeAuth(root,'user-b');}}),fetch:async()=>{fetches++;return new Response('{}');}});
 await assert.rejects(r.readUsage(),(e:any)=>e.code==='IDENTITY_CHANGED');assert.equal(fetches,0);r.close();
}));

const mockProgram=path.resolve('tests/fixtures/mock-app-server.mjs');
async function writeScenario(root:string,data:object){await writeFile(path.join(root,'rpc-scenario.json'),JSON.stringify(data));}
function nativeReader(root:string,timeout=5000) {
 return new AccountReader({root,openRpc:async signal=>openAccountRpc({bin:process.execPath,args:[mockProgram]},root,signal,timeout)});
}
function alive(pid:number){try{process.kill(pid,0);return true;}catch{return false;}}
async function until(fn:()=>Promise<boolean>,ms=5000){const start=Date.now();while(!await fn()){if(Date.now()-start>ms)throw new Error('condition timed out');await delay(20);}}

test('real synthetic App Server protocol, large integers and child cleanup',()=>fixture(async root=>{
 await writeAuth(root);await writeScenario(root,{});const reader=nativeReader(root);
 try {
 const result=await reader.readUsage();assert.equal(result.data.summary.lifetimeTokens,'9007199254740993');
 const pid=Number(await readFile(path.join(root,'rpc-pid'),'utf8'));await until(async()=>!alive(pid));
 }finally{reader.close();}
}));

test('App Server shutdown aborts RPC and Windows npm-style process tree',()=>fixture(async root=>{
 await writeAuth(root);await writeScenario(root,{hang:'account/usage/read',grandchild:true});const reader=nativeReader(root);
 const pending=reader.readUsage();const rejected=assert.rejects(pending,(e:any)=>e.code==='CANCELLED');
 await until(async()=>{try{await access(path.join(root,'rpc-grandchild-pid'));return true;}catch{return false;}});
 const pid=Number(await readFile(path.join(root,'rpc-pid'),'utf8'));const child=Number(await readFile(path.join(root,'rpc-grandchild-pid'),'utf8'));
 reader.close();await rejected;await until(async()=>!alive(pid)&&!alive(child));
}));

test('RPC timeout and upstream JSON-RPC errors are safe',()=>fixture(async root=>{
 await writeAuth(root);await writeScenario(root,{fail:'account/usage/read'});const reader=nativeReader(root);
 await assert.rejects(reader.readUsage(),(e:any)=>e.code==='UNSUPPORTED_METHOD'&&!e.message.includes('SECRET'));reader.close();
 await writeScenario(root,{hang:'account/usage/read'});const timed=nativeReader(root,100);
 await assert.rejects(timed.readUsage(),(e:any)=>e.code==='RPC_TIMEOUT');timed.close();
}));

test('API independent refresh, fallback metadata, stale snapshots and restart identity isolation',()=>fixture(async root=>{
 await writeAuth(root);let quotaFails=false;
 const factory=()=>new AccountReader({root,openRpc:async()=>rpc({fail:'account/usage/read'}),fetch:responseFetch(quota)});
 const reader=new AccountReader({root,openRpc:async()=>quotaFails?rpc({fail:'account/rateLimits/read'}):rpc({fail:'account/usage/read'}),fetch:responseFetch({},503)});
 const db=path.join(root,'usage.sqlite');const {app,refresh,store}=await createApp({database:db,codexHome:root,startup:false,accountReader:reader});
 try {
   let res=await app.inject({method:'POST',url:'/api/refresh',payload:{source:'account',force:true}});assert.equal(res.statusCode,202);await refresh.wait();
   const s=(await app.inject('/api/status')).json().data;
   assert.equal(s.accountLimits.available,true);assert.ok(s.accountHistory.error);assert.equal(s.accountLimits.error,null);
   const limits=(await app.inject('/api/account/limits')).json();assert.equal(limits.meta.provider,'app-server');assert.equal(limits.meta.stale,false);assert.equal(limits.data.accountId,'workspace-a');
   assert.equal((await app.inject('/api/account/usage')).json().meta.updatedAt,null);
   quotaFails=true;refresh.trigger('accountLimits',true);await refresh.wait();
   const stale=(await app.inject('/api/account/limits')).json();assert.equal(stale.meta.stale,true);assert.equal(stale.meta.updatedAt,limits.meta.updatedAt);
   await writeAuth(root,'user-b');assert.deepEqual((await app.inject('/api/account/limits')).json().data.buckets,[]);
   assert.ok(Number(store.one('SELECT COUNT(*) n FROM account_snapshots')!.n)>0);
   await writeAuth(root);
 }finally{await app.close();}
 const reopened=await createApp({database:db,codexHome:root,startup:false,accountReader:factory()});
 try {
   const old=(await reopened.app.inject('/api/account/limits')).json();assert.equal(old.meta.stale,true);assert.equal(old.meta.identityConfirmed,false);assert.equal(old.data.accountId,'workspace-a');
   await writeAuth(root,'user-b');assert.deepEqual((await reopened.app.inject('/api/account/limits')).json().data.buckets,[]);
 }finally{await reopened.app.close();}
}));

test('refresh deduplicates in-flight jobs and unknown legacy snapshots never become current',()=>fixture(async root=>{
 const db=path.join(root,'db.sqlite');const old=new Store(db);
 old.run('INSERT INTO account_snapshots(account_id,kind,at,data) VALUES(?,?,?,?)',['old','limits','2026-01-01',JSON.stringify({accountId:'old',buckets:[]})]);old.close();
 let release!:()=>void;const blocked=new Promise<void>(r=>release=r);let count=0;
 const identity={key:'synthetic',accountId:'synthetic'};
 const source:AccountSource={selection:async()=>({identity,confirmed:true}),close(){release();},async readLimits(){count++;await blocked;return {data:{accountId:'synthetic',buckets:[]},identity,provider:'http',fallbackReason:'CLI 不可用'};},async readUsage(){throw new AccountError('UNSUPPORTED_METHOD','无历史接口');}};
 const {app,refresh}=await createApp({database:db,codexHome:root,startup:false,accountReader:source});
 try {
   assert.equal((await app.inject('/api/account/limits')).json().data.accountId,null);
   refresh.trigger('accountLimits',true);refresh.trigger('accountLimits',true);assert.equal(count,1);release();await refresh.wait();
   const q=(await app.inject('/api/account/limits')).json();assert.equal(q.meta.provider,'http');assert.ok(q.meta.warnings.some((s:string)=>s.includes('HTTP')));
   const schema=(await app.inject('/openapi.json')).json();assert.ok(JSON.stringify(schema).includes('accountHistory'));
 }finally{await app.close();}
}));

test('invalid explicit CLI or unsupported login never sends OAuth HTTP',()=>fixture(async root=>{
 let fetches=0;const fetcher:typeof fetch=async()=>{fetches++;throw new Error('must not fetch');};
 await writeAuth(root);
 const explicit=new AccountReader({root,resolveCommand:()=>resolveCodexCommand({CODEX_BIN:path.join(root,'missing.exe')},'win32'),fetch:fetcher});
 await assert.rejects(explicit.readLimits(),(e:any)=>e.code==='CLI_START');explicit.close();
 await rm(path.join(root,'auth.json'));
 const missing=new AccountReader({root,resolveCommand:noCli,fetch:fetcher});
 await assert.rejects(missing.readLimits(),(e:any)=>e.code==='CREDENTIALS_MISSING');missing.close();
 await writeAuth(root);await writeFile(path.join(root,'config.toml'),'cli_auth_credentials_store = "keyring"');
 const keyring=new AccountReader({root,resolveCommand:noCli,fetch:fetcher});
 await assert.rejects(keyring.readLimits(),(e:any)=>e.code==='UNSUPPORTED_STORE');keyring.close();assert.equal(fetches,0);
}));

test('OAuth credentials remain unchanged and never enter API, logs or SQLite snapshots',()=>fixture(async root=>{
 await writeAuth(root);const filename=path.join(root,'auth.json');const before=await readFile(filename,'utf8');let logs='';
 const reader=new AccountReader({root,resolveCommand:noCli,fetch:responseFetch(quota)});
 const {app,refresh,store}=await createApp({codexHome:root,database:path.join(root,'db.sqlite'),startup:false,accountReader:reader});
 try {
  refresh.trigger('account',true);await refresh.wait();
  for(const route of ['/api/status','/api/account/limits','/api/account/usage']) logs+=(await app.inject(route)).body;
  logs+=JSON.stringify(store.all('SELECT * FROM account_snapshots'),(_k,v)=>typeof v==='bigint'?String(v):v);
  const parsed=JSON.parse(before);
  assert.ok(!logs.includes(parsed.tokens.access_token));assert.ok(!logs.includes(parsed.tokens.id_token));assert.ok(!logs.includes('Bearer '));
  assert.equal(await readFile(filename,'utf8'),before);
 }finally{await app.close();}
}));

test('Codex-managed keyring users never share same-workspace snapshots or restore by email after restart',()=>fixture(async root=>{
 await writeFile(path.join(root,'config.toml'),'cli_auth_credentials_store = "keyring"');let email='a@example.invalid';
 const open=async()=>{const inner=rpc();return {...inner,async request(method:string,params?:unknown){return method==='account/read'?{account:{type:'chatgpt',email}}:inner.request(method,params);}};};
 const first=new AccountReader({root,openRpc:open});const a=await first.readLimits();
 assert.equal((await first.selection()).confirmed,false);
 email='b@example.invalid';const b=await first.readLimits();assert.notEqual(a.identity.key,b.identity.key);assert.equal(a.data.accountId,b.data.accountId);
 first.close();const second=new AccountReader({root,openRpc:open});
 assert.equal((await second.selection()).identity,null);assert.notEqual((await second.readLimits()).identity.key,b.identity.key);second.close();
}));
