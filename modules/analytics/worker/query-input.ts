import {fail,readJson,requireJson} from '../../platform/worker/http.js';

const routes=new Set(['settings','pricing','capabilities','status','local/overview','local/summary','local/scope','local/scope-summary','local/filters','local/project-options','local/trend','local/breakdown','local/threads','local/turns','local/compare']);
const scalars=new Set(['from','to','project','model','effort','threadId','unknown','groupBy','limit','offset','bucket','sort','cacheBelow','q','baselineFrom','baselineTo','missingTurn','turnId','lease_id','timezone','projects']);
export function validUsageRoute(route:string):boolean {
  if(route.length>4096)return false;if(routes.has(route))return true;
  const match=/^local\/threads\/([^/]+)(?:\/(agents|turns))?$/.exec(route);if(!match)return false;
  try{const id=decodeURIComponent(match[1]);return !!id&&id.length<=2048;}catch{return false;}
}
/** Only small query context is accepted; there is no browser batch-ID/name endpoint. */
export async function readUsageQuery(request:Request):Promise<{url:URL;route:string}> {
  const input=new URL(request.url),route=input.searchParams.get('route')||'';
  if(input.searchParams.getAll('route').length!==1||!validUsageRoute(route))fail(400,'INVALID_QUERY_ROUTE','查询路由无效。');
  requireJson(request);const body=await readJson(request,65536);
  if(!body||typeof body!=='object'||Array.isArray(body))return fail(400,'INVALID_FILTER','查询参数无效。');
  const url=new URL(input.origin+input.pathname);
  for(const [key,value] of Object.entries(body)){
    if(key==='deviceIds'||key==='unknowns'){
      const max=key==='deviceIds'?100:3;
      if(!Array.isArray(value)||value.length>max||value.some(v=>typeof v!=='string'||!v||v.length>256))return fail(400,'INVALID_FILTER','查询范围无效。');
      for(const item of value)url.searchParams.append(key,item);continue;
    }
    if(!scalars.has(key)||!['string','number','boolean'].includes(typeof value)||typeof value==='string'&&value.length>4096||typeof value==='number'&&!Number.isFinite(value))fail(400,'INVALID_FILTER','查询参数无效。');
    url.searchParams.set(key,String(value));
  }
  return {url,route};
}
