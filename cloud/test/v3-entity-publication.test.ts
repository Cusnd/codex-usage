import {env} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {stableJson} from '../../modules/contracts/sync.js';
import {sha256} from '../../modules/platform/worker/http.js';
import {domain,entityStatements,type EntityMutation} from '../../modules/sync/publication/store.js';
import {d1PublicationStore} from '../../modules/sync/publication/commit.js';
import {actor} from './performance-fixture';

it('publishes mixed entity keys, exact payload hashes and null tombstones atomically',async()=>{
  const a=await actor(),initial=await domain(env.DB,a.user),id='同名/"实体';
  const event={total_tokens:'9007199254741001',cached_input_tokens:null,thread_id:id};
  const thread={id,title:'标题与 emoji 🧪',source_project_id:null};
  const first:EntityMutation[]=[{kind:'event',id,revision:1,value:event},{kind:'thread',id,revision:1,value:thread,thread_id:id}];
  const store=d1PublicationStore(env.DB);
  await store.commit({head:initial,operationId:'first',hasChanges:true,effects:await entityStatements(env.DB,initial,first)});
  const head=await domain(env.DB,a.user),second:EntityMutation[]=[{kind:'event',id,revision:2,value:null},{kind:'thread',id,revision:2,value:{...thread,title:'new'},thread_id:id}];
  await store.commit({head,operationId:'second',hasChanges:true,effects:await entityStatements(env.DB,head,second)});
  const rows=(await env.DB.prepare('SELECT kind,valid_from,valid_to,revision,hash,payload FROM v3_entity_versions WHERE user_id=? ORDER BY valid_from,kind').bind(a.user).all()).results;
  expect(rows).toEqual([
    {kind:'event',valid_from:1,valid_to:2,revision:1,hash:await sha256(stableJson(event)),payload:stableJson(event)},
    {kind:'thread',valid_from:1,valid_to:2,revision:1,hash:await sha256(stableJson(thread)),payload:stableJson(thread)},
    {kind:'event',valid_from:2,valid_to:null,revision:2,hash:await sha256('null'),payload:null},
    {kind:'thread',valid_from:2,valid_to:null,revision:2,hash:await sha256(stableJson(second[1].value)),payload:stableJson(second[1].value)},
  ]);
  expect((await env.DB.prepare('SELECT entity_count FROM v3_commits WHERE user_id=? ORDER BY commit_seq').bind(a.user).all()).results).toEqual([{entity_count:2},{entity_count:2}]);
  await expect(store.commit({head,operationId:'stale',hasChanges:true,effects:await entityStatements(env.DB,head,second)})).rejects.toThrow(/CHECK/);
  expect((await domain(env.DB,a.user)).commit_seq).toBe(2);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_changes WHERE user_id=?').bind(a.user).first('n')).toBe(4);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM v3_apply_guards WHERE user_id=?').bind(a.user).first('n')).toBe(0);
});
