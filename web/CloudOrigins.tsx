import {useEffect,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import type {SyncCut} from '../shared/sync-v3';
import {cloudRequest,useCloudDevices} from './CloudWorkspace';
import {useCloudSync} from './cloud-sync/provider';
import {ErrorBox} from './ui';

type Session={id:string;title:string|null;unknown_events:number;assigned_events:number;natural_known_events:number};
type View={lease_id:string;cut:SyncCut;summary:Omit<Session,'id'|'title'>;sessions:Session[];next_cursor:string|null};
type Operation={operation_id:string;lease_id:string;action:'assign'|'revoke';thread_ids:string[];device_id?:string};
type Result={operation_id:string;status:'pending'|'running'|'complete'|'failed';job_id?:string;affected_events?:number;cut?:SyncCut;error?:string|{message?:string;code?:string}};
type Preview={operation:Operation;count:number;deviceName?:string};
function readOperation(key:string):Preview|null{try{const value=JSON.parse(sessionStorage.getItem(key)||'null');return typeof value?.operation?.operation_id==='string'&&Array.isArray(value.operation.thread_ids)&&typeof value.count==='number'?value:null;}catch{return null;}}

/** An explicit operation uses the manager's own all-device lease, even while usage is filtered. */
export function CloudOrigins(){
  const sync=useCloudSync(),devices=useCloudDevices(),client=useQueryClient();
  const identity=sync?.source.controller.identity,queryScope=[identity?.origin,identity?.userId],operationKey='codex-usage:origin-operation:v3:'+JSON.stringify(queryScope);
  // Re-entering the manager starts a fresh preview; an old cached initial view must not pin its lease before refetch.
  const [visit]=useState(()=>crypto.randomUUID());
  const [page,setPage]=useState({lease:'',cursor:'',run:0}),[picked,setPicked]=useState<Record<string,Session>>(()=>Object.create(null)),[target,setTarget]=useState('');
  const [preview,setPreview]=useState<Preview|null>(null),[operation,setOperation]=useState<Preview|null>(()=>readOperation(operationKey)),[sending,setSending]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const completed=useRef(''),online=sync?.online!==false;
  const query=useQuery({queryKey:['cloud-origins',...queryScope,visit,page.run,page.lease,page.cursor],queryFn:({signal})=>{
    const params=new URLSearchParams({limit:'50'});if(page.lease)params.set('lease_id',page.lease);if(page.cursor)params.set('cursor',page.cursor);
    return cloudRequest<View>('/api/v3/origins?'+params,'GET',undefined,signal);
  },enabled:online&&!!identity});
  const progress=useQuery({queryKey:['cloud-origin-operation',...queryScope,operation?.operation.operation_id],queryFn:({signal})=>cloudRequest<Result>('/api/v3/origins/operations/'+encodeURIComponent(operation!.operation.operation_id),'GET',undefined,signal),enabled:online&&!!operation&&!sending,refetchInterval:query=>['complete','failed'].includes(query.state.data?.status||'')?false:1500,retry:1});
  const result=progress.data,busy=sending||!!operation,view=query.data,selection=Object.values(picked);
  const unknown=selection.reduce((n,s)=>n+s.unknown_events,0),assigned=selection.reduce((n,s)=>n+s.assigned_events,0);
  const pageSelected=!!view?.sessions.length&&view.sessions.every(session=>Object.hasOwn(picked,session.id));
  const options=(devices.data?.devices||[]).filter(d=>!d.historyDeleted&&!d.historyDeleting);
  useEffect(()=>{if(view&&!page.lease)setPage(current=>({...current,lease:view.lease_id,cursor:''}));},[view,page.lease]);
  useEffect(()=>{try{if(operation)sessionStorage.setItem(operationKey,JSON.stringify(operation));else sessionStorage.removeItem(operationKey);}catch{}},[operation,operationKey]);
  useEffect(()=>{if(!operation||sending)return;const status=(progress.error as Error&{status?:number})?.status;if(status===404){setPreview(operation);setOperation(null);setError('该操作尚未受理。可以确认重试同一请求；若历史版本已过期，请重新读取历史。');}else if(status===410){setOperation(null);setPreview(null);setError('归属操作进度已过期，请重新读取历史以核对当前结果。');}},[progress.error,operation,sending]);
  useEffect(()=>{
    if(!result||!['complete','failed'].includes(result.status)||completed.current===result.operation_id)return;
    completed.current=result.operation_id;setOperation(null);setPreview(null);setError('');
    if(result.status==='failed'){setError(typeof result.error==='string'?result.error:result.error?.message||'归属修改未完成，请重新读取历史后重试。');return;}
    setMessage(`已完成，修改 ${result.affected_events??0} 条历史记录的用户指定归属。`);setPicked(Object.create(null));setPage(current=>({lease:'',cursor:'',run:current.run+1}));
    void client.invalidateQueries({queryKey:['cloud-origins',identity?.origin,identity?.userId]});
    void sync?.refresh().catch(e=>setError('归属已保存，页面刷新未完成：'+(e as Error).message));
  },[result,client,sync]);
  function toggle(session:Session){setPicked(current=>{const next=Object.assign(Object.create(null),current);if(Object.hasOwn(next,session.id))delete next[session.id];else if(Object.keys(next).length<200)next[session.id]=session;return next;});}
  function togglePage(){setPicked(current=>{const next=Object.assign(Object.create(null),current);for(const session of view?.sessions||[])if(pageSelected)delete next[session.id];else if(Object.keys(next).length<200)next[session.id]=session;return next;});}
  function prepare(action:'assign'|'revoke'){
    if(!view||!selection.length)return;
    setError('');setMessage('');setPreview({operation:{operation_id:crypto.randomUUID(),lease_id:page.lease||view.lease_id,action,thread_ids:selection.map(s=>s.id),...(action==='assign'?{device_id:target}:{})},count:action==='assign'?unknown:assigned,deviceName:options.find(d=>d.id===target)?.name});
  }
  async function apply(){if(!preview||busy)return;setSending(true);setError('');try{
    // Persist the immutable operation before the request, including when its ACK is lost.
    try{sessionStorage.setItem(operationKey,JSON.stringify(preview));}catch{}
    client.removeQueries({queryKey:['cloud-origin-operation',...queryScope,preview.operation.operation_id],exact:true});
    setOperation(preview);
    const response=await cloudRequest<Result>('/api/v3/origins/operations','POST',preview.operation);
    client.setQueryData(['cloud-origin-operation',...queryScope,preview.operation.operation_id],response);
  }catch(e){setError((e as Error).message);if([400,403,404,409,410,422].includes((e as Error&{status?:number}).status||0))setOperation(null);}finally{setSending(false);}}
  function restart(){setPage(current=>({lease:'',cursor:'',run:current.run+1}));setPicked(Object.create(null));setPreview(null);setError('');}
  return <section className="panel cloud-origins" aria-labelledby="cloud-origins-title"><h2 id="cloud-origins-title">旧历史设备归属</h2>
    <p>仅为缺少可靠执行来源的旧记录指定设备，记录会保留“用户指定”标记。已有明确来源的消耗保持其来源；全局 Token 总量不变。</p>
    <p className="footnote">这里列出全部设备的历史。选择范围固定在本次读取的版本，之后新增的记录不会自动归入。每次最多选择 200 个 Session。</p>
    <ErrorBox error={error?new Error(error):query.error||progress.error}/>{message&&<p className="notice" role="status">{message}</p>}
    {!online&&<p className="notice">联网后可管理历史归属。</p>}
    {view&&<p>来源未知 {view.summary.unknown_events.toLocaleString()} 条 · 用户指定 {view.summary.assigned_events.toLocaleString()} 条 · 明确来源 {view.summary.natural_known_events.toLocaleString()} 条</p>}
    <div className="cloud-origin-actions"><button disabled={busy||!online} onClick={restart}>重新读取历史</button><button disabled={busy||!!preview||!online||!view?.sessions.length} onClick={togglePage}>{pageSelected?'取消本页选择':'选择本页'}</button><span>已选 {selection.length} 个 Session</span>
      <label htmlFor="origin-target">指定设备</label><select id="origin-target" value={target} disabled={busy||!!preview||!online} onChange={e=>setTarget(e.target.value)}><option value="">请选择设备</option>{options.map(d=><option key={d.id} value={d.id}>{d.name}{d.revoked?'（已撤销，历史保留）':''}</option>)}</select>
      <button disabled={busy||!!preview||!online||!unknown||!options.some(d=>d.id===target)} onClick={()=>prepare('assign')}>指定所选历史的设备</button>
      <button disabled={busy||!!preview||!online||!assigned} onClick={()=>prepare('revoke')}>撤回所选用户指定</button>
    </div>
    {preview&&!operation&&<div className="notice" role="status"><p>{preview.operation.action==='assign'?`将所选 Session 中至多 ${preview.count} 条未知来源记录指定给 ${preview.deviceName}，并保留“用户指定”标记。`:`撤回所选 Session 中至多 ${preview.count} 条用户指定，恢复原有未知来源。`}明确来源及后来新增的记录不受影响。</p><button className="primary-button" disabled={busy||!online} onClick={()=>void apply()}>确认修改归属</button> <button disabled={busy} onClick={()=>setPreview(null)}>取消</button></div>}
    {operation&&<p className="notice" role="status">{result?'归属修改已受理，正在准备完整结果；完成后自动刷新。':'正在核对归属修改结果，已保存本次操作以便恢复。'}{!online?'联网后继续查询进度。':''}</p>}
    {query.isPending&&online&&<p role="status">正在读取未知来源历史…</p>}
    {view&&!view.sessions.length&&<p>当前没有需要指定设备或可撤回用户指定的历史。</p>}
    <ul className="cloud-origin-sessions">{view?.sessions.map(session=><li key={session.id}><label><input type="checkbox" checked={!!picked[session.id]} disabled={busy||!!preview||!online||!picked[session.id]&&selection.length>=200} aria-label={`选择历史 ${session.title||session.id}`} onChange={()=>toggle(session)}/><span><strong>{session.title||session.id}</strong><small>未知来源 {session.unknown_events} 条 · 用户指定 {session.assigned_events} 条 · 明确来源 {session.natural_known_events} 条</small><small>{session.id}</small></span></label></li>)}</ul>
    {view?.next_cursor&&<button disabled={busy||!!preview||!online} onClick={()=>setPage({...page,lease:page.lease||view.lease_id,cursor:view.next_cursor!})}>下一页历史</button>}
  </section>;
}
