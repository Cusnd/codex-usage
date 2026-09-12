import { SYNC_HEADER, SYNC_VERSION, assertCloudVersion } from "../../contracts/cloud-version.js";

export async function cloudRequest<T>(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  const r=await fetch(path,{method,signal,headers:{[SYNC_HEADER]:SYNC_VERSION,...body===undefined?{}:{'Content-Type':'application/json'}},body:body===undefined?undefined:JSON.stringify(body)});
  try{if(path!=='/api/v3/compatibility'&&path!=='/api/v3/me')assertCloudVersion(r);}catch(error){window.dispatchEvent(new Event('cloud-version-mismatch'));throw error;}
  const data=await r.json();if(data.error?.code==='VERSION_MISMATCH')window.dispatchEvent(new Event('cloud-version-mismatch'));if(!r.ok)throw Object.assign(new Error(data.error?.message||'云端请求失败。'),{status:r.status});return data;
}
