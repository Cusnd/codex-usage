import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root=fileURLToPath(new URL('../../',import.meta.url)),label=process.argv[2]||'current';
if(!/^[a-z0-9-]+$/i.test(label))throw Error('Use a simple artifact label');
const output=path.join(root,'artifacts/performance-current/cloud');fs.mkdirSync(output,{recursive:true});
const result=spawnSync(process.execPath,[path.join(root,'cloud/node_modules/vitest/vitest.mjs'),'run','test/v3-publication-performance.test.ts','--no-color','--reporter=default','--reporter=./test/publication-benchmark-reporter.mjs'],{cwd:path.join(root,'cloud'),encoding:'utf8',maxBuffer:16*1024*1024});
const raw=result.stdout+'\n'+result.stderr;fs.writeFileSync(path.join(output,`${label}.log`),raw);
process.stdout.write(raw.replace(/^CLOUD_PUBLICATION_BENCHMARK .*\r?\n/gm,''));
const benchmarks=[...raw.matchAll(/CLOUD_PUBLICATION_BENCHMARK (\{[^\r\n]+\})/g)].map(m=>JSON.parse(m[1]));
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const summary=benchmarks.map(b=>({count:b.count,samples:b.samples.length-1,median_ms:median(b.samples.filter(s=>!s.warmup).map(s=>s.elapsed_ms)),calls:b.samples[1].calls,statements:b.samples[1].statements,binding_bytes:b.samples[1].binding_bytes,rows_read:b.samples[1].rows_read,rows_written:b.samples[1].rows_written,entity_count:b.samples[1].entity_count,canonical_fingerprint:b.samples[1].canonical_fingerprint}));
const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
fs.writeFileSync(path.join(output,`${label}.json`),JSON.stringify({label,at:new Date().toISOString(),head:git.stdout.trim(),node:process.version,os:`${os.platform()} ${os.release()}`,cpu:os.cpus()[0]?.model,status:result.status,summary,benchmarks},null,2)+'\n');
console.log(JSON.stringify({label,summary},null,2));
if(result.status!==0||benchmarks.length!==2)process.exit(result.status||1);
