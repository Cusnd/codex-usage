import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

/** Source exports without Git metadata can still be built; working checkouts must not hide production files. */
export function ignoredSourceFiles(root, files) {
  if(!existsSync(path.join(root,'.git'))||!files.length)return [];
  const result=spawnSync('git',['check-ignore','--no-index','--stdin'],{cwd:root,input:files.join('\n')+'\n',encoding:'utf8',windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0&&result.status!==1)throw new Error('Cannot check source ignore rules: '+result.stderr);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

/** A module's public paths and allowed dependencies are explicit; runtime checks also apply to type imports. */
export function moduleOwner(modules, file) {
  return modules.filter(module => module.paths.some(p => p.endsWith('/') ? file.startsWith(p) : file === p))
    .sort((a,b) => Math.max(...b.paths.map(p=>p.length)) - Math.max(...a.paths.map(p=>p.length)))[0];
}
export function dependencyViolations(modules, edge) {
  const from=moduleOwner(modules,edge.from),to=moduleOwner(modules,edge.to);
  if(!from||!to||from.id===to.id)return [];
  const location=`${edge.from}:${edge.line} -> ${edge.to}`,errors=[];
  if(!from.dependencies.includes(to.id))errors.push(`${location}: ${from.id} cannot depend on ${to.id}`);
  if(!to.public.includes(edge.to))errors.push(`${location}: private entry`);
  if(to.runtime!=='universal'&&to.runtime!==from.runtime)errors.push(`${location}: ${from.runtime} cannot import ${to.runtime}`);
  return errors;
}
