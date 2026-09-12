import { stableJson } from '../../../shared/sync-v3';
import type { CanonicalEvent } from '../../../shared/usage-domain/types';
import { chunks } from './store';

export type UserAssignment=NonNullable<CanonicalEvent['user_assignment']>;
export const effectiveOrigin=(event:CanonicalEvent|null|undefined)=>event?.origin_device_id??event?.user_assignment?.device_id??null;
export function withAssignment(event:CanonicalEvent|null,rule:UserAssignment|null):CanonicalEvent|null {
  if(!event)return null;
  const {user_assignment:_,...natural}=event;
  return !natural.origin_device_id&&!natural.origin_conflict&&rule?{...natural,user_assignment:rule}:natural;
}
/** Latest completed choice wins, including an explicit revoke or a deleted target. */
export async function assignmentRules(db:D1Database,user:string,ids:string[]):Promise<Map<string,UserAssignment|null>> {
  const out=new Map<string,UserAssignment|null>();
  for(const group of chunks(ids)){
    const rows=(await db.prepare(`SELECT j.value event_id,o.operation_id,o.action,o.device_id,d.history_deleted_at,d.id target
      FROM json_each(?) j LEFT JOIN v3_origin_operation_events e ON e.rowid=(SELECT r.rowid FROM v3_origin_operation_events r JOIN v3_origin_operations p ON p.user_id=r.user_id AND p.operation_id=r.operation_id WHERE r.user_id=? AND r.event_id=j.value AND p.status='complete' ORDER BY r.operation_serial DESC LIMIT 1)
      LEFT JOIN v3_origin_operations o ON o.user_id=e.user_id AND o.operation_id=e.operation_id LEFT JOIN devices d ON d.user_id=o.user_id AND d.id=o.device_id`).bind(stableJson(group),user).all<{event_id:string;operation_id:string|null;action:string|null;device_id:string|null;history_deleted_at:number|null;target:string|null}>()).results;
    for(const r of rows)out.set(r.event_id,r.action==='assign'&&r.target&&r.history_deleted_at===null?{operation_id:r.operation_id!,device_id:r.device_id!,label:'用户指定'}:null);
  }
  return out;
}
