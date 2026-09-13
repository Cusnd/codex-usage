// Executable protocol model, not a production client/server implementation.
// Maps are cloned to model transactions; this is intentionally not a performance test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checks=[];
const check=(name,fn)=>{const details=fn();checks.push({name,passed:true,...details});};
const event=(id,revision,total,origin)=>({id,revision,value:{total_tokens:String(total),origin_device_id:origin,cached_input_tokens:null}});
const deleted=(id,revision)=>({id,revision,value:null});
const tx=(seq,ops)=>({seq,ops});
const permutations=list=>list.length?list.flatMap((item,i)=>permutations(list.filter((_,j)=>j!==i)).map(rest=>[item,...rest])):[[]];

class CacheModel {
  rows=new Map();pending=new Map();acceptedHashes=new Map();cursor=0;
  applyTo(rows,op) {
    const old=rows.get(op.id);
    if(old && old.revision>op.revision)return;
    if(old && old.revision===op.revision){assert.deepEqual(old,op,'same entity revision with different data');return;}
    rows.set(op.id,structuredClone(op)); // Keep tombstones and their revisions.
  }
  snapshot(ops) {const next=structuredClone(this.rows);for(const op of ops)this.applyTo(next,op);this.rows=next;}
  receive(transaction,{failAfterOperation=-1}={}) {
    const digest=hash(transaction),seen=this.acceptedHashes.get(transaction.seq);
    if(seen){assert.equal(seen,digest,'same commit identity with different bytes');return;}
    const queued=this.pending.get(transaction.seq);
    if(queued)assert.deepEqual(queued,transaction,'queued identity conflict');
    this.pending.set(transaction.seq,structuredClone(transaction));
    while(this.pending.has(this.cursor+1)) {
      const current=this.pending.get(this.cursor+1),next=structuredClone(this.rows);
      current.ops.forEach((op,i)=>{this.applyTo(next,op);if(i===failAfterOperation)throw new Error('simulated transaction abort');});
      this.rows=next;this.cursor=current.seq;
      this.acceptedHashes.set(current.seq,hash(current));this.pending.delete(current.seq);
    }
  }
  summary() {
    let sum=0n;const machines=new Map();let count=0;
    for(const row of this.rows.values())if(row.value){
      count++;const value=BigInt(row.value.total_tokens),machine=row.value.origin_device_id??'unknown';sum+=value;
      machines.set(machine,(machines.get(machine)||0n)+value);
    }
    return {count,total:sum.toString(),machines:Object.fromEntries([...machines].sort().map(([key,value])=>[key,value.toString()]))};
  }
  export() {return {rows:[...this.rows],pending:[...this.pending],acceptedHashes:[...this.acceptedHashes],cursor:this.cursor};}
  static restore(data) {const c=new CacheModel();c.rows=new Map(data.rows);c.pending=new Map(data.pending);c.acceptedHashes=new Map(data.acceptedHashes);c.cursor=data.cursor;return c;}
}

