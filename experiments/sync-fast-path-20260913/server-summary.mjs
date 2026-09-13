import fs from 'node:fs';
import assert from 'node:assert/strict';
const directory='artifacts/sync-fast-path-20260913/server',label=process.argv[2]||'parity-final';
if(!/^[a-z0-9-]+$/i.test(label))throw Error('Invalid label');
const results=JSON.parse(fs.readFileSync(`${directory}/${label}.json`,'utf8'));
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const keys=[...new Set(results.samples.map(s=>JSON.stringify([s.count,s.scope,s.mode])))],summary=[];
for(const key of keys){
  const [count,scope,mode]=JSON.parse(key),rows=results.samples.filter(s=>s.count===count&&s.scope===scope&&s.mode===mode);
  assert.equal(rows.length,3,`${key}: needs three rounds`);assert.equal(new Set(rows.map(r=>r.fingerprint)).size,1);
  const result={count,scope,mode};
  for(const field of ['entities','event_count','elapsed_ms','requests','d1_statements','d1_rows_read','d1_response_bytes','json_bytes','gzip_bytes','max_response_json_bytes','first_response_ms','workerd_process_cpu_ms','client_cpu_ms'])result[field]=median(rows.map(row=>row[field]));
  result.elapsed_min_ms=Math.min(...rows.map(row=>row.elapsed_ms));result.elapsed_max_ms=Math.max(...rows.map(row=>row.elapsed_ms));result.fingerprint=rows[0].fingerprint;summary.push(result);
}
for(const fixture of results.fixtures)for(const scope of new Set(summary.filter(s=>s.count===fixture.events).map(s=>s.scope))){
  const group=summary.filter(s=>s.count===fixture.events&&s.scope===scope);assert.equal(group.length,4);assert.equal(new Set(group.map(s=>s.fingerprint)).size,1);
}
const output={at:results.at,input_label:label,fixtures:results.fixtures,sample_count:results.samples.length,summary};
fs.writeFileSync(`${directory}/${label}-summary.json`,JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
