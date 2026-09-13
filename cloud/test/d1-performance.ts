/** Test-only binding instrumentation; setup and correctness reads use the original DB. */
export function instrumentD1(base:D1Database) {
  const stats={calls:0,statements:0,binding_bytes:0,response_bytes:0,rows_read:0,rows_written:0};
  const trace:{sql:string;binding_bytes:number;response_bytes:number;rows_read:number;rows_written:number}[]=[];
  const encoder=new TextEncoder();
  type Prepared={statement:D1PreparedStatement;sql:string;bytes:number};
  const originals=new WeakMap<object,Prepared>();
  const bytes=(args:unknown[])=>args.reduce<number>((total,arg)=>total+(typeof arg==='string'?encoder.encode(arg).byteLength:arg instanceof ArrayBuffer?arg.byteLength:ArrayBuffer.isView(arg)?arg.byteLength:encoder.encode(String(arg)).byteLength),0);
  const add=(p:Prepared,result:D1Result)=>{
    stats.statements++;stats.binding_bytes+=p.bytes;
    const response_bytes=encoder.encode(JSON.stringify(result.results)).byteLength;stats.response_bytes+=response_bytes;
    stats.rows_read+=result.meta.rows_read||0;stats.rows_written+=result.meta.rows_written||0;
    trace.push({sql:p.sql,binding_bytes:p.bytes,response_bytes,rows_read:result.meta.rows_read||0,rows_written:result.meta.rows_written||0});
  };
  const wrap=(p:Prepared):D1PreparedStatement=>{
    const proxy=new Proxy(p.statement,{get(target,key){
      if(key==='bind')return (...args:unknown[])=>wrap({...p,statement:target.bind(...args),bytes:bytes(args)});
      if(key==='first')return async(column?:string)=>{stats.calls++;const result=await target.all();add(p,result);return column?result.results[0]?.[column]??null:result.results[0]??null;};
      if(key==='all'||key==='run')return async()=>{stats.calls++;const result=await target.all();add(p,result);return result;};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});originals.set(proxy,p);return proxy;
  };
  const db=new Proxy(base,{get(target,key){
    if(key==='prepare')return (sql:string)=>wrap({statement:target.prepare(sql),sql,bytes:0});
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{
      const prepared=statements.map(s=>{const p=originals.get(s);if(!p)throw Error('uninstrumented D1 statement');return p;});
      stats.calls++;const result=await target.batch(prepared.map(p=>p.statement));
      result.forEach((r,i)=>add(prepared[i],r));return result;
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  return {db,stats,trace};
}
