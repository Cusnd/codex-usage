import { useContext } from "react";
import { Workspace } from "../../data/workspace.js";
import { time } from "../../widgets/ui.js";
import { useCloudSync } from "../../data/cloud-provider.js";

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
