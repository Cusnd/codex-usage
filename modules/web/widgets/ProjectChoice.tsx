import { useEffect, useState } from 'react';
import type { ProjectLabel } from '../../contracts/responses.js';
import { useData } from '../data/workspace.js';
import { useProjectLabels } from '../runtime/context.js';
import { Choice } from '../ui/Choice.js';
import { ProjectIcon } from './ProjectIdentity.js';

/** Search and page on the server; the browser only keeps the visible options. */
export function ProjectChoice({ from, to, value, onChange }: {
  from?: string; to: string; value: string; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState('');
  const [page, setPage] = useState({q:'', offset:0});
  const { projectName, projectDescription } = useProjectLabels();
  useEffect(() => {
    const timer = window.setTimeout(() => setPage({q:search.trim(), offset:0}), 200);
    return () => window.clearTimeout(timer);
  }, [search, from, to]);
  const result = useData<{items: ProjectLabel[]; total: number}>('local/project-options', {
    from, to, q:page.q || undefined, limit:50, offset:page.offset,
  }, open);
  const data = result.data?.data;
  const busy = result.isFetching || search.trim() !== page.q;
  const selectedId = value.startsWith('v:') ? value.slice(2) : undefined;
  return <Choice label="项目" value={value} onChange={onChange} searchable remote
    onOpenChange={setOpen} onSearch={setSearch}
    selection={selectedId ? {value, label:projectName(selectedId), description:projectDescription(selectedId), icon:<ProjectIcon id={selectedId}/>} : undefined}
    options={[
      {value:'',label:'全部项目'}, {value:'unknown',label:'归属待识别',icon:<ProjectIcon id={null}/>},
      ...(data?.items ?? []).map(item => ({value:'v:'+item.id, label:item.name, description:projectDescription(item.id), icon:<ProjectIcon id={item.id}/>})),
    ]}
    footer={<div className="project-choice-footer" aria-live="polite">
      {result.error ? <span role="alert">{result.error.message}</span> : <>
        <span>{busy ? '正在读取…' : `共 ${data?.total ?? 0} 项`}</span>
        <button type="button" disabled={busy || page.offset === 0} onClick={() => setPage(p => ({...p,offset:Math.max(0,p.offset-50)}))}>上一页</button>
        <button type="button" disabled={busy || page.offset + 50 >= (data?.total ?? 0)} onClick={() => setPage(p => ({...p,offset:p.offset+50}))}>下一页</button>
      </>}
    </div>}/>
}
