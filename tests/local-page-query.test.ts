import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../modules/storage/sqlite.js';
import { Queries } from '../modules/analytics/sqlite.js';
import { localAnalyticsStore, localProjectKinds, localProjectLabels } from '../modules/collection/analytics.js';
import { createApp } from '../apps/local/app.js';

function seed(store:Store, chats=2) {
  store.db.exec('CREATE TABLE IF NOT EXISTS local_v3_events(event_id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS collector_projects(id TEXT PRIMARY KEY,raw_identity TEXT NOT NULL,value TEXT NOT NULL);');
  store.transaction(()=>{
    store.run('INSERT INTO collector_projects(id,raw_identity,value) VALUES(?,?,?)',['project','project',JSON.stringify({kind:'app',root:'/project',observedCwd:'/project',name:'Regular project'})]);
    for(let i=0;i<chats+2;i++) {
      const id='t'+i,session=i<chats,source=session?'s'+i:i===chats?'project':'missing',project=session?'/shared':i===chats?'/project':'session:ordinary-path';
      store.run('INSERT INTO threads(id,title,project) VALUES(?,?,?)',[id,i===1?null:'Title '+id,project]);
      if(session)store.run('INSERT INTO collector_projects(id,raw_identity,value) VALUES(?,?,?)',[source,source,JSON.stringify({kind:'session',root:'/shared',observedCwd:'/shared',sessionId:id})]);
      for(let e=0;e<2;e++) {
        const event=id+'-'+e,total=i===0&&e===0?'10000000000000000000000000':'10',at=e?'2026-09-12T00:00:00.000Z':'2020-01-01T00:00:00.000Z';
        store.run('INSERT INTO local_v3_events(event_id,data) VALUES(?,?)',[event,JSON.stringify({source_project_id:source})]);
        store.run(`INSERT INTO usage_events(file,event_key,thread_id,turn_id,at,project,model,kind,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,active) VALUES(?,?,?,?,?,?,?,'record',?,'0','0','0','0',?,1)`,['fixture',event,id,event,at,project,'model',total,total]);
      }
    }
  });
}

test('local typed planning preserves mixed identities and exact results while recovering filter indexes',()=>{
  const store=new Store(':memory:');
  try {
    seed(store);
    const current=new Queries(localAnalyticsStore(store),{projectKinds:localProjectKinds});
    const referenceStore={...localAnalyticsStore(store),forQuery:undefined};
    const reference=new Queries(referenceStore,{projectKinds:localProjectKinds});
    const check=()=>{
      for(const f of [{},{project:'/project'},{project:'session:t0'},{project:'session:t1'},{project:'session:ordinary-path'},{project:'/shared'},{model:'missing'},{unknown:'project' as const},{threadIds:[]},{from:'2026-01-01T00:00:00Z'}]) {
        assert.deepEqual(current.summary(f),reference.summary(f));
        assert.deepEqual(current.scopeSummary(f),reference.scopeSummary(f));
        assert.deepEqual(current.overview(f,'month'),reference.overview(f,'month'));
        assert.deepEqual(current.threads(f,20,0),reference.threads(f,20,0));
      }
    };
    check();
    assert.deepEqual(current.scopeSummary(),{firstAt:'2020-01-01T00:00:00.000Z',lastAt:'2026-09-12T00:00:00.000Z',projectCount:1,projectlessChatCount:2,unresolvedChatCount:1});
    const original=store.all('SELECT * FROM usage_events ORDER BY file,event_key');
    store.run("UPDATE collector_projects SET value=json_set(value,'$.kind','app','$.name','Assigned project') WHERE id='s0'");
    check();
    assert.equal(current.summary({project:'session:t0'}).eventCount,0);
    assert.deepEqual(store.all('SELECT * FROM usage_events ORDER BY file,event_key'),original);
    store.run("UPDATE collector_projects SET value=json_set(value,'$.kind','session') WHERE id='s0'");
    store.run("UPDATE local_v3_events SET data=json_set(data,'$.source_project_id','project') WHERE event_id='t0-1'");
    check();
    assert.equal(current.summary({project:'session:t0'}).eventCount,1);
    assert.equal(localProjectLabels(store,['session:ordinary-path'])[0].kind,'unknown');
    const all=store.all.bind(store),one=store.one.bind(store),plans:string[]=[],sqls:string[]=[];
    store.all=((sql:string,p:any[]=[])=>{sqls.push(sql);plans.push(...all('EXPLAIN QUERY PLAN '+sql,p).map(row=>String(row.detail)));return all(sql,p);}) as Store['all'];
    store.one=((sql:string,p:any[]=[])=>{sqls.push(sql);plans.push(...all('EXPLAIN QUERY PLAN '+sql,p).map(row=>String(row.detail)));return one(sql,p);}) as Store['one'];
    current.summary({project:'/project',to:'2026-09-13T00:00:00Z'});
    assert(plans.some(detail=>detail.includes('events_project_time')),'project filter uses canonical project/time index');
    sqls.length=0;
    current.summary({});current.trend({},'month');
    assert(sqls.every(sql=>!sql.includes('local_v3_events')),'unfiltered summary/trend do not resolve identity');
    sqls.length=0;current.filters({},{projects:false});
    assert(sqls.every(sql=>!sql.includes('DISTINCT project value')),'new filter contract skips project directory query');
  } finally {store.close();}
});

