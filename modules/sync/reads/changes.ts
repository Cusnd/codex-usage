import { stableJson, type ChangesPage } from "../../contracts/sync.js";
import { fail } from "../../platform/worker/http.js";
import { domain, cutOf } from "../publication/store.js";
import { getRead } from './leases.js';
import { type Version, leaseCut } from './model.js';

export async function changes(db:D1Database,user:string,epoch:string,after:number,limit=20,leaseId?:string):Promise<ChangesPage> {
  if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)fail(400,'INVALID_CURSOR','变化游标无效。');
  const h=await domain(db,user);if(h.active_epoch!==epoch||after<h.changes_floor||after>h.commit_seq||h.mode==='deleting')fail(409,'BASELINE_REQUIRED','需要新的完整同步基线。');if(h.mode==='rebuilding')fail(409,'DATASET_UPDATING','历史基线正在后台构建。');
  const lease=leaseId?await getRead(db,user,leaseId):null;if(lease&&lease.epoch!==epoch)fail(409,'BASELINE_REQUIRED','读取版本已变化。');const target=lease?.cut??h.commit_seq;if(after>target)fail(400,'INVALID_CURSOR','变化游标超出固定版本。');
  const commits=await db.prepare('SELECT commit_seq,entity_count FROM v3_commits WHERE user_id=? AND epoch=? AND commit_seq>? AND commit_seq<=? ORDER BY commit_seq LIMIT ?').bind(user,epoch,after,target,limit).all<{commit_seq:number;entity_count:number}>();
  let count=0;const selected:typeof commits.results=[];for(const c of commits.results){if(count&&count+c.entity_count>1000)break;count+=c.entity_count;selected.push(c);}
  const sequences=selected.map(r=>r.commit_seq),rows=sequences.length?await db.prepare('SELECT * FROM v3_changes WHERE user_id=? AND epoch=? AND commit_seq IN(SELECT value FROM json_each(?)) ORDER BY commit_seq,kind,entity_id').bind(user,epoch,stableJson(sequences)).all<Version&{commit_seq:number}>():{results:[]};
  const current=await domain(db,user);if(current.deletion_version!==h.deletion_version||current.active_epoch!==h.active_epoch||current.mode==='deleting')fail(409,'BASELINE_REQUIRED','读取版本已失效。');
  const output=selected.map(c=>{const group=rows.results.filter(r=>r.commit_seq===c.commit_seq);if(group.length!==c.entity_count)fail(409,'BASELINE_REQUIRED','变化记录不完整。');return {commit_seq:c.commit_seq,entity_count:c.entity_count,complete:true,entities:group.filter(r=>r.payload!==null).map(r=>({kind:r.kind,id:r.entity_id,revision:r.revision,hash:r.hash,value:JSON.parse(r.payload!)})),deleted:group.filter(r=>r.payload===null).map(r=>({kind:r.kind,id:r.entity_id}))};});
  const next=sequences.at(-1)??after;return {cut:lease?leaseCut(lease):cutOf(h),commits:output,next_cursor:next,more:next<target};
}
