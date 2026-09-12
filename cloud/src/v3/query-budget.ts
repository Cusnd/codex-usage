/** Raised before issuing a query; an atomic batch is always admitted in full or not sent. */
export class QueryBudgetExhausted extends Error {
  constructor(readonly used:number,readonly requested:number,readonly limit:number) {
    super(`D1 query budget exhausted: ${used} + ${requested} > ${limit}`);
    this.name='QueryBudgetExhausted';
  }
}

/** Request-local accounting. Count SQL statements, including every statement in db.batch(). */
export function queryBudget(base:D1Database,maxQueries:number,reserveQueries=1) {
  if(!Number.isSafeInteger(maxQueries)||maxQueries<2)throw new RangeError('maxQueries must be an integer of at least 2');
  if(!Number.isSafeInteger(reserveQueries)||reserveQueries<1)throw new RangeError('reserveQueries must be a positive integer');
  const stats={queries:0,calls:0},originals=new WeakMap<object,D1PreparedStatement>();
  function charge(count:number,reserved:number){
    if(stats.queries+count>maxQueries-reserved)throw new QueryBudgetExhausted(stats.queries,count,maxQueries-reserved);
    stats.queries+=count;stats.calls++;
  }
  function database(reserved:number):D1Database {
    function statement(value:D1PreparedStatement):D1PreparedStatement {
      const proxy=new Proxy(value,{get(target,key){
        if(key==='bind')return (...args:unknown[])=>statement(target.bind(...args));
        if(key==='first'||key==='all'||key==='run'||key==='raw')return async(...args:unknown[])=>{
          charge(1,reserved);return (Reflect.get(target,key) as (...args:unknown[])=>unknown).apply(target,args);
        };
        const member=Reflect.get(target,key);return typeof member==='function'?member.bind(target):member;
      }});originals.set(proxy,value);return proxy;
    }
    return new Proxy(base,{get(target,key){
      if(key==='prepare')return (sql:string)=>statement(target.prepare(sql));
      if(key==='batch')return async(statements:D1PreparedStatement[])=>{
        charge(statements.length,reserved);return target.batch(statements.map(s=>originals.get(s)||s));
      };
      // Raw scripts cannot be counted safely without parsing SQL. Job work uses prepared statements.
      if(key==='exec'||key==='withSession')return ()=>{throw new Error('Budgeted job queries must use prepare()/batch()');};
      const member=Reflect.get(target,key);return typeof member==='function'?member.bind(target):member;
    }});
  }
  // The final query is reserved for releasing a claimed lease even when work cannot continue.
  return {db:database(Math.min(reserveQueries,maxQueries-1)),recoveryDb:database(1),releaseDb:database(0),stats};
}
