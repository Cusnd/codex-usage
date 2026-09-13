// Summarize sanitized CUA/CDP measurements; this script never contacts production.
// node scripts/cloud-experience-report.mjs [evidence directory]
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory=path.resolve(process.argv[2]||'artifacts/cloud-experience');
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;return n?(sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2:null;};
const reports=[];
for(const name of (await readdir(directory)).filter(name=>/^production-.*\.json$/.test(name)).sort()) {
  const data=JSON.parse(await readFile(path.join(directory,name),'utf8'));
  if(!Array.isArray(data.events))continue;
  const requests=new Map();
  for(const event of data.events) {
    if(event.method==='Network.requestWillBeSent')requests.set(event.requestId,{path:event.path,start:event.timestamp});
    const request=requests.get(event.requestId);if(!request)continue;
    if(event.method==='Network.responseReceived'){request.status=event.status;request.ttfbMs=event.timing?.receiveHeadersEnd;request.headersAt=event.timestamp;}
    if(event.method==='Network.loadingFinished'){request.end=event.timestamp;request.bytes=event.bytes;}
    if(event.method==='Network.loadingFailed')request.error=event.error||'Network loading failed';
  }
  const groups=new Map();
  for(const request of requests.values()) {
    if(!request.path?.startsWith('/api/'))continue;
    const group=groups.get(request.path)||[];group.push(request);groups.set(request.path,group);
  }
  reports.push({file:name,capturedAt:data.capturedAt,scenario:data.scenario,metrics:data.metrics,
    endpoints:[...groups].map(([route,rows])=>({route,requests:rows.length,statuses:rows.reduce((out,row)=>(out[row.status??'pending']=(out[row.status??'pending']||0)+1,out),{}),
      medianTtfbMs:median(rows.map(row=>row.ttfbMs).filter(Number.isFinite)),
      medianCompleteMs:median(rows.filter(row=>row.end).map(row=>(row.end-row.start)*1000)),
      totalBytes:rows.reduce((total,row)=>total+(row.bytes||0),0)}))});
}
await writeFile(path.join(directory,'production-summary.json'),JSON.stringify(reports,null,2)+'\n');
for(const report of reports){console.log(report.file);console.table(report.endpoints);}
