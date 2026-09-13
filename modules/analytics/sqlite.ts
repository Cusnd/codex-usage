import type { Settings } from '../contracts/settings.js';
import type { QueryFilter } from './filter.js';
import type { QueryEngineOptions, SQLInputValue } from './plan.js';
import { QueryEngine, queryStore, type Statement, type QueryResult } from './query-engine.js';
export { where } from './query-engine.js';

export type QueryOperation = 'summary' | 'scope' | 'scopeSummary' | 'overview' | 'trend' | 'groups' | 'breakdown' | 'threads' | 'detail' | 'agents' | 'turns' | 'allTurns' | 'filters' | 'compare';
export interface SynchronousQueryExecutor {
  all(sql:string,params?:SQLInputValue[]):Record<string,any>[];
  one(sql:string,params?:SQLInputValue[]):Record<string,any>|undefined;
  settings():Settings;
  readSnapshot?<T>(read:()=>T):T;
  /** Select a safe runtime projection using the request, not generated SQL text. */
  forQuery?(filter:QueryFilter,operation:QueryOperation):SynchronousQueryExecutor;
}
export class Queries {
 constructor(private store: SynchronousQueryExecutor, private options: QueryEngineOptions = {}) {}
 private query<G extends Generator<Statement, any, any>>(operation: QueryOperation, filter: QueryFilter, create: (engine: QueryEngine) => G): QueryResult<G> {
  const store = this.store.forQuery?.(filter, operation) ?? this.store;
  const execute = () => {
   const query = create(new QueryEngine(queryStore(store.settings()), this.options));
   let next = query.next();
   while (!next.done) { const {sql, params, one} = next.value; next = query.next(one ? store.one(sql, params) : store.all(sql, params)); }
   return next.value;
  };
  return store.readSnapshot ? store.readSnapshot(execute) : execute();
 }
 summary(...args: Parameters<QueryEngine['summary']>): QueryResult<ReturnType<QueryEngine['summary']>> { return this.query('summary', args[0] ?? {}, engine => engine.summary(...args)); }
 scope(...args: Parameters<QueryEngine['scope']>): QueryResult<ReturnType<QueryEngine['scope']>> { return this.query('scope', args[0] ?? {}, engine => engine.scope(...args)); }
 scopeSummary(...args: Parameters<QueryEngine['scopeSummary']>): QueryResult<ReturnType<QueryEngine['scopeSummary']>> { return this.query('scopeSummary', args[0] ?? {}, engine => engine.scopeSummary(...args)); }
 overview(...args: Parameters<QueryEngine['overview']>): QueryResult<ReturnType<QueryEngine['overview']>> { return this.query('overview', args[0] ?? {}, engine => engine.overview(...args)); }
 trend(...args: Parameters<QueryEngine['trend']>): QueryResult<ReturnType<QueryEngine['trend']>> { return this.query('trend', args[0] ?? {}, engine => engine.trend(...args)); }
 groups(...args: Parameters<QueryEngine['groups']>): QueryResult<ReturnType<QueryEngine['groups']>> { return this.query('groups', args[0] ?? {}, engine => engine.groups(...args)); }
 breakdown(...args: Parameters<QueryEngine['breakdown']>): QueryResult<ReturnType<QueryEngine['breakdown']>> { return this.query('breakdown', args[0] ?? {}, engine => engine.breakdown(...args)); }
 threads(...args: Parameters<QueryEngine['threads']>): QueryResult<ReturnType<QueryEngine['threads']>> { return this.query('threads', args[0] ?? {}, engine => engine.threads(...args)); }
 detail(...args: Parameters<QueryEngine['detail']>): QueryResult<ReturnType<QueryEngine['detail']>> { return this.query('detail', {threadId:args[0]}, engine => engine.detail(...args)); }
 agents(...args: Parameters<QueryEngine['agents']>): QueryResult<ReturnType<QueryEngine['agents']>> { return this.query('agents', args[1] ?? {}, engine => engine.agents(...args)); }
 turns(...args: Parameters<QueryEngine['turns']>): QueryResult<ReturnType<QueryEngine['turns']>> { return this.query('turns', {...args[1],threadId:args[0]}, engine => engine.turns(...args)); }
 allTurns(...args: Parameters<QueryEngine['allTurns']>): QueryResult<ReturnType<QueryEngine['allTurns']>> { return this.query('allTurns', args[0] ?? {}, engine => engine.allTurns(...args)); }
 filters(...args: Parameters<QueryEngine['filters']>): QueryResult<ReturnType<QueryEngine['filters']>> { return this.query('filters', args[0] ?? {}, engine => engine.filters(...args)); }
 compare(...args: Parameters<QueryEngine['compare']>): QueryResult<ReturnType<QueryEngine['compare']>> { return this.query('compare', args[0] ?? {}, engine => engine.compare(...args)); }
}
