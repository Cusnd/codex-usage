/** Wall-clock phase diagnostics only. They do not change persistence or acknowledgement boundaries. */
export class SyncTiming {
  private elapsed=new Map<string,number>();
  private counters=new Map<string,number>();
  async measure<T>(name:string,work:()=>Promise<T>):Promise<T>{const started=Date.now();try{return await work();}finally{this.elapsed.set(name,(this.elapsed.get(name)||0)+Date.now()-started);}}
  count(name:string){this.counters.set(name,(this.counters.get(name)||0)+1);}
  header():string{return [...this.elapsed].map(([key,value])=>`v3_${key};dur=${Math.max(0,value)}`).concat([...this.counters].map(([key,value])=>`v3_${key};desc="${value}"`)).join(', ');}
}
export function measured<T>(timing:SyncTiming|undefined,name:string,work:()=>Promise<T>):Promise<T>{return timing?timing.measure(name,work):work();}
