import fs from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = 'artifacts/sync-fast-path-20260913';
const median = values => { const x = [...values].sort((a,b) => a-b); return x.length % 2 ? x[x.length >> 1] : (x[x.length/2-1]+x[x.length/2])/2; };
const reports = {};
for (const [name,file] of [['batching','browser-import.json'],['shadow','browser-shadow-comparison.json']]) {
  const data = JSON.parse(fs.readFileSync(root+'/'+file,'utf8'));
  assert(data.complete && !data.error && data.samples.length === 6);
  const groups = {};
  for (const sample of data.samples) {
    assert(sample.fullEntityEquality);
    const key = sample.variant === 'shadow-generation' ? sample.variant : 'current-cache-'+sample.batchSize;
    (groups[key] ??= []).push(sample);
  }
  reports[name] = { rows: data.rows, browser: data.browser, networkIncluded: data.networkIncluded,
    medians: Object.fromEntries(Object.entries(groups).map(([key,rows]) => {
      assert.equal(rows.length,3);
      return [key,Object.fromEntries(['totalMs','verifyMs','stageMs','promoteMs'].map(field => [field,median(rows.map(row => row[field]))]))];
    })) };
}
const sources = ['browser-import.ts','browser-shadow.ts','run-browser-import.mjs'].map(file => 'experiments/sync-fast-path-20260913/'+file);
const result = { generatedAt: new Date().toISOString(), reports, sourceSha256: Object.fromEntries(sources.map(file=>[file,createHash('sha256').update(fs.readFileSync(file)).digest('hex')])) };
fs.writeFileSync(root+'/browser-summary.json', JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