test('local POST page queries return compact scope, bounded inline identity and fresh metadata',async()=>{
  const {app,store}=await createApp({database:':memory:',startup:false});
  try {
    seed(store,2100);
    const post=(route:string,payload:Record<string,unknown>={})=>app.inject({method:'POST',url:'/api/local/query?route='+encodeURIComponent(route),payload});
    const overview=await post('overview',{bucket:'month'});
    assert.equal(overview.statusCode,200,overview.body);
    const page=overview.json();
    assert.equal(page.data.scope.projectCount,1);assert.equal(page.data.scope.projectlessChatCount,2100);assert.equal(page.data.scope.unresolvedChatCount,1);
    assert.equal(page.data.metrics.totalTokens,'10000000000000000000042030');
    assert.deepEqual(page.meta.projectLabels,[]);
    assert(!Object.hasOwn(page.data.scope,'groups'));
    assert(overview.body.length<6000,'overview does not carry a project/session directory');
    const legacy=await app.inject({url:'/api/local/overview?bucket=month'});
    assert.deepEqual(legacy.json(),page);
    const filtered=await post('overview',{project:'session:t0',bucket:'month'});
    assert.equal(filtered.json().meta.projectLabels[0].name,'Title t0');
    assert.equal(filtered.json().meta.projectLabels.length,1);
    const list=await post('threads',{limit:20});
    assert.equal(list.statusCode,200,list.body);assert(list.json().meta.projectLabels.length<=20);
    assert.equal(list.json().data.total,2102);
    const options=await post('project-options',{project:'session:t0',q:'Title t20',limit:7});
    assert.equal(options.statusCode,200,options.body);assert.equal(options.json().data.items.length,7);
    assert(options.json().data.total>7,'project choice ignores selected project and searches titles server-side');
    assert(options.json().data.items.every((row:any)=>row.name.includes('Title t20')));
    const optionsNext=await post('project-options',{q:'Title t20',limit:7,offset:7});
    assert.notEqual(options.json().data.items[0].id,optionsNext.json().data.items[0].id);
    const unnamed=await post('project-options',{q:'会话 t1'});assert.equal(unnamed.json().data.items[0].name,'会话 t1');
    const filters=await post('filters');assert.deepEqual(filters.json().data.projects,[]);
    const detail=await post('threads/t0');assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().meta.projectLabels[0].kind,'session');
    const ids=Array.from({length:2100},(_,i)=>'session:t'+i);
    const labels=await post('project-labels',{ids});assert.equal(labels.statusCode,200,labels.body);assert.equal(labels.json().data.length,2100);
    const invalid=await post('overview',{from:'bad-date'});assert.equal(invalid.statusCode,400);
    const invalidPage=await post('project-options',{limit:201});assert.equal(invalidPage.statusCode,400);
    const missing=await post('not-a-query');assert.equal(missing.statusCode,404);
    store.run("UPDATE threads SET title='Updated title' WHERE id='t0'");
    const renamed=await post('overview',{project:'session:t0'});assert.equal(renamed.json().meta.projectLabels[0].name,'Updated title');
    store.run("UPDATE collector_projects SET value=json_set(value,'$.kind','app','$.name','Assigned project') WHERE id='s0'");
    const changed=await post('scope-summary');assert.equal(changed.json().data.projectlessChatCount,2099);assert.equal(changed.json().data.projectCount,2);
    const empty=await post('scope-summary',{model:'missing'});assert.deepEqual(empty.json().data,{firstAt:null,lastAt:null,projectCount:0,projectlessChatCount:0,unresolvedChatCount:0});
  } finally {await app.close();}
});
