import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ApiResponse} from '../modules/contracts/responses.js';
import type {UsageDataSource} from '../modules/contracts/data-source.js';
import {createWebRuntime,WebRuntimeProvider,useApi,useWebRuntime} from '../modules/web/runtime/context.js';
import {dataQuery} from '../modules/web/data/data-query.js';

class Source implements UsageDataSource {
  readonly mode='local' as const;
  constructor(readonly id:string,readonly time:number){}
  revision(){return this.id;}
  capture(){return undefined;}
  clock=()=>this.time;
  projectName=(id:string)=>this.id+':'+id;
  async query<T>(_route:string,params:Record<string,unknown>={}):Promise<ApiResponse<T>> {
    return {data:{source:this.id,params} as T,meta:{source:'local',updatedAt:null,timezone:'UTC',warnings:[]}};
  }
  async mutate<T>():Promise<ApiResponse<T>>{return this.query<T>('mutation');}
}
test('two rendered workspaces keep their own source, clock and project labels, including callbacks used later',async()=>{
  const a=new Source('alice',1000),b=new Source('bob',2000),callbacks:ReturnType<typeof useApi>['api'][]=[];
  function Probe(){const runtime=useWebRuntime(),{api}=useApi();callbacks.push(api);return createElement('p',null,`${runtime.projectName('project')}@${runtime.clock()}`);}
  const markup=renderToStaticMarkup(createElement('main',null,...[a,b].map(source=>createElement(WebRuntimeProvider,{key:source.id,runtime:createWebRuntime(source,{deviceScope:true}),children:createElement(Probe)}))));
  assert.match(markup,/alice:project@1000/);assert.match(markup,/bob:project@2000/);
  assert.equal((await callbacks[1]<{source:string}>('local/summary')).data.source,'bob');
  assert.equal((await callbacks[0]<{source:string}>('local/summary')).data.source,'alice');
});
test('a pending query retains the adapter and rolling clock captured by its originating workspace',async()=>{
  const a=new Source('alice',Date.parse('2026-09-12T10:00:00Z')),b=new Source('bob',Date.parse('2026-09-12T11:00:00Z'));
  const params={from:'2026-09-01T00:00:00Z',to:'2026-09-12T09:00:00Z'};
  const qa=dataQuery<{source:string;params:{to:string}}>('local/summary',params,'UTC',true,a);
  const qb=dataQuery<{source:string;params:{to:string}}>('local/summary',params,'UTC',true,b);
  const signal=new AbortController().signal;
  const [rb,ra]=await Promise.all([qb.queryFn({signal}),qa.queryFn({signal})]);
  assert.equal(ra.data.source,'alice');assert.equal(ra.data.params.to,'2026-09-12T10:00:00.000Z');
  assert.equal(rb.data.source,'bob');assert.equal(rb.data.params.to,'2026-09-12T11:00:00.000Z');
});
