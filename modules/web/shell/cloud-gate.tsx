import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Cloud, LogOut } from "lucide-react";
import { ErrorBox } from "../widgets/ui.js";
import { CloudProvider, useCloud } from "../data/cloud-provider.js";
import { removeLegacyCloudCache } from '../adapters/legacy-cache.js';
import { SYNC_VERSION, type CloudCompatibility } from "../../contracts/cloud-version.js";
import { cloudRequest } from '../adapters/cloud-http.js';
import { CloudBind } from '../features/devices/CloudBind.js';
import { CloudVersionSession } from './cloud-version-session.js';

type CloudUser={id:string;login:string};

export function CloudGate({children}:{children:ReactNode}){
  const client=useQueryClient(),location=useLocation();
  const [sessionRejected,setSessionRejected]=useState(false);
  const me=useQuery({queryKey:['cloud-user'],queryFn:({signal})=>cloudRequest<{user:CloudUser;compatibility?:CloudCompatibility}>('/api/v3/me?bootstrap=1','GET',undefined,signal),networkMode:'always',retry:false,refetchOnWindowFocus:true,refetchOnReconnect:true});
  const rejected=sessionRejected||[401,403].includes((me.error as Error&{status?:number})?.status||0);
  const user=rejected?null:me.data?.user;
  useEffect(()=>{void removeLegacyCloudCache();},[]);
  useEffect(()=>{if(me.data)setSessionRejected(false);},[me.dataUpdatedAt]);
  useEffect(()=>{const reject=()=>setSessionRejected(true);window.addEventListener('cloud-auth-rejected',reject);return()=>window.removeEventListener('cloud-auth-rejected',reject);},[]);
  // A login changed in another tab must not reuse the previous user's private query cache.
  const sessionClient=useMemo(()=>new QueryClient({defaultOptions:{...client.getDefaultOptions(),queries:{...client.getDefaultOptions().queries,
    networkMode:'always',retry:(count)=>navigator.onLine!==false&&count<1}}}),[client,user?.id]);
  if(me.isPending)return <div className="cloud-entry"><p role="status">正在打开个人云端空间…</p></div>;
  if(!user)return <div className="cloud-entry"><section className="panel"><Cloud size={34}/><h1>Codex 用量图录</h1><p>在熟悉的界面中查看所有设备的用量、任务和账户额度。</p>
    {(me.error as Error&{status?:number})?.status!==401&&<ErrorBox error={me.error}/>}
    <a className="primary-button" href={'/auth/github?returnTo='+encodeURIComponent(location.pathname+location.search)}>使用 GitHub 登录</a>
    <p className="footnote">仅本人登录后可见。设备上传已解析统计，关闭采集电脑后仍能查看最近同步的历史。</p></section></div>;
  return <QueryClientProvider client={sessionClient}><CloudVersionGate key={user.id} user={user} bootstrap={me.data?.compatibility} bootstrapUpdatedAt={me.dataUpdatedAt}><CloudProvider userId={user.id}><CloudIdentity user={user} onLogout={()=>{sessionClient.clear();client.clear();}}/>{children}</CloudProvider></CloudVersionGate></QueryClientProvider>;
}

