import { json, readJson, requireJson, requireSameOrigin } from "../../modules/platform/worker/http.js";
import { advanceJobs } from "../../modules/sync/jobs/jobs.js";
import { originView, start, type Input, operation, result } from '../../modules/organization/worker/origins.js';

export async function originRoute(request:Request,env:Env,path:string,user:string):Promise<Response|null>{
  if(path==='/api/v3/origins'&&request.method==='GET')return json(await originView(env.DB,user,new URL(request.url)));
  if(path==='/api/v3/origins/operations'&&request.method==='POST'){
    requireSameOrigin(request,env);requireJson(request);const o=await start(env.DB,user,await readJson(request,65536) as Input);if(o.status==='pending')await advanceJobs(env.DB,{user,job_id:'origin:'+o.operation_id,maxSteps:4,budgetMs:4000});const saved=await operation(env.DB,user,o.operation_id);return json(result(saved),saved.status==='complete'?200:202);
  }
  const match=/^\/api\/v3\/origins\/operations\/([^/]+)$/.exec(path);if(match&&request.method==='GET'){const id=decodeURIComponent(match[1]);await operation(env.DB,user,id);await advanceJobs(env.DB,{user,job_id:'origin:'+id,maxSteps:4,budgetMs:4000});return json(result(await operation(env.DB,user,id)));}
  return null;
}
