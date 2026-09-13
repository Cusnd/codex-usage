import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const root=fileURLToPath(new URL('../../',import.meta.url)),directory=path.join(root,'artifacts/performance-cloud-experience/server');
fs.mkdirSync(directory,{recursive:true});
const result=spawnSync(process.execPath,[path.join(root,'cloud/node_modules/vitest/vitest.mjs'),'run','test/v3-coverage-index-performance.test.ts','--no-color','--reporter=default','--reporter=./test/coverage-index-benchmark-reporter.mjs'],{cwd:path.join(root,'cloud'),encoding:'utf8',maxBuffer:16*1024*1024});
const raw=result.stdout+'\n'+result.stderr;fs.writeFileSync(path.join(directory,'coverage-index.log'),raw);process.stdout.write(raw.replace(/^CLOUD_COVERAGE_INDEX_BENCHMARK .*\r?\n/gm,''));
const matches=[...raw.matchAll(/CLOUD_COVERAGE_INDEX_BENCHMARK (\{[^\r\n]+\})/g)],benchmark=matches[0]?JSON.parse(matches[0][1]):null;
if(result.status!==0||!benchmark)process.exit(result.status||1);
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const summary=[];for(const phase of ['without-index','with-index'])for(const name of ['grouped','boundaries','publication-200','publication-500']){
  const rows=benchmark.samples.filter(s=>s.phase===phase&&s.name===name&&!s.warmup),r=rows[0];
  summary.push({phase,name,median_ms:median(rows.map(r=>r.elapsed_ms)),range_ms:[Math.min(...rows.map(r=>r.elapsed_ms)),Math.max(...rows.map(r=>r.elapsed_ms))],rows_read:r.rows_read,rows_written:r.rows_written,statements:r.statements});
}
const output={at:new Date().toISOString(),status:result.status,index_bytes:benchmark.after_meta.size_after-benchmark.before_meta.size_after,summary,benchmark};
fs.writeFileSync(path.join(directory,'coverage-index.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({index_bytes:output.index_bytes,summary},null,2));
