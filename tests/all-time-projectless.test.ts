import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../modules/storage/sqlite.js';
import { StreamingImporter } from '../modules/collection/importer.js';
import { localAnalyticsStore, localProjectLabels } from '../modules/collection/analytics.js';
import { Queries } from '../modules/analytics/sqlite.js';
import { bucketRange, bucketTimes, resolveTrendBucket, resolveUsageRange } from '../modules/foundation/time-range.js';
import { projectDisplay } from '../modules/organization/projects.js';
import { kindsFromProjects, namesFromProjects } from '../modules/web/adapters/project-labels.js';
import { readTrendParent } from '../modules/web/features/analysis/trend-range.js';

test('all-time has no fabricated starting date and long trends choose a bounded useful scale', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  const range = resolveUsageRange('all', 'America/New_York', now);
  assert.deepEqual(range,{from:undefined,to:'2026-09-13T12:00:00.000Z',valid:true});
  assert.equal(resolveTrendBucket(null,'all','2026-09-01T00:00:00Z',range.to,'UTC'),'day');
  assert.equal(resolveTrendBucket(null,'all','2026-01-01T00:00:00Z',range.to,'UTC'),'week');
  assert.equal(resolveTrendBucket(null,'all','2023-01-01T00:00:00Z',range.to,'UTC'),'month');
  assert.equal(resolveTrendBucket('day','all','2023-01-01T00:00:00Z',range.to,'UTC'),'day');
  assert.deepEqual(bucketTimes('2026-01-31T12:00:00Z','2026-04-01T00:00:00Z','UTC','month'),['2026-01-01','2026-02-01','2026-03-01']);
  assert.deepEqual(bucketRange('2026-03-02','week','America/New_York','2026-03-01T00:00:00Z','2026-03-10T00:00:00Z'),{from:'2026-03-02T05:00:00.000Z',to:'2026-03-09T04:00:00.000Z'});
  const parent={range:'all',from:'2023-01-01T00:00:00Z',to:range.to,bucket:'month'};
  assert.deepEqual(readTrendParent(JSON.stringify(parent)),parent);
});

test('explicit projectless evidence selects the session title while aliases preserve type and custom names', () => {
  const project={id:'logical',name:null,members:['source']};
  const sources=[{id:'source',kind:'session',root:'/temporary/output'}];
  const threads=[{id:'child',title:'Agent title',sourceProjectId:'source',parentId:'main'}, {id:'main',title:'会话的标题',sourceProjectId:'source'}];
  assert.deepEqual(projectDisplay(project,sources,threads),{name:'会话的标题',kind:'session'});
  assert.deepEqual(projectDisplay(project,sources,[{...threads[1],title:' '}]),{name:'会话 main',kind:'session'});
  assert.equal(projectDisplay({...project,name:'保留人工命名'},sources,threads).name,'保留人工命名');
  assert.notEqual(projectDisplay(project,[{id:'source'}],threads).kind,'session');
  const projects=[{...project,display:projectDisplay(project,sources,threads)}];
  const aliases={old:'logical'},membership=[{id:'source',logical_project_id:'logical'}];
  assert.equal(namesFromProjects(projects,aliases,membership).old,'会话的标题');
  assert.equal(kindsFromProjects(projects,aliases,membership).source,'session');
});

test('native queries keep projectless sessions distinct even in the same directory and include old records exactly', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'usage-all-time-'));
  const store=new Store(':memory:'); let importer:StreamingImporter|undefined;
  try {
    await mkdir(path.join(root,'sessions'));
    await writeFile(path.join(root,'.codex-global-state.json'),JSON.stringify({'projectless-thread-ids':['chat-a','chat-b']}));
    await writeFile(path.join(root,'session_index.jsonl'),JSON.stringify({id:'chat-a',thread_name:'明确的会话标题',updated_at:'2026-09-13T00:00:00Z'})+'\n');
    for (const [id,at,total] of [['chat-a','2020-01-01T00:00:00Z','9007199254740993'],['chat-a','2026-09-13T00:00:00Z','7'],['chat-b','2026-09-12T00:00:00Z','11']]) {
      const records=[{type:'session_meta',payload:{id,cwd:'C:\\same-session-output'}},
        {type:'token_usage_record',timestamp:at,payload:{thread_id:id,turn_id:'turn',response_id:id+at,usage:{input_tokens:total,cached_input_tokens:'0',cache_write_input_tokens:'0',output_tokens:'0',reasoning_output_tokens:'0',total_tokens:total}}}];
      await writeFile(path.join(root,'sessions',id+'-'+at.slice(0,4)+'.jsonl'),records.map(record=>JSON.stringify(record)).join('\n')+'\n');
    }
    importer=new StreamingImporter(store,root); await importer.scan();
    const queries=new Queries(localAnalyticsStore(store));
    const all=resolveUsageRange('all','UTC',Date.parse('2026-09-14T00:00:00Z'));
    assert.equal(queries.summary(all).totalTokens,'9007199254741011');
    assert.equal(queries.summary({from:'2026-09-01T00:00:00Z',to:all.to}).totalTokens,'18');
    const scope=queries.scope(all);
    assert.equal(scope.firstAt,'2020-01-01T00:00:00.000Z');
    assert.deepEqual(scope.groups,[{project:'session:chat-a',threadCount:1},{project:'session:chat-b',threadCount:1}]);
    assert.equal(localProjectLabels(store,['session:chat-a'])[0].name,'明确的会话标题');
    assert.equal(localProjectLabels(store,['session:chat-b'])[0].name,'会话 chat-b');
    assert.equal(queries.detail('chat-a')?.thread.project,'session:chat-a');
    assert.equal(queries.threads({project:'session:chat-b'},20,0).total,1);
    assert.equal(store.one('SELECT MIN(project) project FROM usage_events')!.project,'c:\\same-session-output');
    const monthly=queries.trend(all,'month');
    assert.equal(monthly.reduce((sum,row)=>sum+BigInt(row.totalTokens!),0n),9007199254741011n);
    assert.deepEqual(queries.scope({model:'does-not-exist'}),{firstAt:null,lastAt:null,groups:[]});
  } finally { await importer?.close();store.close();await rm(root,{recursive:true,force:true}); }
});
