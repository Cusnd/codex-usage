import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Cloud, LogOut } from "lucide-react";
import { ErrorBox } from "../widgets/ui.js";
import { CloudSyncProvider, useCloudSync } from "../data/cloud-provider.js";
import { SYNC_VERSION, type CloudCompatibility } from "../../contracts/cloud-version.js";
import { cloudRequest } from '../adapters/cloud-http.js';
import { CloudBind } from '../features/devices/CloudBind.js';

type CloudUser={id:string;login:string};

const identityKey='codex-usage:last-cloud-user:v3';

function storedUser():CloudUser|null{try{const value=JSON.parse(localStorage.getItem(identityKey)||'null');return typeof value?.id==='string'&&typeof value?.login==='string'?value:null;}catch{return null;}}

export function CloudGate({children}:{children:ReactNode}){
  const client=useQueryClient(),location=useLocation();
  const [cachedUser,setCachedUser]=useState(storedUser);
  const me=useQuery({queryKey:['cloud-user'],queryFn:({signal})=>cloudRequest<{user:CloudUser}>('/api/v3/me','GET',undefined,signal),networkMode:'always',retry:false,refetchOnWindowFocus:true});
  const rejected=[401,403].includes((me.error as Error&{status?:number})?.status||0);
  const user=rejected?null:me.data?.user??(!me.isPending&&me.error?cachedUser:null);
  useEffect(()=>{try{if(rejected){localStorage.removeItem(identityKey);setCachedUser(null);}else if(me.data){localStorage.setItem(identityKey,JSON.stringify(me.data.user));setCachedUser(me.data.user);}}catch{}},[rejected,me.data]);
  // A login changed in another tab must not reuse the previous user's private query cache.
  // IndexedDB reads must execute offline; React Query's default network gate would pause them.
  const sessionClient=useMemo(()=>new QueryClient({defaultOptions:{...client.getDefaultOptions(),queries:{...client.getDefaultOptions().queries,
    networkMode:'always',retry:(count)=>navigator.onLine!==false&&count<1}}}),[client,user?.id]);
  if(me.isPending)return <div className="cloud-entry"><p role="status">正在打开个人云端空间…</p></div>;
  if(!user)return <div className="cloud-entry"><section className="panel"><Cloud size={34}/><h1>Codex 用量图录</h1><p>在熟悉的界面中查看所有设备的用量、任务和账户额度。</p>
    {(me.error as Error&{status?:number})?.status!==401&&<ErrorBox error={me.error}/>}
    <a className="primary-button" href={'/auth/github?returnTo='+encodeURIComponent(location.pathname+location.search)}>使用 GitHub 登录</a>
    <p className="footnote">仅本人登录后可见。设备上传已解析统计，关闭采集电脑后仍能查看最近同步的历史。</p></section></div>;
  return <QueryClientProvider client={sessionClient}><CloudVersionGate user={user}><CloudSyncProvider userId={user.id}><CloudIdentity user={user} offline={!!me.error} onLogout={()=>{sessionClient.clear();client.clear();}}/>{children}</CloudSyncProvider></CloudVersionGate></QueryClientProvider>;
}

function CloudVersionGate({user,children}:{user:CloudUser;children:ReactNode}){
  const location=useLocation();
  const [blocked,setBlocked]=useState(false);
  const [revoke,setRevoke]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const version=useQuery({queryKey:['cloud-version',user.id],queryFn:({signal})=>cloudRequest<CloudCompatibility>('/api/v3/compatibility','GET',undefined,signal),
    networkMode:'always',retry:false,refetchInterval:15000,refetchIntervalInBackground:true,refetchOnWindowFocus:true});
  useEffect(()=>{const changed=()=>{setBlocked(true);void version.refetch();};window.addEventListener('cloud-version-mismatch',changed);return()=>window.removeEventListener('cloud-version-mismatch',changed);},[version.refetch]);
  useEffect(()=>{if(version.data?.compatible&&!version.error)setBlocked(false);},[version.dataUpdatedAt,version.error]);
  async function revokeDevice(){if(!revoke||busy)return;setBusy(true);setError('');try{await cloudRequest('/api/v3/devices/'+encodeURIComponent(revoke),'DELETE');setRevoke(null);await version.refetch();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  if(location.pathname==='/bind')return <CloudBind/>;
  if(version.data?.compatible&&version.data.requiredVersion===SYNC_VERSION&&!version.error&&!blocked)return <>{children}</>;
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

function CloudIdentity({user,offline,onLogout}:{user:CloudUser;offline:boolean;onLogout:()=>void}){
  const sync=useCloudSync(),[error,setError]=useState('');
  async function logout(){try{await cloudRequest('/auth/logout','POST');await sync?.source.controller.invalidateForDeletion();localStorage.removeItem(identityKey);onLogout();window.location.assign('/');}catch(e){setError((e as Error).message);}}
  return <div className="cloud-identity"><span><Cloud size={15}/> @{user.login} 的云端空间{offline?' · 离线缓存':''}</span>{error&&<span role="alert">{error}</span>}<button onClick={()=>void logout()}><LogOut size={14}/>退出</button></div>;
}
