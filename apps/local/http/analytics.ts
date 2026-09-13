import { Type, type TSchema } from '@sinclair/typebox';
import * as C from '../../../modules/contracts/index.js';
import { type LocalHttpContext } from './context.js';
import { localProjectLabels, localProjectOptions, localResponseProjectIds } from '../../../modules/collection/analytics.js';

type Params = Record<string, any>;
type Definition = { route:string; query:TSchema; response:TSchema; read:(q:Params,id:string|undefined,method:'GET'|'POST')=>unknown };

export function registerAnalyticsRoutes(context: LocalHttpContext) {
  const {app,store,queries,wrap,schema,normalize}=context;
  const definitions:Definition[]=[];
  const read=(definition:Definition,q:Params,id?:string,method:'GET'|'POST'='GET')=>store.readSnapshot(()=>{
    const data=definition.read(q,id,method),response=wrap(data);
    const ids=localResponseProjectIds(definition.route,data,q.project,q.groupBy);
    return {...response,meta:{...response.meta,projectLabels:localProjectLabels(store,ids)}};
  });
  const define=(route:string,response:TSchema,query:TSchema,resolve:Definition['read'])=>{
    const definition={route,response,query,read:resolve};definitions.push(definition);
    app.get<{Querystring:Params;Params:{id?:string}}>('/api/local/'+route,{
      schema:{...schema(response,query),...(route.includes(':id')?{params:Type.Object({id:Type.String()})}:{})},
    },async req=>read(definition,req.query,req.params.id));
  };
  const empty=Type.Object({});
  const trend=Type.Object({...C.FilterSchema.properties,bucket:Type.Optional(C.TrendBucketSchema)});
  const group=Type.Object({...C.FilterSchema.properties,...C.Pagination,groupBy:C.GroupSchema});
  const search=Type.Optional(Type.String({maxLength:300}));
  const sort=Type.Optional(Type.Union([Type.Literal('tokens'),Type.Literal('recent')]));
  const turnSort=Type.Optional(Type.Union([Type.Literal('tokens'),Type.Literal('recent'),Type.Literal('oldest')]));
  const thread=Type.Object({...C.FilterSchema.properties,...C.Pagination,q:search,sort,cacheBelow:Type.Optional(Type.Number({minimum:0,maximum:1}))});
  const turn=Type.Object({...C.FilterSchema.properties,...C.Pagination,q:search,sort:turnSort,turnId:Type.Optional(Type.String()),missingTurn:Type.Optional(Type.Boolean())});
  const comparison=Type.Object({...C.FilterSchema.properties,groupBy:Type.Optional(Type.Union([C.GroupSchema,Type.Literal('thread')])),baselineFrom:Type.Optional(Type.String({format:'date-time'})),baselineTo:Type.Optional(Type.String({format:'date-time'}))});
  const found=(data:unknown)=>{if(!data)throw Object.assign(new Error('没有找到该任务。'),{statusCode:404});return data;};
  define('project-labels',Type.Array(C.ProjectLabelSchema),Type.Object({ids:Type.Optional(Type.Array(Type.String(),{maxItems:5000}))}),q=>localProjectLabels(store,q.ids??[]));
  define('project-options',C.PageSchema(C.ProjectLabelSchema),Type.Object({...C.FilterSchema.properties,...C.Pagination,q:search}),q=>localProjectOptions(store,normalize(q),q.q??'',q.limit??50,q.offset??0));
  define('scope',C.ScopeSchema,C.FilterSchema,q=>queries.scope(normalize(q)));
  define('scope-summary',C.CompactUsageScopeSchema,C.FilterSchema,q=>queries.scopeSummary(normalize(q)));
  define('overview',C.OverviewSchema,C.OverviewFilterSchema,q=>queries.overview(normalize(q),q.bucket??'auto'));
  define('summary',C.MetricsSchema,C.FilterSchema,q=>queries.summary(normalize(q)));
  define('filters',C.FiltersSchema,C.FilterSchema,(q,_id,method)=>queries.filters(normalize(q),{projects:method==='GET'}));
  define('trend',Type.Array(C.TrendRowSchema),trend,q=>queries.trend(normalize(q),q.bucket??'day'));
  define('breakdown',C.PageSchema(C.GroupRowSchema),group,q=>queries.breakdown(normalize(q),q.groupBy,q.limit??50,q.offset??0));
  define('threads',C.PageSchema(C.ThreadRowSchema),thread,q=>queries.threads(normalize(q),q.limit??50,q.offset??0,q.sort,q.cacheBelow,q.q));
  define('threads/:id/agents',C.AgentUsageSchema,C.FilterSchema,(q,id)=>found(queries.agents(id!,normalize(q))));
  define('threads/:id',C.ThreadDetailSchema,empty,(_q,id)=>found(queries.detail(id!)));
  define('threads/:id/turns',C.PageSchema(C.TurnRowSchema),turn,(q,id)=>queries.turns(id!,normalize(q),q.limit??50,q.offset??0,q.sort));
  define('turns',C.PageSchema(C.TurnRowSchema),turn,q=>queries.allTurns({...normalize(q),turnId:q.missingTurn?null:q.turnId},q.limit??50,q.offset??0,q.sort,q.q));
  define('compare',C.CompareSchema,comparison,q=>{
    normalize({from:q.baselineFrom,to:q.baselineTo});
    if(!!q.baselineFrom!==!!q.baselineTo)throw Object.assign(new Error('基准开始与结束时间需要同时提供。'),{statusCode:400});
    return queries.compare(normalize(q),q.groupBy??'project',q.baselineFrom,q.baselineTo);
  });
  // The route stays bounded; all filters and selected identities live in JSON.
  app.post<{Querystring:{route:string};Body:Params}>('/api/local/query',{
    schema:schema(Type.Unknown(),Type.Object({route:Type.String({minLength:1,maxLength:1024})}),Type.Object({})),
  },async req=>{
    const requested=req.query.route;
    let id:string|undefined;
    const definition=definitions.find(candidate=>{
      if(!candidate.route.includes(':id'))return candidate.route===requested;
      const [prefix,suffix]=candidate.route.split(':id');
      if(!requested.startsWith(prefix)||!requested.endsWith(suffix))return false;
      const encoded=requested.slice(prefix.length,suffix.length?-suffix.length:undefined);
      if(!encoded||encoded.includes('/'))return false;
      try{id=decodeURIComponent(encoded);}catch{return false;}
      return true;
    });
    if(!definition)throw Object.assign(new Error('接口不存在。'),{statusCode:404});
    if(!req.compileValidationSchema(definition.query,'body')(req.body))throw Object.assign(new Error('请求参数无效，请检查日期、筛选或分页。'),{statusCode:400,validation:true});
    return read(definition,req.body,id,'POST');
  });
}