check('ordered application despite arbitrary download order and duplicate delivery',()=>{
  const transactions=[tx(1,[event('a',1,100,'A'),event('b',1,20,'B')]),tx(2,[event('a',2,110,'A')]),tx(3,[deleted('b',2)]),tx(4,[event('large',1,'9007199254740993',null)])];
  let count=0;
  for(const order of permutations(transactions)) {
    let c=new CacheModel();
    for(const t of order){c.receive(t);c=CacheModel.restore(JSON.parse(JSON.stringify(c.export())));c.receive(t);}
    assert.equal(c.cursor,4);assert.deepEqual(c.summary(),{count:2,total:'9007199254741103',machines:{A:'110',unknown:'9007199254740993'}});count++;
  }
  return {permutations:count,restart_after_each_delivery:true};
});
check('a missing commit prevents the full cursor from advancing',()=>{
  const c=new CacheModel();c.receive(tx(2,[event('b',1,20,'B')]));assert.equal(c.cursor,0);assert.equal(c.summary().count,0);
  c.receive(tx(1,[event('a',1,100,'A')]));assert.equal(c.cursor,2);assert.equal(c.summary().total,'120');
});
check('tombstone and newer recent data survive a late baseline block',()=>{
  const c=new CacheModel();c.snapshot([event('a',3,130,'A'),deleted('b',2)]);
  c.snapshot([event('a',1,100,'A'),event('b',1,20,'B')]);
  assert.deepEqual(c.summary(),{count:1,total:'130',machines:{A:'130'}});
  c.receive(tx(1,[event('a',2,110,'A')]));assert.equal(c.summary().total,'130');
});
check('identity consolidation is one atomic change group',()=>{
  const c=new CacheModel();c.snapshot([event('provisional-a',1,100,null),event('provisional-b',1,100,null)]);
  const merge=tx(1,[deleted('provisional-a',2),deleted('provisional-b',2),event('canonical-response',1,100,'A')]);
  assert.throws(()=>c.receive(merge,{failAfterOperation:0}),/simulated transaction abort/);
  assert.equal(c.cursor,0);assert.equal(c.summary().total,'200');
  c.receive(merge);assert.equal(c.cursor,1);assert.deepEqual(c.summary(),{count:1,total:'100',machines:{A:'100'}});
});
check('same commit or entity revision with different content is rejected',()=>{
  const c=new CacheModel();c.receive(tx(1,[event('a',1,100,'A')]));
  assert.throws(()=>c.receive(tx(1,[event('a',1,200,'A')])),/different bytes/);
  assert.throws(()=>c.receive(tx(2,[event('a',1,200,'A')])),/different data/);
  assert.equal(c.cursor,1);assert.equal(c.summary().total,'100');
});
check('record, pending change and parser cursor commit or abort together',()=>{
  let state={cursor:0,events:new Map(),changes:[],pending:new Map()};
  const ingest=(failAt)=>{
    const next=structuredClone(state);
    next.events.set('a',event('a',1,100,'A'));if(failAt===0)throw new Error('abort');
    next.changes.push({seq:1,id:'a',value:next.events.get('a')});next.pending.set('a',1);if(failAt===1)throw new Error('abort');
    next.cursor=512;if(failAt===2)throw new Error('abort');state=next;
  };
  for(const stage of [0,1,2]){assert.throws(()=>ingest(stage),/abort/);assert.equal(state.cursor,0);assert.equal(state.events.size,0);assert.equal(state.pending.size,0);}
  ingest(-1);assert.equal(state.cursor,512);assert.equal(state.events.size,1);assert.equal(state.pending.get('a'),1);
});
check('sealing an old revision does not erase a newer pending revision',()=>{
  const pending=new Map([['a',1]]),claimed={id:'a',seq:1,value:event('a',1,100,'A')};
  pending.set('a',2); // A newer revision arrives after extraction and before seal.
  const immutableBytes=JSON.stringify(claimed),outbox=[immutableBytes];
  if(pending.get(claimed.id)===claimed.seq)pending.delete(claimed.id);
  assert.equal(pending.get('a'),2);assert.equal(outbox[0],immutableBytes);
  const restarted=JSON.parse(JSON.stringify(outbox));assert.equal(hash(restarted[0]),hash(immutableBytes));
});
check('live and history acknowledgement frontiers are independent',()=>{
  const state={live:{head:0,seen:new Set()},backfill:{head:0,seen:new Set()}};
  const accept=(lane,seq)=>{const s=state[lane];s.seen.add(seq);while(s.seen.has(s.head+1)){s.head++;s.seen.delete(s.head);}};
  accept('backfill',2);accept('live',1);assert.equal(state.live.head,1);assert.equal(state.backfill.head,0);
  accept('backfill',1);assert.equal(state.backfill.head,2);
});
check('turn membership expansion handles explicit arrival and withdrawal',()=>{
  const records=new Map([['legacy',{turn:'T',kind:'legacy',tokens:100}]]);
  const effective=()=>{const turns=new Set([...records.values()].filter(r=>r.kind==='record').map(r=>r.turn));return [...records.values()].filter(r=>r.kind==='record'||!turns.has(r.turn)).reduce((sum,r)=>sum+r.tokens,0);};
  assert.equal(effective(),100);records.set('response',{turn:'T',kind:'record',tokens:110});assert.equal(effective(),110);
  records.delete('response');assert.equal(effective(),100);
});
console.log(JSON.stringify({experiment:'sync protocol state-transition model',node:process.version,measured_at:new Date().toISOString(),checks,
  limitations:[
    'In-memory state model only; does not validate operating-system crashes, database durability or network transport.',
    'Uses already assigned canonical identities and revisions; does not prove provenance discovery or fuzzy matching correctness.',
    'Full feed modeled with dense per-dataset commit sequence; a sparse storage sequence needs explicit scanned-through and predecessor coverage.',
    'Cloning maps models an atomic transaction and is not the proposed production data structure or performance algorithm.',
  ]},null,2));
