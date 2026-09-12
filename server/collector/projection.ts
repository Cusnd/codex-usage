import {createHash} from 'node:crypto';
import {projectRecord} from '../../shared/usage-domain/normalize.js';
export const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function projectLine(text:string,kind:'session'|'titles'='session') {
  const value=JSON.parse(text,(_key,value,context?:{source?:string})=>
    typeof value==='number'&&!Number.isSafeInteger(value)&&context?.source&&/^-?\d+$/.test(context.source)?context.source:value);
  return projectRecord(value,kind);
}
export const EMPTY_CHAIN='0'.repeat(64);
export const nextChain=(previous:string,line:Uint8Array)=>sha256(Buffer.concat([Buffer.from(previous,'hex'),Buffer.from(sha256(line),'hex')]));
