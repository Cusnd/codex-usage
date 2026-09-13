import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('artifacts/performance-current/browser');
const median=values=>{const rows=[...values].sort((a,b)=>a-b);return rows[Math.floor(rows.length/2)];};
const reports={};
let measuredViewport;
for(const label of ['before','after']){
  const records=(await readFile(path.join(root,label==='after'?'after-final':label,'browser-production.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  for(const [scenario,prefix,count] of [['warm','paired',5],['cold','cold',3]]) {
  const samples=[];
  for(let i=1;i<=count;i++){
    const matches=records.filter(row=>row.run===`${prefix}-${label}-${i}`&&row.url.startsWith('/?')&&row.milestones.chart&&row.entries.paint.some(entry=>entry.name==='first-contentful-paint'));
    // Only the original overview report, never a later SPA route's LCP or resources.
    const row=matches.at(-1);
    if(!row)throw new Error(`Missing complete ${label} sample ${i}`);
    if(!Array.isArray(row.viewport)||row.viewport.length!==2)throw new Error(`Missing viewport in ${label} sample ${i}`);
    measuredViewport??=row.viewport;
    if(JSON.stringify(row.viewport)!==JSON.stringify(measuredViewport))throw new Error(`Viewport mismatch in ${label} sample ${i}`);
    if(row.errors.length)throw new Error(`Errors in ${label} sample ${i}: ${row.errors.join(', ')}`);
    samples.push({run:row.run,shellDomMs:row.milestones.shell,chartDomMs:row.milestones.chart,fcpMs:row.entries.paint.find(entry=>entry.name==='first-contentful-paint').startTime,
      lcpMs:row.entries.lcp.at(-1)?.startTime,cls:row.entries.layoutShift.filter(entry=>!entry.hadRecentInput).reduce((n,entry)=>n+entry.value,0),longTaskMs:row.entries.longtask.reduce((n,entry)=>n+entry.duration,0),jsTransferBytes:row.resources.filter(entry=>new URL(entry.name).pathname.endsWith('.js')).reduce((n,entry)=>n+entry.transferSize,0)});
  }
  reports[label]??={};
  reports[label][scenario]={samples,median:Object.fromEntries(Object.keys(samples[0]).filter(key=>key!=='run').map(key=>[key,median(samples.map(row=>row[key]))]))};
  }
}
const report={viewport:measuredViewport,method:`Alternating before/after in the same IAB 152, viewport ${measuredViewport.join('x')}, synthetic 30-day API fixture. Warm: 5 pairs, no throttling, HTTP cache enabled. Cold: 3 pairs, HTTP cache disabled, latency 80ms, download and upload 196608 bytes/sec, no CPU throttling. Both tabs have CDP Network enabled; synthetic network throttling and cache settings restored afterwards. Quiet window excludes other benchmark/test processes. DOM milestones are MutationObserver observations, not paint. Pilot Chrome/invalid-range/intermediate-build samples excluded.`,...reports};
await writeFile(path.join(root,'browser-summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
