// Synthetic JSON-RPC server. It never reads a real Codex home or calls a network.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const root = process.env.CODEX_HOME;
const scenario = JSON.parse(readFileSync(path.join(root, 'rpc-scenario.json'), 'utf8'));
writeFileSync(path.join(root, 'rpc-pid'), String(process.pid));
if (scenario.grandchild) {
 const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore', windowsHide:true});
 writeFileSync(path.join(root,'rpc-grandchild-pid'), String(c.pid));
 process.on('exit',()=>c.kill());
}
const reader = createInterface({input:process.stdin});
reader.on('line',line=>{
 const m=JSON.parse(line);
 if (m.id == null || scenario.hang === m.method) return;
 const error = scenario.fail === m.method ? {code:-32601,message:'SECRET_UPSTREAM_SENTINEL'} : undefined;
 const result = m.method==='initialize' ? {} : m.method==='account/read'
   ? {account:{type:'chatgpt',email:'synthetic@example.invalid',planType:'pro'}}
   : m.method==='account/rateLimits/read' ? {accountId:'workspace-a',rateLimits:{primary:{usedPercent:12,windowDurationMins:300,resetsAt:2000000000}}}
   : {summary:{lifetimeTokens:'9007199254740993'},dailyUsageBuckets:[]};
 process.stdout.write(JSON.stringify({id:m.id,...(error?{error}:{result})})+'\n');
});
