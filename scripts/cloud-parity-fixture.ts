import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../modules/storage/sqlite.js';
import { Queries } from '../modules/analytics/sqlite.js';
import { officialPrices } from '../modules/settings/pricing.js';
import type { SyncEvent, SyncThread } from '../modules/contracts/cloud-accounts.js';

const thread=(id:string,parent:string|null=null):SyncThread=>({id,title:'任务 '+id,titleUpdatedAt:null,project:'/home/person/project',source:'cli',parentId:parent,subagentParentId:parent,forkedFromId:null});
const event=(id:string,tid='root',tokens='100'):SyncEvent=>({event_key:'response:'+id,thread_id:tid,turn_id:'turn-'+id,response_id:id,
  at:'2026-11-01T05:30:00.000Z',project:'/home/person/project',model:'gpt-6-astra',effort:'high',kind:'record',incomplete:0,
  input_tokens:tokens,cached_input_tokens:'10',cache_write_input_tokens:'0',output_tokens:'20',reasoning_output_tokens:'5',total_tokens:(BigInt(tokens)+20n).toString()});
const common=event('big','root','9007199254740993');
const a={threads:[thread('root'),thread('child','root'),thread('empty'),{...thread('fork'),parentId:'root',forkedFromId:'root'}],events:[common,event('child','child'),event('fork-new','fork'),
  {...event('old-format'),event_key:'legacy:mirror',turn_id:'turn-canonical',response_id:null,kind:'legacy' as const},...Array.from({length:205},(_,i)=>event('a'+i))]};
const b={threads:[thread('root'),thread('child','root'),thread('other')],events:[common,event('canonical','root','150'),{...event('b'),at:'2026-11-01T06:30:00.000Z'}, {...event('other','other'),project:null,model:null,effort:null,turn_id:null,cached_input_tokens:null,cache_write_input_tokens:null,incomplete:1 as const}]};
const settings={localInterval:0,accountInterval:0,timezone:'America/New_York',timezoneMode:'manual' as const,costEnabled:true,modelPrices:officialPrices};
const filter={from:'2026-11-01T04:00:00.000Z',to:'2026-11-02T05:00:00.000Z'};
const cases=[['local/summary',{},'summary',[{}]],['local/trend',{...filter,bucket:'hour'},'trend',[filter,'hour']],
  ['local/trend',{...filter,bucket:'day'},'trend',[filter,'day']],['local/filters',{},'filters',[{}]],
  ['local/threads',{limit:200},'threads',[{},200,0]],['local/turns',{limit:200},'allTurns',[{},200,0]],
  ['local/threads/root',{},'detail',['root']],['local/threads/root/agents',{},'agents',['root',{}]],
  ['local/breakdown',{groupBy:'model'},'breakdown',[{},'model',50,0]],
  ['local/compare',{...filter,groupBy:'project'},'compare',[filter,'project']],
  ['local/summary',{unknown:'project'},'summary',[{unknown:'project'}]],
] as const;
const expected=[];
for(const selection of [['A'],['B'],['A','B']] as const){
 const store=new Store(':memory:');store.saveSettings(settings);
 for(const name of selection){const data=name==='A'?a:b;
  for(const t of data.threads)store.run('INSERT OR REPLACE INTO threads(id,title,project,source,parent_id,subagent_parent_id,forked_from_id) VALUES(?,?,?,?,?,?,?)',[t.id,t.title,t.project,t.source,t.parentId,t.subagentParentId,t.forkedFromId]);
  for(const e of data.events){const cols=Object.keys(e);store.run(`INSERT INTO usage_events(file,${cols.join(',')}) VALUES(?,${cols.map(()=>'?').join(',')})`,[name,...cols.map(k=>k.endsWith('_tokens')&&e[k as keyof SyncEvent]!==null?BigInt(e[k as keyof SyncEvent]!):e[k as keyof SyncEvent])]);}
 }
 store.reconcile();const queries=new Queries(store);
 expected.push({selection,cases:cases.map(([route,params,method,args])=>({route,params,data:(queries[method] as (...a:any[])=>unknown)(...args)}))});store.close();
}
mkdirSync('cloud/.generated',{recursive:true});writeFileSync('cloud/.generated/parity.json',JSON.stringify({devices:{A:a,B:b},settings,expected}));
