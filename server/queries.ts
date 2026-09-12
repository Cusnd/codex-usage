import type { Store } from './db.js';
import { QueryEngine, queryStore, type Statement, type QueryResult } from '../shared/query-engine.js';
export { where } from '../shared/query-engine.js';
export class Queries {
 constructor(private store: Pick<Store, 'all' | 'one' | 'settings'> & Partial<Pick<Store, 'readSnapshot'>>) {}
 private run<G extends Generator<Statement, any, any>>(query: G): QueryResult<G> {
  const execute = () => {
   let next = query.next();
   while (!next.done) { const {sql, params, one} = next.value; next = query.next(one ? this.store.one(sql, params) : this.store.all(sql, params)); }
   return next.value;
  };
  return this.store.readSnapshot ? this.store.readSnapshot(execute) : execute();
 }
 summary(...args: Parameters<QueryEngine['summary']>): QueryResult<ReturnType<QueryEngine['summary']>> { return this.run(new QueryEngine(queryStore(this.store.settings())).summary(...args)); }
 trend(...args: Parameters<QueryEngine['trend']>): QueryResult<ReturnType<QueryEngine['trend']>> { return this.run(new QueryEngine(queryStore(this.store.settings())).trend(...args)); }
 groups(...args: Parameters<QueryEngine['groups']>): QueryResult<ReturnType<QueryEngine['groups']>> { return this.run(new QueryEngine(queryStore(this.store.settings())).groups(...args)); }
 breakdown(...args: Parameters<QueryEngine['breakdown']>): QueryResult<ReturnType<QueryEngine['breakdown']>> { return this.run(new QueryEngine(queryStore(this.store.settings())).breakdown(...args)); }
 threads(...args: Parameters<QueryEngine['threads']>): QueryResult<ReturnType<QueryEngine['threads']>> { return this.run(new QueryEngine(queryStore(this.store.settings())).threads(...args)); }
 detail(...args: Parameters<QueryEngine['detail']>): QueryResult<ReturnType<QueryEngine['detail']>> { return this.run(new QueryEngine(queryStore(this.store.settings())).detail(...args)); }
 agents(...args: Parameters<QueryEngine['agents']>): QueryResult<ReturnType<QueryEngine['agents']>> { return this.run(new QueryEngine(queryStore(this.store.settings())).agents(...args)); }
 turns(...args: Parameters<QueryEngine['turns']>): QueryResult<ReturnType<QueryEngine['turns']>> { return this.run(new QueryEngine(queryStore(this.store.settings())).turns(...args)); }
 allTurns(...args: Parameters<QueryEngine['allTurns']>): QueryResult<ReturnType<QueryEngine['allTurns']>> { return this.run(new QueryEngine(queryStore(this.store.settings())).allTurns(...args)); }
 filters(...args: Parameters<QueryEngine['filters']>): QueryResult<ReturnType<QueryEngine['filters']>> { return this.run(new QueryEngine(queryStore(this.store.settings())).filters(...args)); }
 compare(...args: Parameters<QueryEngine['compare']>): QueryResult<ReturnType<QueryEngine['compare']>> { return this.run(new QueryEngine(queryStore(this.store.settings())).compare(...args)); }
}
