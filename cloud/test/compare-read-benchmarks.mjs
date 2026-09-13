import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const directory=fileURLToPath(new URL('../../artifacts/performance-cloud-experience/server/',import.meta.url));
const read=label=>JSON.parse(fs.readFileSync(directory+label+'.json','utf8'));
const before=read(process.argv[2]||'baseline'),after=read(process.argv[3]||'after');
if(before.status!==0||after.status!==0||!before.summary.length||before.summary.length!==after.summary.length)throw Error('Both complete benchmark runs must pass');
const rows=before.summary.map(b=>{
  const a=after.summary.find(s=>s.name===b.name);if(!a)throw Error('Missing path '+b.name);
  for(const run of [before,after]){
    const samples=run.benchmarks[0].samples.filter(s=>s.name===b.name);
    if(samples.length!==6||samples.some(s=>s.result_hash!==b.result_hash))throw Error('Response differs at '+b.name);
  }
  return {name:b.name,result_hash:b.result_hash,median_ms:[b.median_ms,a.median_ms],time_change_percent:100*(a.median_ms/b.median_ms-1),statements:[b.statements,a.statements],rows_read:[b.rows_read,a.rows_read],response_bytes:[b.response_bytes,a.response_bytes]};
});
fs.writeFileSync(directory+'comparison.json',JSON.stringify({before:before.label,after:after.label,all_response_hashes_equal:true,rows},null,2)+'\n');
console.log(JSON.stringify(rows,null,2));
