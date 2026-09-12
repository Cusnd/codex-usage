import { stableJson } from "./stable-json.js";

/** Bound UTF-8 JSON bytes, including non-ASCII names. A batch can use multiple such statements. */
export function chunks<T>(rows:T[],limit=350_000):T[][] {
  const result:T[][]=[];let list:T[]=[],bytes=2;
  for(const row of rows){const n=new TextEncoder().encode(stableJson(row)).byteLength+1;if(n>1_500_000)throw Error('ROW_TOO_LARGE');if(list.length&&bytes+n>limit){result.push(list);list=[];bytes=2;}list.push(row);bytes+=n;}
  if(list.length)result.push(list);return result;
}
