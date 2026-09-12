import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('parallel materialization observes every budget rejection without leaking a Promise',()=>{
  // Run in a separate Node process so the regression can inspect unhandledRejection
  // without changing this test runner's process-wide rejection policy or listeners.
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:10000,
    input:`
      import assert from 'node:assert/strict';
      import {queryBudget,QueryBudgetExhausted} from './modules/sync/jobs/query-budget.ts';
      import {materializeCanonical} from './modules/sync/apply/apply.ts';
      const unhandled=[],sent={reads:0,batches:0};
      process.on('unhandledRejection',error=>unhandled.push(String(error)));
      const base={
        prepare(){return {bind(){return this;},async all(){sent.reads++;return {results:[]};}};},
        async batch(){sent.batches++;return [];},
      };
      const limited=queryBudget(base,2);
      // Two ID chunks: assignmentRules starts one read, then the parallel two-query
      // read batch exhausts the budget. The assignment's next chunk rejects later.
      const canonical=new Map(Array.from({length:500},(_,i)=>[
        String(i).padStart(4,'0')+'x'.repeat(1020),{origin_device_id:null,origin_conflict:false},
      ]));
      await assert.rejects(materializeCanonical(limited.db,{user_id:'test',active_epoch:'test'},canonical),QueryBudgetExhausted);
      await new Promise(resolve=>setImmediate(resolve));
      assert.deepEqual(unhandled,[]);
      assert.deepEqual(sent,{reads:1,batches:0});
      assert.equal(limited.stats.queries,1);
      console.log(JSON.stringify({unhandled,sent,queries:limited.stats.queries}));
    `,
  });
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()),{unhandled:[],sent:{reads:1,batches:0},queries:1});
});
