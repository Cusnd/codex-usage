import {useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import type {SyncCut} from '../shared/sync-v3';
import type {LogicalProject,ProjectEdge} from '../shared/usage-domain/projects';
import {cloudRequest,useCloudDevices} from './CloudWorkspace';
import {useCloudSync} from './cloud-sync/provider';
import {ErrorBox} from './ui';

type Source={id:string;device_id:string;name?:string;kind?:string;root?:string;repository?:string;confidence?:string;reason?:string;logical_project_id:string|null};
type View={cut:SyncCut;projects:LogicalProject[];sources:Source[];aliases:Record<string,string>;blocked_edges:ProjectEdge[]};
type Operation={action:'merge'|'split'|'reset'|'rename';project_ids?:string[];project_id?:string;name?:string|null;groups?:{source_ids:string[];name?:string}[]};
const reasonLabel:Record<string,string>={session:'同一会话', 'primary-remote':'同一主仓库', 'local-repository':'本机同一仓库', 'app-project':'本机同一 App 项目'};
function repositoryLabel(value:string){try{if(value.startsWith('repo1:')){const [host,port,repository]=JSON.parse(value.slice(6));if(typeof host==='string'&&typeof repository==='string')return host+(port?':'+port:'')+'/'+repository;}}catch{}return value;}

export function CloudProjects(){
  const client=useQueryClient(),sync=useCloudSync(),devices=useCloudDevices();
  const deviceNames=new Map(devices.data?.devices.map(d=>[d.id,d.name])||[]);
  const query=useQuery({queryKey:['cloud-projects',sync?.state.activeLease?.cut.organization_version],queryFn:({signal})=>cloudRequest<View>('/api/v3/projects','GET',undefined,signal),enabled:sync?.online!==false});
  const [selected,setSelected]=useState<string[]>([]),[sourceSelection,setSourceSelection]=useState<Record<string,string[]>>({}),[names,setNames]=useState<Record<string,string>>({});
  const [pending,setPending]=useState<{operation:Operation;description:string;id:string;version:number}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const view=query.data,sources=new Map(view?.sources.map(s=>[s.id,s])||[]),picked=selected.filter(id=>view?.projects.some(p=>p.id===id));
  const label=(p:LogicalProject)=>p.name||sources.get(p.members[0])?.name||sources.get(p.members[0])?.root||'未命名项目';
  function preview(operation:Operation,description:string){if(view)setPending({operation,description,id:crypto.randomUUID(),version:view.cut.organization_version});}
  async function apply(){if(!pending||!view||busy)return;setBusy(true);setError('');try{
    await cloudRequest('/api/v3/projects/operations','POST',{operation_id:pending.id,base_organization_version:pending.version,...pending.operation});
    await sync?.refresh();await client.invalidateQueries({queryKey:['cloud-projects']});await client.invalidateQueries({queryKey:['local']});setSelected([]);setSourceSelection({});setPending(null);
  }catch(e){setError((e as Error).message);await client.invalidateQueries({queryKey:['cloud-projects']});}finally{setBusy(false);}}
  return <section className="panel cloud-projects" aria-labelledby="cloud-projects-title"><h2 id="cloud-projects-title">项目归并</h2>
    <p>根据会话身份、主仓库和本机项目信息归并来源。人工合并、拆分和命名会保留；恢复自动归并会移除所选项目的人工分组。</p>
    <ErrorBox error={query.error||(error?new Error(error):undefined)}/>{sync?.online===false&&<p className="notice">联网后可管理项目归并。</p>}
    <div className="cloud-project-actions"><span>已选择 {picked.length} 个项目</span><button disabled={busy||picked.length<2||sync?.online===false} onClick={()=>preview({action:'merge',project_ids:picked},`将选中的 ${picked.length} 个项目合并为一个项目。`)}>合并所选项目</button>
      <button disabled={busy||!picked.length||sync?.online===false} onClick={()=>preview({action:'reset',project_ids:picked},`恢复所选 ${picked.length} 个项目的自动归并规则。`)}>恢复自动归并</button></div>
    {pending&&<div className="notice" role="status"><p>{pending.description}</p><button className="primary-button" disabled={busy} onClick={()=>void apply()}>{busy?'正在保存…':'确认应用'}</button> <button disabled={busy} onClick={()=>setPending(null)}>取消</button></div>}
    {query.isPending&&sync?.online!==false&&<p role="status">正在读取项目来源…</p>}{view&&!view.projects.length&&<p>尚无已同步的项目来源。</p>}
    {view?.projects.map(project=>{const chosen=(sourceSelection[project.id]||[]).filter(id=>project.members.includes(id));return <article key={project.id} className="cloud-project-row">
      <div className="cloud-project-heading"><label><input type="checkbox" checked={picked.includes(project.id)} aria-label={`选择项目 ${label(project)}`} onChange={()=>setSelected(picked.includes(project.id)?picked.filter(id=>id!==project.id):[...picked,project.id])}/><strong>{label(project)}</strong></label><small>{project.manual?'人工分组':'自动归并'} · {project.members.length} 个来源</small></div>
      <div className="cloud-project-name"><input aria-label={`项目名称 ${label(project)}`} placeholder={label(project)} value={names[project.id]??project.name??''} maxLength={160} disabled={busy} onChange={e=>{setNames({...names,[project.id]:e.target.value});if(pending?.operation.action==='rename'&&pending.operation.project_id===project.id)setPending(null);}}/><button disabled={busy||sync?.online===false} onClick={()=>{const name=(names[project.id]??project.name??'').trim()||null;preview({action:'rename',project_id:project.id,name},name?`将项目「${label(project)}」的显示名称保存为「${name}」。`:`清除项目「${label(project)}」的自定义名称，恢复自动显示名称。`);}}>保存名称</button></div>
      <details><summary>查看来源及归并依据</summary><ul className="cloud-project-sources">{project.members.map(id=>{const source=sources.get(id),deviceName=source&&deviceNames.get(source.device_id)||'未知设备';return <li key={id}><label><input type="checkbox" aria-label={`拆分来源 ${deviceName} ${source?.root||source?.name||id}`} checked={chosen.includes(id)} onChange={()=>setSourceSelection({...sourceSelection,[project.id]:chosen.includes(id)?chosen.filter(x=>x!==id):[...chosen,id]})}/><span>{source?.name||source?.root||'无路径来源'}<small>{source?.root||'无工作目录'} · {deviceName}</small>{source?.repository&&<small>{repositoryLabel(source.repository)}</small>}</span></label></li>;})}</ul>
        <p className="footnote">{[...new Set(project.reasons.map(r=>reasonLabel[r.reason]||r.reason))].join('、')||'保留独立来源'}</p>
        <button disabled={busy||!chosen.length||chosen.length===project.members.length||sync?.online===false} onClick={()=>preview({action:'split',project_id:project.id,groups:[{source_ids:chosen},{source_ids:project.members.filter(id=>!chosen.includes(id))}]},`将 ${label(project)} 拆为两组，分别包含 ${chosen.length} 和 ${project.members.length-chosen.length} 个来源。`)}>将勾选来源拆为另一项目</button>
      </details></article>;})}
    {!!view?.blocked_edges.length&&<p className="footnote">{view.blocked_edges.length} 条自动关联因人工分组约束暂未应用。</p>}
  </section>;
}