function CloudVersionGate({user,bootstrap,bootstrapUpdatedAt,children}:{user:CloudUser;bootstrap?:CloudCompatibility;bootstrapUpdatedAt:number;children:ReactNode}){
  const location=useLocation();
  const client=useQueryClient();
  // Only this user's initial authenticated bootstrap seeds the permit. Later checks own it.
  const [session]=useState(()=>new CloudVersionSession(bootstrap));
  const [decision,setDecision]=useState(session.state);
  const [revoke,setRevoke]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const version=useQuery({queryKey:['cloud-version',user.id],queryFn:async({signal})=>{
    const check=session.begin();
    try{const data=await cloudRequest<CloudCompatibility>('/api/v3/compatibility','GET',undefined,signal);if(!signal.aborted)setDecision(session.succeed(check,data));return data;}
    catch(error){if(!signal.aborted)setDecision(session.fail(check,error));throw error;}
  },initialData:bootstrap,initialDataUpdatedAt:bootstrapUpdatedAt,staleTime:15000,
    networkMode:'always',retry:false,refetchInterval:15000,refetchIntervalInBackground:true,refetchOnWindowFocus:true,refetchOnReconnect:true});
  useEffect(()=>{let active=true;const changed=()=>{
    if(session.state.invalidated)return;
    setDecision(session.invalidate());
    // Cancel pre-mismatch checks: their late success cannot reopen a revoked permit.
    void client.cancelQueries({queryKey:['cloud-version',user.id],exact:true}).then(()=>{if(active)return version.refetch();});
  };window.addEventListener('cloud-version-mismatch',changed);return()=>{active=false;window.removeEventListener('cloud-version-mismatch',changed);};},[client,session,user.id,version.refetch]);
  async function revokeDevice(){if(!revoke||busy)return;setBusy(true);setError('');try{await cloudRequest('/api/v3/devices/'+encodeURIComponent(revoke),'DELETE');setRevoke(null);await version.refetch();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  if(location.pathname==='/bind')return <CloudBind/>;
  if(decision.allowed)return <>{decision.transientFailure&&<div className="notice" role="status">版本核对暂时失败，继续显示本次会话已核对的内容。恢复连接后将自动重试。</div>}{children}</>;
  return <div className="cloud-entry"><section className="panel"><Cloud size={34}/><h1>云端面板需要同步协议一致</h1>
    <p role="status">{version.isPending?'正在核对云端和采集设备版本…':'请将所有未撤销的采集设备更新为与云端相同的同步协议，启动同步后面板会自动解锁。'}</p>
    <p>网页同步协议：<code style={{overflowWrap:'anywhere'}}>{SYNC_VERSION}</code></p>
    {version.data&&<><p>云端同步协议：<code style={{overflowWrap:'anywhere'}}>{version.data.requiredVersion}</code></p>
      {version.data.browserVersion!==version.data.requiredVersion&&<p role="alert">此页面版本已过期，请刷新页面。</p>}
      {!version.data.devices.length&&<p>尚未检测到可用采集设备，请先绑定并启动相同版本的采集器。</p>}
      <ul style={{overflowWrap:'anywhere'}}>{version.data.devices.map(d=><li key={d.id}>{d.name}：{d.compatible?'同步协议一致':d.syncVersion||'尚未上报版本'}{!d.compatible&&<> · 需要更新 <button disabled={busy} onClick={()=>setRevoke(d.id)}>撤销设备</button></>}</li>)}</ul></>}
    {revoke&&<div className="notice"><p>撤销「{version.data?.devices.find(d=>d.id===revoke)?.name}」后会停止该设备上传，已有历史保留。再次使用需要重新绑定。</p><button disabled={busy} onClick={()=>void revokeDevice()}>确认撤销</button><button disabled={busy} onClick={()=>setRevoke(null)}>取消</button></div>}
    <ErrorBox error={version.error||(error?new Error(error):undefined)}/><p>版本核对失败时暂停展示统计和缓存。相同版本的设备完成一次同步后，电脑可以离线，历史仍保留在云端。</p>
    <button onClick={()=>void version.refetch()} disabled={version.isFetching}>重新核对</button> <Link to="/bind">绑定设备</Link>
  </section></div>;
}

function CloudIdentity({user,onLogout}:{user:CloudUser;onLogout:()=>void}){
  const cloud=useCloud(),[error,setError]=useState('');
  async function logout(){try{await cloudRequest('/auth/logout','POST');cloud?.source.invalidate();onLogout();window.location.assign('/');}catch(e){setError((e as Error).message);}}
  return <div className="cloud-identity"><span><Cloud size={15}/> @{user.login} 的云端空间</span>{error&&<span role="alert">{error}</span>}<button onClick={()=>void logout()}><LogOut size={14}/>退出</button></div>;
}
