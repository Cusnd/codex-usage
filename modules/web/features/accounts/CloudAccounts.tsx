import type { CloudAccountView } from "../../../contracts/cloud-accounts.js";
import { useData, useRange } from "../../data/workspace.js";
import { ErrorBox, time } from "../../widgets/ui.js";
import { QuotaCards } from "./QuotaCards.js";
import { Chart } from "../../widgets/Chart.js";
import { compact, exact } from '../../ui/format.js';

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
