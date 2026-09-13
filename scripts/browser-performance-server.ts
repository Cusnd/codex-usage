// Local-only browser measurement harness. Never included in application bundles.
// node --import tsx scripts/browser-performance-server.ts before 4180 production
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { createExampleAdapter } from '../apps/showcase/adapter.js';
import { ExampleStore } from '../apps/showcase/store.js';
import { build as bundle } from 'esbuild';

const [label = 'before', rawPort = '4180', mode = 'production'] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]*$/.test(label) || !['production','cloud','showcase'].includes(mode)) throw new Error('Invalid evidence path.');
const evidence = path.resolve('artifacts/performance-current/browser');
const buildDir = path.join(evidence, label, mode);
await mkdir(path.join(evidence, 'api-fixtures'), { recursive: true });
const adapter = createExampleAdapter(new ExampleStore(await initSqlJs()));
for (const [name,entry] of [['cache-performance','experiments/legacy-browser-mirror-20260913/scripts/browser-cache-performance.ts'],['cache-checks','experiments/legacy-browser-mirror-20260913/tests/web-cloud-cache.browser.ts']])
  await bundle({entryPoints:[entry],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:path.join(evidence,label,name+'.js')});
const telemetry = `(() => {
  const entries = { paint: [], lcp: [], layoutShift: [], longtask: [], event: [] }, errors = [], actions = [], milestones = {};
  for (const [key, type] of Object.entries({paint:'paint',lcp:'largest-contentful-paint',layoutShift:'layout-shift',longtask:'longtask',event:'event'})) {
    try { new PerformanceObserver(list => { for(const entry of list.getEntries()) entries[key].push(entry.toJSON()); }).observe({type,buffered:true,...(type==='event'?{durationThreshold:16}:{})}); } catch {}
  }
  addEventListener('error',e=>errors.push(String(e.message)));
  addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
  const run = new URLSearchParams(location.search).get('perfRun') || 'manual';
  let timer, count=0;
  const capture = () => {
    const now = performance.now();
    if (!milestones.shell && document.querySelector('h1')) milestones.shell = now;
    if (!milestones.chart && document.querySelector('.recharts-surface')) milestones.chart = now;
    clearTimeout(timer); timer=setTimeout(report,900);
  };
  const report = () => {
    const data={label:${JSON.stringify(label)},mode:${JSON.stringify(mode)},run,sequence:count++,url:location.pathname+location.search,at:performance.now(),userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],navigation:performance.getEntriesByType('navigation').map(x=>x.toJSON()),resources:performance.getEntriesByType('resource').filter(x=>!x.name.includes('/__perf')).map(x=>x.toJSON()),entries,errors,actions,milestones,heading:document.querySelector('h1')?.textContent,charts:document.querySelectorAll('.recharts-surface').length};
    navigator.sendBeacon('/__perf',JSON.stringify(data));
  };
  document.addEventListener('click',e=>{const el=e.target.closest('a,button,summary');if(el)actions.push({at:performance.now(),text:el.textContent.trim(),href:el.getAttribute('href')});},true);
  new MutationObserver(capture).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
  addEventListener('pagehide',report); addEventListener('load',capture); setTimeout(report,7000);
})();`;
const mime: Record<string,string> = { '.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.wasm':'application/wasm','.html':'text/html' };
const server = createServer(async (req,res) => {
  try {
    const url=new URL(req.url!, 'http://127.0.0.1');
    if(url.pathname==='/__cache-result'){let body='';for await(const part of req)body+=part;await writeFile(path.join(evidence,label,'cache-performance.json'),body+'\n');res.end('ok');return;}
    if(url.pathname==='/__cache'||url.pathname==='/__cache-checks'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Browser IndexedDB measurement</title><script type="module" src="/'+(url.pathname==='/__cache'?'cache-performance':'cache-checks')+'.js"></script>');return;}
    if(['/cache-performance.js','/cache-checks.js'].includes(url.pathname)){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile(path.join(evidence,label,url.pathname.slice(1))));return;}
    if (url.pathname==='/__perf') { let body='';for await(const part of req)body+=part;await appendFile(path.join(evidence,label,`browser-${mode}.jsonl`),body+'\n');res.end('ok');return; }
    if (url.pathname.startsWith('/api/')) {
      if (mode==='cloud') { res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Synthetic unauthenticated baseline'}));return; }
      const key=Buffer.from(url.pathname+url.search).toString('base64url'), file=path.join(evidence,'api-fixtures',key+'.json');
      let response: string;
      try { response=await readFile(file,'utf8'); } catch {
        const params:Record<string,unknown>={}; for(const [key,value] of url.searchParams)params[key]=value;
        response=JSON.stringify(url.pathname==='/api/cloud/status'?{data:{origin:'http://127.0.0.1',connected:false,enabled:false,revokePending:false,deviceId:null,deviceName:null,userLogin:null,binding:null,collectedAt:null,uploadedAt:null,nextUploadAt:null,pending:false,running:false,error:null},meta:{source:'local',updatedAt:null,timezone:'UTC',warnings:[]}}:await adapter.request(url.pathname.slice(5),params));await writeFile(file,response);
      }
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(response);return;
    }
    const asset=url.pathname.startsWith('/assets/');
    const file=asset?path.resolve(buildDir,'.'+url.pathname):path.join(buildDir,'index.html');
    if (!file.startsWith(buildDir+path.sep)) throw new Error('Invalid path');
    let bytes=await readFile(file);
    if (!asset) bytes=Buffer.from(bytes.toString().replace('<head>','<head><script>'+telemetry+'</script>'));
    const compressed=gzipSync(bytes);
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]??'application/octet-stream','Content-Encoding':'gzip','Cache-Control':asset?'public, max-age=31536000, immutable':'no-store'});res.end(compressed);
  } catch(error) { res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error)})); }
});
server.listen(Number(rawPort),'127.0.0.1',()=>console.log(`Synthetic browser ${label}/${mode}: http://127.0.0.1:${rawPort}/?range=30&perfRun=1`));
