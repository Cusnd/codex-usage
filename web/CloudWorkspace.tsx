import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Cloud, Laptop, LogOut, Plus } from 'lucide-react';
import type { CloudSource, CloudAccountView } from '../shared/cloud-accounts';
import { Workspace, useData, useRange } from './workspace';
import { ErrorBox, time } from './ui';
import { QuotaCards } from './QuotaCards';
import { Chart } from './Overview';
import { compact, exact } from './api';
import './cloud-workspace.css';
import { CloudSyncProvider, useCloudSync } from './cloud-sync/provider';
import { SYNC_HEADER, SYNC_VERSION, assertCloudVersion, type CloudCompatibility } from '../shared/cloud-version';

type CloudUser={id:string;login:string};
const identityKey='codex-usage:last-cloud-user:v3';
function storedUser():CloudUser|null{try{const value=JSON.parse(localStorage.getItem(identityKey)||'null');return typeof value?.id==='string'&&typeof value?.login==='string'?value:null;}catch{return null;}}

export async function cloudRequest<T>(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  const r=await fetch(path,{method,signal,headers:{[SYNC_HEADER]:SYNC_VERSION,...body===undefined?{}:{'Content-Type':'application/json'}},body:body===undefined?undefined:JSON.stringify(body)});
  try{if(path!=='/api/v3/compatibility'&&path!=='/api/v3/me')assertCloudVersion(r);}catch(error){window.dispatchEvent(new Event('cloud-version-mismatch'));throw error;}
  const data=await r.json();if(data.error?.code==='VERSION_MISMATCH')window.dispatchEvent(new Event('cloud-version-mismatch'));if(!r.ok)throw Object.assign(new Error(data.error?.message||'云端请求失败。'),{status:r.status});return data;
}
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
export function CloudSyncStatus(){
  const sync=useCloudSync(),{settings:{timezone}}=useContext(Workspace);if(!sync)return null;const {state,online}=sync;
  const labels={empty:'等待首次同步',recent_loading:'正在准备近期历史',recent_ready:'近期历史缓存已就绪',full_loading:'正在补齐完整历史',full_ready:'完整历史缓存已就绪',delta_loading:'正在接收最新变化'};
  const done=Object.values(state.baseline?.counts||{}).reduce((n,v)=>n+(v||0),0),total=state.baseline?.lease.total_entities;
  return <section className="cloud-sync-progress" aria-label="浏览器同步状态"><div><strong>{online?labels[state.phase]:'离线 · 查看已保存的页面'}</strong><span>{state.lastSyncAt?'最近完成 '+time(state.lastSyncAt,timezone):'首次打开将先准备近期记录，再继续补齐历史。'}</span></div>
    {state.baseline&&<div><progress aria-label="历史缓存下载进度" max={Math.max(total||0,1)} value={done}/><span>{done.toLocaleString()} / {total?.toLocaleString()??'未知'} 项</span></div>}
    {state.receivedCommitSeq>state.appliedCommitSeq&&<p role="status">新数据已收到，正在完成本地缓存更新。</p>}
    <p className="footnote">离线时可查看已打开并保存的页面及筛选结果。</p>{state.error&&<p className="error-text" role="alert">{state.error}</p>}
  </section>;
}
export function useCloudDevices(){const sync=useCloudSync();return useQuery({queryKey:['cloud-devices'],queryFn:({signal})=>cloudRequest<{devices:CloudSource[]}>('/api/v3/devices','GET',undefined,signal),enabled:sync?.online!==false,refetchInterval:sync?.online===false?false:15000});}
export function sourceState(d:CloudSource){return d.historyDeleting?'正在删除云端历史 · 设备已撤销':d.deletionStatus==='failed'?'删除未完成 · 设备已撤销':d.historyDeleted?'历史已删除 · 设备已撤销':d.revoked?'已撤销 · 历史保留':d.paused?'同步已暂停':d.error?'同步失败':!d.receivedAt?'等待首次同步':Date.now()-Date.parse(d.receivedAt)>180000?'设备离线或未更新':!d.initialComplete?'历史同步中':'最近已同步';}
export function CloudDeviceFilter(){
  const q=useCloudDevices(),sync=useCloudSync(),[search]=useSearchParams(),navigate=useNavigate(),location=useLocation();
  const selected=search.getAll('deviceIds'),devices=q.data?.devices||[];
  function choose(ids:string[]){const next=new URLSearchParams(search);next.delete('deviceIds');ids.forEach(id=>next.append('deviceIds',id));
    for(const key of [...next.keys()])if(/offset$/i.test(key)||['expandedTurn','turnId','missingTurn','scope','returnTo','threadId'].includes(key))next.delete(key);
    navigate({pathname:location.pathname.startsWith('/threads/')?'/threads':location.pathname,search:next.toString()});}
  return <section className="cloud-source-bar" aria-label="云端数据来源"><div><strong><Laptop size={17}/> {selected.length?`已选 ${selected.length} 台设备`:'全部设备'}</strong><span>{selected.length?'按执行来源及用户指定归属筛选':'合并去重后的统计'} · 本地应用始终只显示本机</span></div>
    <details className="cloud-device-picker"><summary>选择设备</summary><div><label><input type="checkbox" aria-label="全部设备" checked={!selected.length} onChange={()=>choose([])}/>全部设备</label>
      {devices.map(d=><label key={d.id}><input type="checkbox" aria-label={d.name} checked={selected.includes(d.id)} onChange={()=>choose(selected.includes(d.id)?selected.filter(x=>x!==d.id):[...selected,d.id])}/><span>{d.name}<small>{sourceState(d)}</small></span></label>)}</div></details>
    <Link to={{pathname:'/settings',search:search.toString()}}>管理设备</Link><ErrorBox error={sync?.online===false?undefined:q.error}/>
    {q.data&&!devices.length&&<p className="notice">还没有采集设备。在电脑的“设置 → 云端同步”中连接后，这里会出现设备记录。</p>}
  </section>;
}
export function CloudDeviceSettings(){
  const q=useCloudDevices(),client=useQueryClient(),sync=useCloudSync(),{settings:{timezone}}=useContext(Workspace),[busy,setBusy]=useState(''),[error,setError]=useState(''),[deleting,setDeleting]=useState<string|null>(null);
  async function action(d:CloudSource,kind:'pause'|'revoke'|'delete'){if(busy)return;setBusy(d.id);setError('');
    try{await cloudRequest('/api/v3/devices/'+encodeURIComponent(d.id)+(kind==='delete'?'/history':''),kind==='pause'?'PATCH':'DELETE',kind==='pause'?{paused:!d.paused}:undefined);
      if(kind==='delete')await sync?.invalidateHistory();await client.invalidateQueries();setDeleting(null);}catch(e){setError((e as Error).message);}finally{setBusy('');}}
  return <section className="panel cloud-devices"><div className="panel-heading"><h2>采集设备</h2><Link to="/bind"><Plus size={16}/>绑定设备</Link></div>
    <p>在每台电脑的本地应用中开启云端同步。新设备会加入当前空间，所有统计保留设备来源。</p><ErrorBox error={(sync?.online===false?undefined:q.error)||(error?new Error(error):undefined)}/>
    {(q.data?.devices||[]).map(d=><article key={d.id} className="cloud-device-row"><div><h3>{d.name}</h3><p>{sourceState(d)}</p><small>采集：{time(d.collectedAt,timezone)} · 接收：{time(d.receivedAt,timezone)} · 应用：{time(d.appliedAt,timezone)}</small><small>历史覆盖：{time(d.coverageFrom,timezone)} — {time(d.coverageTo,timezone)}</small><small>{d.retainedThreads===undefined?'云端保留会话数暂不可用':`云端已保留 ${d.retainedThreads} 个会话`} · 本次采集报告 {d.totalThreads??'未知'} 个会话</small>{d.sourceCounts&&<small>云端完整来源 {d.sourceCounts.complete} / {d.sourceCounts.known} · 待应用批次 {d.sourceCounts.pendingBatches}{d.sourceCounts.unavailable>0?` · 暂不可用来源 ${d.sourceCounts.unavailable}`:''}</small>}</div>
      <div className="cloud-device-actions">{!d.revoked&&<><button disabled={!!busy} onClick={()=>void action(d,'pause')}>{d.paused?'恢复同步':'暂停同步'}</button><button disabled={!!busy} onClick={()=>void action(d,'revoke')}>撤销设备</button></>}
      {deleting===d.id?<div className="notice"><p>删除此设备的云端历史并撤销上传权限。本机记录保留；其他设备的副本仍可见。</p><button disabled={!!busy} onClick={()=>void action(d,'delete')}>确认删除云端历史</button><button onClick={()=>setDeleting(null)}>取消</button></div>:<button disabled={!!busy} onClick={()=>setDeleting(d.id)}>删除云端历史</button>}</div></article>)}
  </section>;
}
export function CloudBind(){
  const [search]=useSearchParams(),[code,setCode]=useState(search.get('code')||''),[device,setDevice]=useState<{deviceName:string;approved:boolean;resumableDevices?:{id:string;name:string;revoked:boolean;paused:boolean}[]}|null>(null),[resume,setResume]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
  async function action(approve=false){setBusy(true);setError('');try{if(approve){await cloudRequest('/api/v3/device-authorizations/approve','POST',{code,replaceDeviceId:resume||null});setDone(true);}else{setResume('');setDevice(await cloudRequest('/api/v3/device-authorizations/inspect','POST',{code}));}}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <section className="panel cloud-bind"><h1>绑定采集设备</h1><p>输入本地应用显示的绑定码，核对设备名称后加入你的云端空间。</p><label htmlFor="binding-code">绑定码</label><input id="binding-code" value={code} maxLength={9} onChange={e=>{setCode(e.target.value.toUpperCase());setDevice(null);setDone(false);}}/><button disabled={busy||code.length!==9} onClick={()=>void action()}>核对设备</button><ErrorBox error={error?new Error(error):undefined}/>
    {device&&!done&&<div className="notice"><h2>{device.deviceName}</h2><p>该设备可同步全部已解析用量、原标题、项目路径与账户额度。聊天和凭据保留在设备上。</p>{!!device.resumableDevices?.length&&<><label htmlFor="resume-device">设备身份</label><select id="resume-device" value={resume} disabled={busy||device.approved} onChange={e=>setResume(e.target.value)}><option value="">加入一台新设备</option>{device.resumableDevices.map(d=><option key={d.id} value={d.id}>接续 {d.name}{d.revoked?'（已撤销，历史保留）':d.paused?'（同步已暂停）':''}</option>)}</select>{resume&&<p>接续所选设备将保留其云端历史与暂停设置，替换上传凭证。原凭证将立即失效；仅在这台设备重装或丢失本机身份后使用。</p>}</>}<button className="primary-button" disabled={busy||device.approved} onClick={()=>void action(true)}>{device.approved?'设备已绑定':resume?'确认接续所选设备':'确认加入此设备'}</button></div>}
    {done&&<p className="notice" role="status">{resume?'设备身份已接续，保留原云端历史与暂停设置。':'设备已加入。本机将自动开始同步历史，其他设备继续保留。'}</p>}<p><Link to="/">返回用量总览</Link></p></section>;
}
export function CloudAccounts({history=false}:{history?:boolean}){
  const q=useData<CloudAccountView[]>('account/cloud'),r=useRange();
  return <div className={history?'cloud-account-history':''}><ErrorBox error={q.error}/>{!q.error&&!q.data?.data.length&&<p className="notice">{q.isPending?'正在读取账户快照…':'暂无已确认的账户快照；请等待采集设备同步。'}</p>}
    {q.data?.data.map((a,i)=>{const historyDevices=new Set([a.historyMeta?.summarySource.deviceId,...(a.historyMeta?.dailySources.map(s=>s.deviceId)||[])].filter(Boolean));return <section key={a.accountRef} className={history?'panel account-chart':'cloud-account-group'}><h3>{a.quota.accountRef?`账户 ${i+1}`:'身份尚未确认'} · {history?(historyDevices.size>1?`${historyDevices.size} 台设备的历史`:a.historyMeta?.summarySource.deviceName||'历史来源待确认'):a.deviceName}</h3>
      {history?<>{a.historyMeta?<><p className="footnote">汇总来源：{a.historyMeta.summarySource.deviceName} · {a.historyMeta.summarySource.stale?'历史快照 · 尚未确认更新':'最近采集'} {time(a.historyMeta.summarySource.collectedAt,r.timezone)} · 接收 {time(a.historyMeta.summarySource.receivedAt,r.timezone)}</p>
        {!!a.historyMeta.dailySources.length&&<details><summary>每日历史来源：{a.historyMeta.dailySources.length} 台设备</summary><p className="footnote">保留各设备提供的日期；同一日期采用采集时间最新的历史快照。</p>{a.historyMeta.dailySources.map(s=><p key={s.deviceId} className="footnote">{s.deviceName} · {s.dates.length} 个日期 · {s.stale?'历史快照 · 尚未确认更新':'最近采集'} {time(s.collectedAt,r.timezone)} · 接收 {time(s.receivedAt,r.timezone)}<br/>日期：{s.dates.join('、')}</p>)}</details>}</>:a.history&&<p className="footnote">此历史快照尚无独立来源信息，请刷新后查看。</p>}</>:<p className="footnote">{a.stale?'历史快照 · 尚未确认更新':'最近采集'} {time(a.quota.collectedAt,r.timezone)} · 接收 {time(a.receivedAt,r.timezone)}</p>}
      {!history&&a.quota.status!=='ok'&&<p className="notice">{a.quota.status==='identity_unknown'?'采集设备尚未确认当前账户身份。':'账户采集暂不可用，显示已有快照。'}</p>}
      {history?<><p>官方原始日期 · 与设备记录分别统计</p><div className="account-facts"><span>累计 <b>{compact(a.history?.summary.lifetimeTokens)}</b></span><span>单日峰值 <b>{compact(a.history?.summary.peakDailyTokens)}</b></span><span>连续活跃 <b>{exact(a.history?.summary.currentStreakDays)} 天</b></span></div>
        {a.history?.dailyUsageBuckets?.length?<Chart account change={q.motion} rows={a.history.dailyUsageBuckets.map(b=>({time:b.startDate,totalTokens:b.tokens}))}/>:<p>暂无账户每日历史；这不代表用量为零。</p>}</>:
        <QuotaCards buckets={a.quota.buckets} now={Date.now()} formatTime={at=>time(at,r.timezone)}/>}</section>;})}
  </div>;
}
