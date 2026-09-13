import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ProjectSourceResolver,type CodexProjectMap,type GitProjectRead} from '../modules/organization/source-node.js';

const empty=():CodexProjectMap=>({database:null,schema:null,projects:[],roots:[],threads:[],projectlessThreadIds:[],issues:[]});
test('bounded metadata refresh matches serial resolution, shares repository reads, and observes invalidation',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'performance-projects-'));
  try{
    const roots=Array.from({length:8},(_,i)=>path.join(dir,`repo-${i}`));
    for(const root of roots){await mkdir(path.join(root,'.git'),{recursive:true});await mkdir(path.join(root,'nested'));}
    const inputs=roots.flatMap((cwd,i)=>[{cwd,threadId:`thread-${i}`},{cwd:path.join(cwd,'nested'),threadId:`nested-${i}`}]);
    let active=0,peak=0,remote='https://example.test/owner/before.git';const counts=new Map<string,number>();
    const runGit:GitProjectRead=async(cwd,args)=>{
      active++;peak=Math.max(peak,active);counts.set(cwd,(counts.get(cwd)||0)+1);
      try{
        await new Promise(resolve=>setTimeout(resolve,2));
        if(args[0]==='rev-parse')return `${cwd}\n${path.join(cwd,'.git')}\n`;
        if(args[0]==='symbolic-ref')return 'main\n';
        if(args[1]==='--get')return 'origin\n';
        return `remote.origin.url\n${remote}\0`;
      }finally{active--;}
    };
    const serial=new ProjectSourceResolver({collectorId:'fixed',codexRoot:dir,projectMap:empty(),runGit}),expected=[];
    for(const input of inputs)expected.push(await serial.resolve(input));
    counts.clear();peak=0;
    const concurrent=new ProjectSourceResolver({collectorId:'fixed',codexRoot:dir,projectMap:empty(),runGit});
    assert.deepEqual(await concurrent.resolveMany(inputs),expected);
    assert.equal(counts.size,roots.length);assert.ok([...counts.values()].every(n=>n===4),'one Git read group per repository, including concurrent nested paths');
    assert.ok(peak<=12,'at most four resolutions with three independent Git commands each');
    assert.deepEqual(await concurrent.resolveMany([]),[]);
    remote='https://example.test/owner/after.git';concurrent.invalidate();
    const refreshed=await concurrent.resolveMany(inputs);
    assert.notDeepEqual(refreshed[0].git,expected[0].git);
    assert.equal(refreshed[0].sourceProjectId,expected[0].sourceProjectId);
  }finally{
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('performance-projects-'));
    await rm(dir,{recursive:true,force:true});
  }
});

test('a failed prefetch retries on the next source and preserves ordered historical fallback',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'performance-project-retry-')),repo=path.join(dir,'repo');
  try{
    await mkdir(path.join(repo,'.git'),{recursive:true});
    const inputs=[{cwd:repo,threadId:'first'},{cwd:repo,threadId:'retry'},{cwd:path.join(repo,'unavailable'),threadId:'historical'}];
    const reader=():GitProjectRead=>{
      let fail=true;
      return async(cwd,args)=>{
        await new Promise(resolve=>setTimeout(resolve,1));
        if(args[0]==='rev-parse'){
          if(fail){fail=false;throw Error('synthetic Git read failure');}
          return `${cwd}\n${path.join(cwd,'.git')}\n`;
        }
        if(args[0]==='symbolic-ref')return 'main\n';
        if(args[1]==='--get')return 'origin\n';
        return 'remote.origin.url\nhttps://example.test/owner/repo.git\0';
      };
    };
    const serial=new ProjectSourceResolver({collectorId:'fixed',codexRoot:dir,projectMap:empty(),runGit:reader()}),expected=[];
    for(const input of inputs)expected.push(await serial.resolve(input));
    const resolver=new ProjectSourceResolver({collectorId:'fixed',codexRoot:dir,projectMap:empty(),runGit:reader()});
    const actual=await resolver.resolveMany(inputs);
    assert.deepEqual(actual,expected);
    assert.equal(actual[0].kind,'unresolved');assert.ok(actual[0].provenance.conflicts.includes('git-read-failed'));
    assert.equal(actual[1].kind,'git');assert.equal(actual[2].provenance.method,'persisted-evidence');
    assert.equal(actual[2].sourceProjectId,actual[1].sourceProjectId);
  }finally{
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('performance-project-retry-'));
    await rm(dir,{recursive:true,force:true});
  }
});
