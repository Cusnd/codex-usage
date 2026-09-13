import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const directory=fileURLToPath(new URL('../../artifacts/performance-current/cloud/',import.meta.url));
const before=JSON.parse(fs.readFileSync(path.join(directory,'baseline.json'),'utf8'));
const after=JSON.parse(fs.readFileSync(path.join(directory,'after.json'),'utf8'));
assert.equal(before.status,0);assert.equal(after.status,0);assert.equal(before.summary.length,after.summary.length);
const results=before.summary.map(old=>{
  const next=after.summary.find(value=>value.count===old.count);assert.ok(next);
  assert.equal(next.canonical_fingerprint,old.canonical_fingerprint);
  assert.equal(next.entity_count,old.entity_count);assert.equal(next.rows_written,old.rows_written);
  const oldCase=before.benchmarks.find(value=>value.count===old.count),newCase=after.benchmarks.find(value=>value.count===old.count);
  for(const sample of [...oldCase.samples,...newCase.samples])assert.equal(sample.canonical_fingerprint,old.canonical_fingerprint);
  assert.deepEqual(oldCase.samples[1].aggregate,newCase.samples[1].aggregate);
  return {count:old.count,before:old,after:next,elapsed_reduction_percent:(1-next.median_ms/old.median_ms)*100,binding_reduction_percent:(1-next.binding_bytes/old.binding_bytes)*100,measured_ms:{before:oldCase.samples.filter(s=>!s.warmup).map(s=>s.elapsed_ms),after:newCase.samples.filter(s=>!s.warmup).map(s=>s.elapsed_ms)},canonical_match:true,aggregate_match:true};
});
fs.writeFileSync(path.join(directory,'comparison.json'),JSON.stringify({baseline_head:before.head,results},null,2)+'\n');
console.log(JSON.stringify(results.map(({count,elapsed_reduction_percent,binding_reduction_percent,canonical_match,aggregate_match})=>({count,elapsed_reduction_percent,binding_reduction_percent,canonical_match,aggregate_match})),null,2));
