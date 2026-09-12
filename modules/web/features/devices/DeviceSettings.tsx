import { useQueryClient } from "@tanstack/react-query";
import { useContext, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Laptop, Plus } from "lucide-react";
import type { CloudSource } from "../../../contracts/cloud-accounts.js";
import { Workspace } from "../../data/workspace.js";
import { ErrorBox, time } from "../../widgets/ui.js";
import './cloud-workspace.css';
import { useCloudSync } from "../../data/cloud-provider.js";
import { useCloudDevices, sourceState } from './queries.js';
import { cloudRequest } from '../../adapters/cloud-http.js';

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
