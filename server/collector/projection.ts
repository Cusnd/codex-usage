import {createHash} from 'node:crypto';
import {projectRecord} from '../../shared/usage-domain/normalize.js';
export const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
// Every unsafe integer literal has at least 16 decimal digits. The conservative
// probe may also match quoted text, which only takes the slower exact path.
// Exponents/fractions retain the existing parser's validation semantics.
const mayContainUnsafeInteger=/\d{16}/;
const exactInteger=(_key:string,value:unknown,context?:{source?:string})=>
  typeof value==='number'&&!Number.isSafeInteger(value)&&context?.source&&/^-?\d+$/.test(context.source)?context.source:value;
export function projectLine(text:string,kind:'session'|'titles'='session') {
  const value=mayContainUnsafeInteger.test(text)?JSON.parse(text,exactInteger):JSON.parse(text);
  return projectRecord(value,kind);
}
export const EMPTY_CHAIN='0'.repeat(64);
export const nextChain=(previous:string,line:Uint8Array)=>sha256(Buffer.concat([Buffer.from(previous,'hex'),Buffer.from(sha256(line),'hex')]));
