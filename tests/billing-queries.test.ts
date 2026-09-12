import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../modules/storage/sqlite.js';
import { Queries } from '../modules/analytics/sqlite.js';
import type { SQLInputValue } from 'node:sqlite';

function event(store: Store, id: string, tier: string | null, input: string, cached: string, output: string) {
  store.run(`INSERT INTO usage_events(file,event_key,thread_id,turn_id,response_id,at,project,model,effort,kind,
    input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,
    incomplete,excluded,active,service_tier,service_tier_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ['fixture',id,'billing-task',id,id,'2026-09-12T07:00:00.000Z','billing-project','gpt-6-astra','high','record',
    input,cached,'0',output,'0',String(BigInt(input)+BigInt(output)),0,0,1,tier,tier?'settings':null]);
}
function fallback(store: Store) {
  return new Queries({ all:store.all.bind(store),settings:store.settings.bind(store),readSnapshot:store.readSnapshot.bind(store),
    one<T=Record<string,any>>(sql:string,params?:SQLInputValue[]) {
      const row=store.one(sql,params);
      return (sql.includes('total_tokens_digits')?{...row,total_tokens_digits:40}:row) as T|undefined;
    } });
}

test('subscription default and API opt-in group Fast separately with identical SQL and BigInt results', () => {
  const store=new Store(':memory:');
  try {
    store.run("INSERT INTO threads(id,title,project) VALUES('billing-task','Billing fixture','billing-project')");
    event(store,'standard','standard','1000','200','100');
    event(store,'fast','fast','1000000','200000','100000');
    event(store,'unknown',null,'300','60','30');
    store.saveSettings({...store.settings(),costEnabled:true});
    const sql=new Queries(store),slow=fallback(store),subscription=sql.summary();
    assert.equal(store.settings().officialApiPricing,false);
    assert.equal(subscription.totalTokens,'1101430');
    assert.equal(subscription.cost?.currency,'USD');
    assert.equal(subscription.cost?.billingBasis,'subscription');
    assert.equal(subscription.cost?.amount,'33.013200000000');
    assert.equal(subscription.cost?.complete,false);
    assert.deepEqual(subscription.cost?.serviceTiers?.map(t=>[t.tier,t.totalTokens]),[
      ['standard','1100'],['fast','1100000'],['unknown','330'],
    ]);
    assert.equal(sql.summary({turnId:'unknown'} as any).cost?.amount,null);
    for (const officialApiPricing of [false,true]) {
      store.saveSettings({...store.settings(),officialApiPricing});
      const summary=sql.summary();
      assert.equal(summary.totalTokens,subscription.totalTokens);
      assert.equal(summary.cost?.currency,'USD');
      assert.equal(summary.cost?.billingBasis,officialApiPricing?'api':'subscription');
      assert.equal(summary.cost?.amount,officialApiPricing?'47.813200000000':'33.013200000000');
      assert.deepEqual(summary,slow.summary());
      assert.deepEqual(sql.trend({},'day'),slow.trend({},'day'));
      assert.deepEqual(sql.groups({},'model'),slow.groups({},'model'));
      assert.deepEqual(sql.allTurns({},2,0),slow.allTurns({},2,0));
      assert.deepEqual(sql.threads({},1,0),slow.threads({},1,0));
      assert.deepEqual(sql.agents('billing-task'),slow.agents('billing-task'));
      assert.deepEqual(sql.compare({from:'2026-09-12T00:00:00Z',to:'2026-09-13T00:00:00Z'},'model'),
        slow.compare({from:'2026-09-12T00:00:00Z',to:'2026-09-13T00:00:00Z'},'model'));
    }
  } finally {store.close();}
});

test('historical absent tiers remain unpriced and do not become Standard on API opt-in', () => {
  const store=new Store(':memory:');
  try {
    event(store,'old',null,'1000','200','100');
    for (const officialApiPricing of [false,true]) {
      store.saveSettings({...store.settings(),costEnabled:true,officialApiPricing});
      const result=new Queries(store).summary();
      assert.equal(result.totalTokens,'1100');
      assert.equal(result.cost?.amount,null);
      assert.equal(result.cost?.complete,false);
      assert.equal(result.cost?.serviceTiers?.find(t=>t.tier==='unknown')?.totalTokens,'1100');
    }
    store.saveSettings({...store.settings(),costEnabled:false});
    assert.equal(new Queries(store).summary().cost,null);
  } finally {store.close();}
});

test('mixed missing and explicit unknown tiers form one bucket in both aggregation paths', () => {
  const store=new Store(':memory:');
  try {
    event(store,'missing',null,'1000','200','100');
    event(store,'explicit','unknown','1000','200','100');
    event(store,'known','standard','1000','200','100');
    store.saveSettings({...store.settings(),costEnabled:true});
    const actual=new Queries(store).summary();
    assert.deepEqual(actual,fallback(store).summary());
    assert.equal(actual.cost?.amount,'0.013200000000');
    assert.equal(actual.cost?.serviceTiers?.find(t=>t.tier==='unknown')?.eventCount,2);
    assert.equal(actual.cost?.serviceTiers?.find(t=>t.tier==='unknown')?.totalTokens,'2200');
  } finally {store.close();}
});
